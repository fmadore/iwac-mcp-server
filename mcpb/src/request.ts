import { AsyncLocalStorage } from "node:async_hooks";
import { setMaxListeners } from "node:events";

import type { Subset } from "./config.js";
export interface RequestSnapshot {
  files: string[];
  generation: number;
  schema: Set<string>;
  provenance: Record<string, unknown>;
}
/** Reports bytes done and total (when known) for one named piece of work. */
export type ProgressReporter = (key: string, done: number, total: number | undefined) => void;
interface RequestScope {
  signal: AbortSignal;
  snapshots: Map<Subset, RequestSnapshot>;
  /** The tool call's own deadline (absent in shared jobs). */
  deadline?: AbortSignal;
  /** Subsets this call stopped waiting for before their first load finished. */
  loading?: Set<Subset>;
  /** Other one-time preparations (the query encoder) it stopped waiting for,
   * by the sentence that tells the user what is going on. */
  preparing?: Set<string>;
  progress?: ProgressReporter;
}
const scope = new AsyncLocalStorage<RequestScope>();
export const requestSignal = (): AbortSignal | undefined => scope.getStore()?.signal;
export const requestSnapshots = (): Map<Subset, RequestSnapshot> | undefined => scope.getStore()?.snapshots;
/** Where the current tool call reports download progress, if its caller asked. */
export const requestProgress = (): ProgressReporter | undefined => scope.getStore()?.progress;
/** True once the current tool call ran out of time (not a client cancellation). */
export const requestDeadlineExpired = (): boolean => scope.getStore()?.deadline?.aborted === true;
/** The subsets the current call gave up waiting on while they were still
 * downloading or loading for the first time. */
export const datasetsStillLoading = (): Subset[] => [...(scope.getStore()?.loading ?? [])];
/** The one-time preparations the current call gave up waiting on, as messages. */
export const preparationsStillRunning = (): string[] => [...(scope.getStore()?.preparing ?? [])];
const sharedWorkLifetime = new AbortController();
const sharedJobs = new Set<Promise<unknown>>();
// Shared jobs may legitimately have more than ten concurrent query listeners.
setMaxListeners(0, sharedWorkLifetime.signal);

/** A shared download/index belongs to the process, not its first caller.
 * Index builders can copy a caller's pinned snapshots without inheriting its
 * cancellation or deadline. Each job receives its own mutable snapshot map. */
export function runSharedWork<T>(
  fn: () => Promise<T>,
  snapshots?: ReadonlyMap<Subset, RequestSnapshot>,
): Promise<T> {
  const signal = AbortSignal.any([
    sharedWorkLifetime.signal,
    AbortSignal.timeout(15 * 60_000),
  ]);
  const job = scope.run({ signal, snapshots: new Map(snapshots) }, async () => {
    signal.throwIfAborted();
    return fn();
  });
  sharedJobs.add(job);
  void job.then(() => sharedJobs.delete(job), () => sharedJobs.delete(job));
  return job;
}

/** Cancel maintenance after requests drain and allow cache locks/partials to
 * finish cleanup before a normal process exit. The transport owns the final
 * hard shutdown deadline in case a dependency cannot be interrupted. */
export async function stopSharedWork(): Promise<void> {
  sharedWorkLifetime.abort();
  await Promise.allSettled([...sharedJobs]);
}

/** Cancel this caller's wait without cancelling a promise shared by others. */
export async function waitForSharedWork<T>(
  job: Promise<T>,
  signal = requestSignal(),
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return job;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void job.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * waitForSharedWork for a subset's first load. A caller cut off while the
 * download is still running records the subset, so the tool wrapper can say
 * "still downloading, retry shortly" instead of passing on a bare abort (the
 * download itself carries on: it belongs to the process, not this call).
 */
export async function waitForDataset<T>(subset: Subset, job: Promise<T>): Promise<T> {
  let settled = false;
  void job.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    return await waitForSharedWork(job);
  } catch (err) {
    if (!settled) scope.getStore()?.loading?.add(subset);
    throw err;
  }
}

/**
 * waitForDataset for any other one-time preparation, such as the query
 * encoder's download. A caller cut off while it is still running records
 * `message`, which the tool wrapper returns instead of a query timeout: the
 * preparation carries on, and narrowing the selection would change nothing.
 * Only a call in request scope records; inside shared work it just waits.
 */
export async function waitForPreparation<T>(message: string, job: Promise<T>): Promise<T> {
  let settled = false;
  void job.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    return await waitForSharedWork(job);
  } catch (err) {
    const store = scope.getStore();
    if (!settled && store?.deadline) {
      store.preparing ??= new Set();
      store.preparing.add(message);
    }
    throw err;
  }
}

/** How long one tool call may run. A first call that starts a ~185 MB subset
 * download can outlast it; the download continues as shared work. */
export const REQUEST_DEADLINE_MS = 120_000;

const latencies: number[] = [];
let completed = 0;
let failed = 0;
/** `completed` counts every call that finished, failed ones included (its
 * meaning predates `failed`, which counts the calls that threw or returned a
 * tool error). */
export function requestMetrics(): { completed: number; failed: number; window: number; p50_ms: number; p95_ms: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0);
  return { completed, failed, window: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) };
}
export function withRequest<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  options: { deadlineMs?: number; progress?: ProgressReporter } = {},
): Promise<T> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(options.deadlineMs ?? REQUEST_DEADLINE_MS);
  const store: RequestScope = {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    snapshots: new Map(),
    deadline,
    loading: new Set(),
    progress: options.progress,
  };
  return scope
    .run(store, fn)
    .then(
      (value) => {
        // A tool error is returned (isError), not thrown, so count both.
        if ((value as { isError?: unknown } | undefined)?.isError === true) failed++;
        return value;
      },
      (err: unknown) => {
        failed++;
        throw err;
      },
    )
    .finally(() => {
      completed++;
      latencies.push(performance.now() - started);
      if (latencies.length > 256) latencies.shift();
    });
}

/** FIFO semaphore with bounded queue, deadlines and removable cancelled waits. */
export class WorkQueue {
  active = 0;
  private waiting: { resolve: () => void; reject: (e: Error) => void; cleanup: () => void }[] = [];
  constructor(
    readonly concurrency: number,
    readonly capacity: number,
    readonly waitMs = 30_000,
  ) {}
  get queued(): number {
    return this.waiting.length;
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.concurrency) this.active++;
    else {
      if (this.waiting.length >= this.capacity) throw new Error("Server busy: work queue is full. Retry shortly.");
      await new Promise<void>((resolve, reject) => {
        const remove = (e: Error) => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          entry.cleanup();
          reject(e);
        };
        const abort = () => remove(new Error("Request cancelled while queued"));
        const timer = setTimeout(() => remove(new Error("Work queue deadline exceeded. Retry shortly.")), this.waitMs);
        const entry = {
          resolve,
          reject,
          cleanup: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
          },
        };
        this.waiting.push(entry);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.cleanup();
        next.resolve();
      } else this.active--;
    };
  }
}
