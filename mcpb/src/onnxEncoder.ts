// In-process query encoder for the corpus model, EmbeddingGemma 2.
//
// It runs the same ONNX export the IWAC pipeline embedded the corpus with
// (IWAC-Hugging-Face post-processing/_gemma_encoder.py), pinned to the same
// revision, so a semantic search needs no API key and no query text leaves the
// machine. Only the text graph is loaded: images are embedded offline, and a
// photograph is found by encoding the TEXT query into the shared space.
//
// The weights are fetched from the Hub on first use (314 MB for q8, 1.08 GB for
// fp32), checked against the sizes and SHA-256 digests pinned below, and kept
// in the model cache. The session and tokenizer live in a worker thread
// (encoderWorker.ts), started on first use, so a server that never runs a
// semantic search never loads them, and one that does keeps answering other
// requests while a query is encoded.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { config } from "./config.js";
import type { EncoderReply, EncoderRequest } from "./encoderWorker.js";
import { downloadVerified } from "./hf.js";
import { requestSignal, runSharedWork, waitForSharedWork } from "./request.js";
import { withCacheLock } from "./cacheLock.js";

export const ENCODER_MODEL = "google/embeddinggemma-2";
const EXPORT_REPO = "onnx-community/embeddinggemma-2-ONNX";
const EXPORT_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
/** The pipeline truncates documents at this many tokens; a query this long is
 * refused instead, since cutting it would rank a query nobody wrote. */
const MAX_TOKENS = 8192;
export const ENCODER_DTYPES = ["q8", "fp32"] as const;
export type EncoderDtype = (typeof ENCODER_DTYPES)[number];

interface PinnedFile {
  path: string;
  size: number;
  sha256: string;
}
const TOKENIZER_FILES: PinnedFile[] = [
  { path: "tokenizer.json", size: 32_170_510, sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4" },
  { path: "tokenizer_config.json", size: 1_599, sha256: "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874" },
];
/** The graph, then its external weights, which must sit beside it. */
const GRAPH_FILES: Record<EncoderDtype, [PinnedFile, PinnedFile]> = {
  q8: [
    { path: "onnx/model_quantized.onnx", size: 495_165, sha256: "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953" },
    { path: "onnx/model_quantized.onnx_data", size: 313_724_928, sha256: "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b" },
  ],
  fp32: [
    { path: "onnx/model.onnx", size: 421_421, sha256: "bc47de15f81208a5c99e5ab10f746d5e33b51ea228b7dc0bef9c133a94f1c1c3" },
    { path: "onnx/model.onnx_data", size: 1_084_170_240, sha256: "9fd452bfc6916e5a92f080f8dada35598ca4512b21c65897d4c5974d5f9630a2" },
  ],
};

declare const __IWAC_ENCODER_WORKER__: string;
type Result = Extract<EncoderReply, { type: "result" }>;

/**
 * The main thread's handle on the encoder worker. Requests are matched to
 * replies by id; the worker answers them in order. It is unref'd while idle, so
 * it never keeps a finished process alive, and ref'd while anything waits on
 * it. If it dies, every waiter is rejected and the next search starts a new one.
 */
class EncoderWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (r: Result) => void; reject: (e: Error) => void }>();
  private readonly stages: EncoderReply[] = [];
  private stageWaiter?: { resolve: (r: EncoderReply) => void; reject: (e: Error) => void };
  private nextId = 0;
  private dead?: Error;

  constructor(onDeath: () => void) {
    // The bundle's own location anchors the worker's require of onnxruntime-node.
    const workerData = { base: import.meta.url };
    this.worker =
      typeof __IWAC_ENCODER_WORKER__ === "string"
        ? new Worker(__IWAC_ENCODER_WORKER__, { eval: true, workerData })
        : new Worker(new URL("./encoderWorker.ts", import.meta.url), { workerData });
    this.worker.on("message", (reply: EncoderReply) => {
      if (reply.type === "result") {
        const waiter = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        waiter?.resolve(reply);
      } else if (this.stageWaiter) {
        this.stageWaiter.resolve(reply);
        this.stageWaiter = undefined;
      } else this.stages.push(reply);
      this.updateRef();
    });
    const die = (err: Error) => {
      if (this.dead) return;
      this.dead = err;
      for (const waiter of this.pending.values()) waiter.reject(err);
      this.pending.clear();
      this.stageWaiter?.reject(err);
      this.stageWaiter = undefined;
      onDeath();
    };
    this.worker.on("error", die);
    this.worker.on("exit", (code) => die(new Error(`The query encoder worker exited (code ${code})`)));
    this.updateRef();
  }

  private updateRef(): void {
    if (this.pending.size || this.stageWaiter) this.worker.ref();
    else this.worker.unref();
  }

  /** The next start-up reply (`runtime`, then `ready`). */
  nextStage(): Promise<EncoderReply> {
    if (this.dead) return Promise.reject(this.dead);
    const buffered = this.stages.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      this.stageWaiter = { resolve, reject };
      this.updateRef();
    });
  }

  send(message: EncoderRequest): void {
    this.worker.postMessage(message);
  }

  call(type: "encode" | "tokenize", text: string): Promise<Result> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    const reply = new Promise<Result>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.updateRef();
    this.worker.postMessage({ type, id, text } satisfies EncoderRequest);
    return reply;
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

let loading: { key: string; encoder: Promise<EncoderWorker> } | undefined;

export function encoderDtype(): EncoderDtype {
  const dtype = config.embeddingDtype;
  if (!(ENCODER_DTYPES as readonly string[]).includes(dtype)) {
    throw new Error(`IWAC_EMBEDDING_DTYPE must be one of ${ENCODER_DTYPES.join(", ")}; got '${dtype}'.`);
  }
  return dtype as EncoderDtype;
}

/** Where one export's files live: short, and keyed by revision so a future
 * export lands beside this one instead of over files a session may hold open. */
function exportDir(): string {
  return path.join(config.modelCacheDir, `embeddinggemma-2-${EXPORT_REVISION.slice(0, 12)}`);
}

async function present(file: PinnedFile): Promise<boolean> {
  try {
    return (await fs.stat(path.join(exportDir(), file.path))).size === file.size;
  } catch {
    return false;
  }
}

/** Fetch whichever pinned files are missing. A file is renamed into place only
 * after its digest matches, so presence at the right size means verified. */
async function ensureFiles(files: PinnedFile[]): Promise<void> {
  const missing = (await Promise.all(files.map(async (f) => ((await present(f)) ? undefined : f)))).filter(
    (f): f is PinnedFile => f !== undefined,
  );
  if (!missing.length) return;
  if (config.offline) {
    throw new Error(
      `IWAC_OFFLINE is set but the query encoder is not cached in ${exportDir()} (missing ${missing.map((f) => f.path).join(", ")}).`,
    );
  }
  await fs.mkdir(exportDir(), { recursive: true });
  await withCacheLock(exportDir(), async () => {
    for (const file of missing) {
      if (await present(file)) continue; // another process finished it while we waited
      const url = `https://huggingface.co/${EXPORT_REPO}/resolve/${EXPORT_REVISION}/${file.path}`;
      console.error(`[iwac] downloading ${EXPORT_REPO}/${file.path} (${Math.round(file.size / 1e6)} MB)`);
      const signal = requestSignal() ?? AbortSignal.timeout(30 * 60_000);
      await downloadVerified(url, path.join(exportDir(), file.path), file, signal);
    }
  });
}

async function loadEncoder(dtype: EncoderDtype, forget: () => void): Promise<EncoderWorker> {
  const [graph, weights] = GRAPH_FILES[dtype];
  const worker = new EncoderWorker(forget);
  try {
    // The worker loads the runtime first: no point fetching hundreds of
    // megabytes for a platform onnxruntime-node cannot run on.
    const runtime = await worker.nextStage();
    if (runtime.type === "runtime" && runtime.error) {
      throw new Error(
        `The local query encoder cannot run on ${process.platform}-${process.arch}: onnxruntime-node did not load ` +
          `(${runtime.error}).` +
          (process.platform === "win32" ? " It needs the Microsoft Visual C++ 2015-2022 Redistributable." : "") +
          " Similar items, semantic maps and keyword search still work.",
      );
    }
    await ensureFiles([...TOKENIZER_FILES, graph, weights]);
    worker.send({ type: "load", dir: exportDir(), graph: graph.path, threads: config.embeddingThreads, maxTokens: MAX_TOKENS });
    const ready = await worker.nextStage();
    if (ready.type !== "ready" || ready.error) {
      throw new Error(`${EXPORT_REPO}@${EXPORT_REVISION} did not load: ${ready.error ?? "unexpected reply"}`);
    }
  } catch (err) {
    worker.terminate();
    throw err;
  }
  console.error(`[iwac] query encoder ready: ${ENCODER_MODEL} (${dtype}, ${config.embeddingThreads} thread(s))`);
  return worker;
}

/** The process-wide encoder. Its download and load belong to the process, not
 * to the request that first needed it: a client that gives up during the
 * one-time download leaves it running, and the next search finds it ready. A
 * failed load is forgotten so the next call retries. */
function encoder(): Promise<EncoderWorker> {
  const dtype = encoderDtype();
  const key = `${config.modelCacheDir}|${dtype}|${config.embeddingThreads}`;
  if (loading?.key !== key) {
    const previous = loading;
    const forget = () => {
      if (loading?.encoder === job) loading = undefined;
    };
    const job = runSharedWork(() => loadEncoder(dtype, forget));
    loading = { key, encoder: job };
    job.catch(forget);
    // A changed configuration (only tests change it) replaces the worker.
    previous?.encoder.then((old) => old.terminate(), () => {});
  }
  return loading.encoder;
}

/** Start fetching and loading the encoder without waiting for it, so the first
 * search of a long-running server does not pay for the download. */
export function warmEncoder(): void {
  encoder().catch((err) => console.error(`[iwac] query encoder unavailable: ${(err as Error).message}`));
}

/** Wait until the encoder is downloaded and loaded. A caller that runs out of
 * time is told the download goes on, not handed a bare timeout. */
export async function encoderReady(): Promise<void> {
  try {
    await waitForSharedWork(encoder());
  } catch (err) {
    if (requestSignal()?.aborted) {
      throw new Error(
        `The local query encoder (${ENCODER_MODEL}, a one-time download of ~${encoderDtype() === "fp32" ? "1.1 GB" : "350 MB"}) ` +
          "is still being prepared. Retry in a minute.",
      );
    }
    throw err;
  }
}

/** Encode one already-prefixed query into the model's (unit) vector. */
export async function encodeQuery(text: string): Promise<number[]> {
  const reply = await (await waitForSharedWork(encoder())).call("encode", text);
  if (reply.error || !reply.vector) throw new Error(reply.error ?? "The query encoder returned no vector");
  return Array.from(reply.vector);
}

/** Token ids for one already-prefixed query, for the parity test. */
export async function queryTokenIds(text: string): Promise<number[]> {
  const reply = await (await waitForSharedWork(encoder())).call("tokenize", text);
  if (reply.error || !reply.ids) throw new Error(reply.error ?? "The query encoder returned no tokens");
  return reply.ids;
}
