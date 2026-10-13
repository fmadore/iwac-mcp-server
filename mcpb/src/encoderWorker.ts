// Worker thread that owns the query encoder (see onnxEncoder.ts).
//
// onnxruntime-node runs inference synchronously on the thread that calls
// `session.run` (its async `run` only defers the call with setImmediate), and
// creating a session from a 314 MB graph takes seconds. On the main thread
// either would freeze every other request the server is handling, so both
// happen here, and the main thread only exchanges messages.
//
// onnxruntime-node is loaded with a require anchored at `workerData.base`, the
// bundle's own location: a worker started from source code resolves bare
// imports from the process's working directory, which is wherever the host
// launched the server.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { Tokenizer } from "@huggingface/tokenizers";

type Ort = typeof import("onnxruntime-node");
export type EncoderRequest =
  | { type: "load"; dir: string; graph: string; threads: number; maxTokens: number }
  | { type: "encode" | "tokenize"; id: number; text: string };
export type EncoderReply =
  | { type: "runtime"; error?: string }
  | { type: "ready"; error?: string }
  | { type: "result"; id: number; vector?: Float32Array; ids?: number[]; error?: string };

const port = parentPort;
if (!port) throw new Error("encoderWorker must run as a worker thread");

let ort: Ort | undefined;
try {
  ort = createRequire((workerData as { base: string }).base)("onnxruntime-node") as Ort;
  port.postMessage({ type: "runtime" } satisfies EncoderReply);
} catch (err) {
  port.postMessage({ type: "runtime", error: (err as Error).message } satisfies EncoderReply);
}

let session: import("onnxruntime-node").InferenceSession | undefined;
let tokenizer: Tokenizer | undefined;
let featureDim = 0;
let maxTokens = 0;

async function load(dir: string, graph: string, threads: number): Promise<void> {
  if (!ort) throw new Error("onnxruntime-node is not loaded");
  const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  tokenizer = new Tokenizer(read("tokenizer.json"), read("tokenizer_config.json"));
  session = await ort.InferenceSession.create(path.join(dir, graph), {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    // A bounded thread pool (config.ts gives the measurements) whose threads
    // sleep between queries instead of spin-waiting for the next one: on a
    // host shared with other services an idle encoder should cost no CPU.
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    extra: { session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } } },
  });
  const featureInput = session.inputMetadata.find((m) => m.name === "image_features");
  featureDim = featureInput?.isTensor ? Number(featureInput.shape.at(-1)) : Number.NaN;
  if (!Number.isInteger(featureDim) || !session.outputNames.includes("sentence_embedding")) {
    throw new Error("The ONNX export does not have the inputs and outputs this encoder expects");
  }
}

async function encode(ids: number[]): Promise<Float32Array> {
  if (!ort || !session) throw new Error("The query encoder is not loaded");
  const { Tensor } = ort;
  const n = ids.length;
  const noFeatures = () => new Tensor("float32", new Float32Array(0), [0, featureDim]);
  const output = await session.run(
    {
      input_ids: new Tensor("int64", BigInt64Array.from(ids, (id: number) => BigInt(id)), [1, n]),
      attention_mask: new Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
      image_features: noFeatures(),
      video_features: noFeatures(),
      audio_features: noFeatures(),
    },
    ["sentence_embedding"],
  );
  return Float32Array.from(output.sentence_embedding.data as Float32Array);
}

/** Messages are handled one at a time, in arrival order: inference is
 * CPU-bound, so running two at once on this thread could not be faster. */
let chain: Promise<void> = Promise.resolve();
port.on("message", (message: EncoderRequest) => {
  chain = chain.then(async () => {
    if (message.type === "load") {
      try {
        maxTokens = message.maxTokens;
        await load(message.dir, message.graph, message.threads);
        port.postMessage({ type: "ready" } satisfies EncoderReply);
      } catch (err) {
        port.postMessage({ type: "ready", error: (err as Error).message } satisfies EncoderReply);
      }
      return;
    }
    try {
      if (!tokenizer) throw new Error("The query encoder is not loaded");
      const ids = tokenizer.encode(message.text).ids;
      if (message.type === "tokenize") {
        port.postMessage({ type: "result", id: message.id, ids } satisfies EncoderReply);
        return;
      }
      if (ids.length > maxTokens) throw new Error(`The query is ${ids.length} tokens long; the encoder accepts at most ${maxTokens}.`);
      const vector = await encode(ids);
      port.postMessage({ type: "result", id: message.id, vector, ids } satisfies EncoderReply, [vector.buffer as ArrayBuffer]);
    } catch (err) {
      port.postMessage({ type: "result", id: message.id, error: (err as Error).message } satisfies EncoderReply);
    }
  });
});
