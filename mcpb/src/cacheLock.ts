import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requestSignal } from "./request.js";

/** Cross-process exclusion. Never steal a lock based only on elapsed time:
 * a large download may still be alive. A crashed writer's lock needs explicit
 * removal after its owner is confirmed stopped. Readers use committed files. */
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
      if (Date.now() - started > 30_000)
        throw new Error(
          `Cache writer lock is busy: ${lock}. Retry; if its owner has stopped, remove this lock directory.`,
        );
      await delay(100, undefined, { signal: requestSignal() });
    }
  }
  try {
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
    );
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
