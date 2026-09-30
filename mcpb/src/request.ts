import { AsyncLocalStorage } from "node:async_hooks";

import type { Subset } from "./config.js";
export interface RequestSnapshot {
  files: string[];
  generation: number;
  schema: Set<string>;
  provenance: Record<string, unknown>;
}
const scope = new AsyncLocalStorage<{ signal: AbortSignal; snapshots: Map<Subset, RequestSnapshot> }>();
export const requestSignal = (): AbortSignal | undefined => scope.getStore()?.signal;
export const requestSnapshots = (): Map<Subset, RequestSnapshot> | undefined => scope.getStore()?.snapshots;
const latencies: number[] = [];
let completed = 0;
export function requestMetrics(): { completed: number; window: number; p50_ms: number; p95_ms: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0);
  return { completed, window: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) };
}
export function withRequest<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(120_000);
  return scope
    .run({ signal: signal ? AbortSignal.any([signal, deadline]) : deadline, snapshots: new Map() }, fn)
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
