import { Worker } from "node:worker_threads";
import type { Projection } from "./pca.js";
import { requestSignal, WorkQueue } from "./request.js";

declare const __IWAC_PCA_WORKER__: string;
const queue = new WorkQueue(2, 8);
const cache = new Map<string, Projection>();

/** CPU work cannot monopolise the HTTP event loop. Cache only 8 completed
 * projections; keys include the dataset generation and selected vector IDs. */
export async function projectAsync(vectors: number[][], key: string): Promise<Projection> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const signal = requestSignal();
  const release = await queue.acquire(signal);
  try {
    signal?.throwIfAborted();
    const worker =
      typeof __IWAC_PCA_WORKER__ === "string"
        ? new Worker(__IWAC_PCA_WORKER__, { eval: true, workerData: vectors })
        : new Worker(new URL("./pcaWorker.ts", import.meta.url), { workerData: vectors });
    const result = await new Promise<Projection>((resolve, reject) => {
      const abort = () => {
        cleanup();
        void worker.terminate();
        reject(new Error("Projection cancelled or deadline exceeded"));
      };
      const timer = setTimeout(abort, 30_000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (value) => {
        cleanup();
        resolve(value as Projection);
      });
      worker.once("error", (error) => {
        cleanup();
        reject(error);
      });
      worker.once("exit", (code) => {
        cleanup();
        if (code !== 0) reject(new Error(`Projection worker exited (${code})`));
      });
    });
    cache.set(key, result);
    if (cache.size > 8) cache.delete(cache.keys().next().value as string);
    return result;
  } finally {
    release();
  }
}
