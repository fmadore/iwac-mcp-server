import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requestSignal } from "./request.js";

/** Identifies this process among any earlier one that had the same pid: in a
 * container the server is often pid 1 on every start. */
const BOOT_ID = randomUUID();

interface LockOwner {
  pid?: number;
  host?: string;
  boot?: string;
  started_at?: string;
}

async function readOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock's owner is certainly gone: it was taken on THIS host (a pid
 * means nothing across containers sharing a volume), and its process no
 * longer exists, or carries our pid but an earlier boot. Anything less certain
 * (no owner file yet, an older lock without host or boot, a pid now reused by
 * another process) counts as alive, so a live download is never stolen.
 */
export function ownerIsGone(owner: LockOwner | undefined): boolean {
  if (!owner || typeof owner.pid !== "number" || !owner.host || !owner.boot) return false;
  if (owner.host !== os.hostname()) return false;
  if (owner.pid === process.pid) return owner.boot !== BOOT_ID;
  return !processExists(owner.pid);
}

const sameOwner = (a: LockOwner | undefined, b: LockOwner): boolean =>
  a?.pid === b.pid && a?.boot === b.boot && a?.started_at === b.started_at;

/**
 * Move a dead owner's lock aside. The rename is atomic, so of several
 * processes reclaiming at once only one moves it; and if the directory moved
 * turns out to be a fresh lock taken in between, it is put back.
 */
async function reclaim(lock: string, stale: LockOwner): Promise<void> {
  const tomb = `${lock}.stale-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fs.rename(lock, tomb);
  } catch {
    return; // someone else moved it first, or it was released
  }
  if (!sameOwner(await readOwner(tomb), stale)) {
    await fs.rename(tomb, lock).catch(() => {});
    return;
  }
  console.error(`[iwac] reclaimed a cache lock left by stopped process ${stale.pid}: ${lock}`);
  await fs.rm(tomb, { recursive: true, force: true });
}

/** Cross-process exclusion. Never steal a lock based only on elapsed time:
 * a large download may still be alive. A lock whose owner process is gone
 * from this host (a hard kill, a crash) is reclaimed; any other busy lock
 * fails after 30 s and names the directory. Readers use committed files. */
export async function withCacheLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(directory, ".iwac-write-lock");
  const started = Date.now();
  while (true) {
    requestSignal()?.throwIfAborted();
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readOwner(lock);
      if (owner && ownerIsGone(owner)) {
        await reclaim(lock, owner);
        continue;
      }
      if (Date.now() - started > 30_000)
        throw new Error(
          `Cache writer lock is busy: ${lock}. Retry; if its owner has stopped, remove this lock directory.`,
        );
      await delay(100, undefined, { signal: requestSignal() });
    }
  }
  try {
    const owner: LockOwner = {
      pid: process.pid,
      host: os.hostname(),
      boot: BOOT_ID,
      started_at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify(owner));
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
