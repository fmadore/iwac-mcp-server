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
// in the model cache. onnxruntime-node and the tokenizer are imported only
// then, so a server that never runs a semantic search never loads them.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
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

type Ort = typeof import("onnxruntime-node");
interface Encoder {
  ort: Ort;
  session: import("onnxruntime-node").InferenceSession;
  tokenizer: import("@huggingface/tokenizers").Tokenizer;
  /** Width of the (always empty) multimodal feature inputs the graph declares. */
  featureDim: number;
}

let loading: { key: string; encoder: Promise<Encoder> } | undefined;

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

async function loadEncoder(dtype: EncoderDtype): Promise<Encoder> {
  const [graph, weights] = GRAPH_FILES[dtype];
  // Load the runtime before fetching hundreds of megabytes it might not run.
  let ort: Ort;
  try {
    ort = await import("onnxruntime-node");
  } catch (err) {
    throw new Error(
      `The local query encoder cannot run on ${process.platform}-${process.arch}: onnxruntime-node did not load ` +
        `(${(err as Error).message}).` +
        (process.platform === "win32" ? " It needs the Microsoft Visual C++ 2015-2022 Redistributable." : "") +
        " Similar items, semantic maps and keyword search still work.",
    );
  }
  await ensureFiles([...TOKENIZER_FILES, graph, weights]);
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(exportDir(), name), "utf8"));
  const tokenizer = new Tokenizer(await read("tokenizer.json"), await read("tokenizer_config.json"));
  const session = await ort.InferenceSession.create(path.join(exportDir(), graph.path), {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  const featureInput = session.inputMetadata.find((m) => m.name === "image_features");
  const featureDim = featureInput?.isTensor ? Number(featureInput.shape.at(-1)) : Number.NaN;
  if (!Number.isInteger(featureDim) || !session.outputNames.includes("sentence_embedding")) {
    await session.release();
    throw new Error(`${EXPORT_REPO}@${EXPORT_REVISION} does not have the inputs and outputs this encoder expects`);
  }
  console.error(`[iwac] query encoder ready: ${ENCODER_MODEL} (${dtype})`);
  return { ort, session, tokenizer, featureDim };
}

/** The process-wide encoder. Its download and load belong to the process, not
 * to the request that first needed it: a client that gives up during the
 * one-time download leaves it running, and the next search finds it ready. A
 * failed load is forgotten so the next call retries. */
function encoder(): Promise<Encoder> {
  const dtype = encoderDtype();
  const key = `${config.modelCacheDir}|${dtype}`;
  if (loading?.key !== key) {
    const job = runSharedWork(() => loadEncoder(dtype));
    loading = { key, encoder: job };
    job.catch(() => {
      if (loading?.encoder === job) loading = undefined;
    });
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
  const { ort, session, tokenizer, featureDim } = await waitForSharedWork(encoder());
  const ids = tokenizer.encode(text).ids;
  if (ids.length > MAX_TOKENS) {
    throw new Error(`The query is ${ids.length} tokens long; the encoder accepts at most ${MAX_TOKENS}.`);
  }
  const n = ids.length;
  const noFeatures = () => new ort.Tensor("float32", new Float32Array(0), [0, featureDim]);
  const output = await session.run(
    {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, (id: number) => BigInt(id)), [1, n]),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
      image_features: noFeatures(),
      video_features: noFeatures(),
      audio_features: noFeatures(),
    },
    ["sentence_embedding"],
  );
  return Array.from(output.sentence_embedding.data as Float32Array);
}

/** Token ids for one already-prefixed query, for the parity test. */
export async function queryTokenIds(text: string): Promise<number[]> {
  return (await waitForSharedWork(encoder())).tokenizer.encode(text).ids;
}
