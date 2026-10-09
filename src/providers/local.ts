import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { EmbeddingError } from "../errors.js";
import type { EmbeddingProvider } from "./embedding.js";
import { getLogger } from "../logger.js";
import { mapSequential } from "../utils/async.js";
import { withRetry } from "../utils/retry.js";

/** Hugging Face repository and pinned revision of the ONNX export of all-MiniLM-L6-v2. */
const MODEL_REPO = "Xenova/all-MiniLM-L6-v2";
const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const TOKENIZER_FILE = "tokenizer.json";
const TOKENIZER_CONFIG_FILE = "tokenizer_config.json";
// Full precision: the quantized export's vectors drift from the original model's.
const ONNX_FILE = "onnx/model.onnx";
const MODEL_FILES = [TOKENIZER_FILE, TOKENIZER_CONFIG_FILE, ONNX_FILE];

/** The model's max_seq_length in sentence-transformers. Longer input is truncated. */
export const MAX_TOKENS = 256;

/** Download events while the model files are fetched (first use only). */
export interface ModelDownloadEvent {
  /** "progress" while a file downloads, then "ready" once all files are cached. */
  status: "progress" | "ready";
  file?: string | undefined;
  /** Percent of `file` downloaded (status "progress"). */
  progress?: number | undefined;
}

/** Directory where the local embedding model is cached (`~/.libscope/models`). */
export function getModelCacheDir(): string {
  return join(homedir(), ".libscope", "models");
}

/**
 * Truncate token ids that start with [CLS] and end with [SEP] to MAX_TOKENS,
 * keeping the final [SEP] as sentence-transformers does.
 */
export function truncateTokenIds(ids: number[]): number[] {
  if (ids.length <= MAX_TOKENS) return ids;
  return [...ids.slice(0, MAX_TOKENS - 1), ...ids.slice(-1)];
}

/** Mean of the token vectors (shape [tokens, dimensions], row-major), scaled to unit length. */
export function meanPoolNormalized(
  hidden: Float32Array,
  tokens: number,
  dimensions: number,
): number[] {
  const sum = new Array<number>(dimensions).fill(0);
  for (let t = 0; t < tokens; t++) {
    for (let d = 0; d < dimensions; d++) {
      sum[d]! += hidden[t * dimensions + d]!;
    }
  }
  const norm = Math.sqrt(sum.reduce((acc, x) => acc + x * x, 0));
  return sum.map((x) => x / norm);
}

/** Download one model file into the cache, through a temporary file. */
async function downloadModelFile(
  file: string,
  dest: string,
  onProgress: ((event: ModelDownloadEvent) => void) | undefined,
): Promise<void> {
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file}`;
  const { body, total } = await withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new EmbeddingError(`Download of ${url} failed: HTTP ${res.status}`);
    }
    return {
      body: res.body as AsyncIterable<Uint8Array>,
      total: Number(res.headers.get("content-length")),
    };
  });
  const parts: Uint8Array[] = [];
  let received = 0;
  for await (const part of body) {
    parts.push(part);
    received += part.length;
    if (onProgress && total > 0) {
      onProgress({ status: "progress", file, progress: (received / total) * 100 });
    }
  }
  await mkdir(dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  await writeFile(partial, Buffer.concat(parts));
  await rename(partial, dest);
}

/**
 * The part of the @huggingface/tokenizers Tokenizer used here. The package's own type
 * declarations use extensionless imports, which do not resolve under NodeNext.
 */
interface Tokenizer {
  encode(text: string): { ids: number[] };
}

interface TokenizersModule {
  Tokenizer: new (tokenizerJson: object, tokenizerConfig: object) => Tokenizer;
}

/** Tokenizer and inference session of the loaded model. */
interface LoadedModel {
  tokenizer: Tokenizer;
  session: InferenceSession;
  Tensor: typeof Tensor;
}

/**
 * Local embedding provider: all-MiniLM-L6-v2 run in-process on the ONNX Runtime
 * WebAssembly build, with truncation and mean pooling as in sentence-transformers.
 * Downloads the model on first use (~90MB).
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model = "sentence-transformers/all-MiniLM-L6-v2";
  readonly dimensions = 384;

  private loading: Promise<LoadedModel> | null = null;

  /** Called while the model is downloaded (not when it is already cached), e.g. to show progress. */
  onDownloadProgress: ((event: ModelDownloadEvent) => void) | undefined;

  /** The loaded model, loading it on first call. A failed load is retried on the next call. */
  private load(): Promise<LoadedModel> {
    this.loading ??= this.loadModel().catch((err: unknown) => {
      this.loading = null;
      throw new EmbeddingError("Failed to load local embedding model", err);
    });
    return this.loading;
  }

  private async loadModel(): Promise<LoadedModel> {
    const log = getLogger();
    log.info("Loading local embedding model (all-MiniLM-L6-v2)...");
    const modelDir = join(getModelCacheDir(), MODEL_REPO);
    const missing = MODEL_FILES.filter((file) => !existsSync(join(modelDir, file)));
    for (const file of missing) {
      await downloadModelFile(file, join(modelDir, file), this.onDownloadProgress);
    }
    if (missing.length > 0) this.onDownloadProgress?.({ status: "ready" });

    // Dynamic imports so that commands without embeddings do not load the runtime.
    const [{ Tokenizer }, ort] = await Promise.all([
      import("@huggingface/tokenizers") as Promise<unknown> as Promise<TokenizersModule>,
      import("onnxruntime-web"),
    ]);
    const [tokenizerJson, tokenizerConfig, onnx] = await Promise.all([
      readFile(join(modelDir, TOKENIZER_FILE), "utf8"),
      readFile(join(modelDir, TOKENIZER_CONFIG_FILE), "utf8"),
      readFile(join(modelDir, ONNX_FILE)),
    ]);
    // The runtime's default is min(4, cores / 2) threads.
    ort.env.wasm.numThreads = availableParallelism();
    const loaded: LoadedModel = {
      tokenizer: new Tokenizer(
        JSON.parse(tokenizerJson) as object,
        JSON.parse(tokenizerConfig) as object,
      ),
      session: await ort.InferenceSession.create(onnx),
      Tensor: ort.Tensor,
    };
    log.info("Local embedding model loaded successfully");
    return loaded;
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) {
      throw new EmbeddingError("Input text must not be empty");
    }
    const { tokenizer, session, Tensor } = await this.load();
    try {
      const ids = truncateTokenIds(tokenizer.encode(text).ids);
      const shape = [1, ids.length];
      const output = await session.run({
        input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
        attention_mask: new Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
        token_type_ids: new Tensor("int64", new BigInt64Array(ids.length), shape),
      });
      const hidden = output["last_hidden_state"]!.data as Float32Array;
      if (hidden.length !== ids.length * this.dimensions) {
        throw new EmbeddingError(
          `Expected embedding dimension ${this.dimensions}, got ${hidden.length / ids.length}`,
        );
      }
      return meanPoolNormalized(hidden, ids.length, this.dimensions);
    } catch (err) {
      throw new EmbeddingError(`Failed to generate embedding: ${String(err)}`, err);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      throw new EmbeddingError("Input texts array must not be empty");
    }
    for (const t of texts) {
      if (!t.trim()) {
        throw new EmbeddingError("Input text must not be empty");
      }
    }
    // Process sequentially to avoid memory issues with local model
    return await mapSequential(texts, (text) => this.embed(text));
  }
}
