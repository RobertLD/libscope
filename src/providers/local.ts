import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { ConfigError, EmbeddingError } from "../errors.js";
import type { EmbeddingProvider } from "./embedding.js";
import { getLogger } from "../logger.js";
import { forEachSequential, mapSequential } from "../utils/async.js";
import { withRetry } from "../utils/retry.js";

/** A model that the local provider can run. */
interface LocalModel {
  /** Model identifier, recorded with the vector index. */
  model: string;
  /** Hugging Face repository and pinned revision of the ONNX export. */
  repo: string;
  revision: string;
  /** The model's max_seq_length in sentence-transformers. Longer input is truncated. */
  maxTokens: number;
  /** How the token vectors become the vector of the text. */
  pooling: "mean" | "cls";
  dimensions: number;
}

/** The supported local models, keyed by their `embedding.model` name. */
export const LOCAL_MODELS: ReadonlyMap<string, LocalModel> = new Map([
  [
    "all-MiniLM-L6-v2",
    {
      model: "sentence-transformers/all-MiniLM-L6-v2",
      repo: "Xenova/all-MiniLM-L6-v2",
      revision: "751bff37182d3f1213fa05d7196b954e230abad9",
      maxTokens: 256,
      pooling: "mean",
      dimensions: 384,
    },
  ],
  [
    "bge-small-en-v1.5",
    {
      model: "BAAI/bge-small-en-v1.5",
      repo: "Xenova/bge-small-en-v1.5",
      revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
      maxTokens: 512,
      pooling: "cls",
      dimensions: 384,
    },
  ],
  [
    "bge-base-en-v1.5",
    {
      model: "BAAI/bge-base-en-v1.5",
      repo: "Xenova/bge-base-en-v1.5",
      revision: "4d6cd88e18e51a5e020c2c305726d76ada9c03cf",
      maxTokens: 512,
      pooling: "cls",
      dimensions: 768,
    },
  ],
]);

/** The key of LOCAL_MODELS used when `embedding.model` is not set. */
export const DEFAULT_LOCAL_MODEL = "all-MiniLM-L6-v2";

const TOKENIZER_FILE = "tokenizer.json";
const TOKENIZER_CONFIG_FILE = "tokenizer_config.json";
// Full precision: the quantized export's vectors drift from the original model's.
const ONNX_FILE = "onnx/model.onnx";
const MODEL_FILES = [TOKENIZER_FILE, TOKENIZER_CONFIG_FILE, ONNX_FILE];

/** Download events while the model files are fetched (first use only). */
export interface ModelDownloadEvent {
  /** "progress" while a file downloads, then "ready" once all files are cached. */
  status: "progress" | "ready";
  file?: string | undefined;
  /** Percent of `file` downloaded (status "progress"). */
  progress?: number | undefined;
}

/** Directory where the local embedding models are cached (`~/.libscope/models`). */
export function getModelCacheDir(): string {
  return join(homedir(), ".libscope", "models");
}

/**
 * Truncate token ids that start with [CLS] and end with [SEP] to `maxTokens`,
 * keeping the final [SEP] as sentence-transformers does.
 */
export function truncateTokenIds(ids: number[], maxTokens: number): number[] {
  if (ids.length <= maxTokens) return ids;
  return [...ids.slice(0, maxTokens - 1), ...ids.slice(-1)];
}

function scaleToUnitLength(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, x) => acc + x * x, 0));
  return vector.map((x) => x / norm);
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
  return scaleToUnitLength(sum);
}

/** Vector of the first token, [CLS] (shape [tokens, dimensions], row-major), scaled to unit length. */
export function clsPoolNormalized(hidden: Float32Array, dimensions: number): number[] {
  return scaleToUnitLength(Array.from(hidden.subarray(0, dimensions)));
}

/** Download one model file into the cache, through a temporary file of this download. */
async function downloadModelFile(
  model: LocalModel,
  file: string,
  dest: string,
  onProgress: ((event: ModelDownloadEvent) => void) | undefined,
): Promise<void> {
  const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
  const partial = `${dest}.${randomUUID()}.partial`;
  await mkdir(dirname(dest), { recursive: true });
  await withRetry(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new EmbeddingError(`Download of ${url} failed: HTTP ${res.status}`);
      }
      const total = Number(res.headers.get("content-length"));
      let received = 0;
      await pipeline(
        res.body as AsyncIterable<Uint8Array>,
        async function* (parts: AsyncIterable<Uint8Array>) {
          for await (const part of parts) {
            received += part.length;
            if (onProgress && total > 0) {
              onProgress({ status: "progress", file, progress: (received / total) * 100 });
            }
            yield part;
          }
        },
        createWriteStream(partial),
      );
      await rename(partial, dest);
    } catch (err) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw err;
    }
  });
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
 * Local embedding provider: one of LOCAL_MODELS run in-process on the ONNX Runtime
 * WebAssembly build, with truncation and pooling as in sentence-transformers.
 * Downloads the model on first use.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model: string;
  readonly dimensions: number;

  private readonly localModel: LocalModel;
  private loading: Promise<LoadedModel> | null = null;

  /** @throws ConfigError when `modelName` is not a key of LOCAL_MODELS. */
  constructor(modelName: string = DEFAULT_LOCAL_MODEL) {
    const localModel = LOCAL_MODELS.get(modelName);
    if (!localModel) {
      throw new ConfigError(
        `embedding.model "${modelName}" is not a model of the local provider. ` +
          `Supported models: ${[...LOCAL_MODELS.keys()].join(", ")}. ` +
          'Run "libscope config set embedding.model <model>" or ' +
          '"libscope config unset embedding.model". ' +
          "If LIBSCOPE_EMBEDDING_MODEL or a project .libscope.json sets it, change it there.",
      );
    }
    this.localModel = localModel;
    this.model = localModel.model;
    this.dimensions = localModel.dimensions;
  }

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
    log.info(`Loading local embedding model (${this.model})...`);
    const modelDir = join(getModelCacheDir(), this.localModel.repo);
    const missing = MODEL_FILES.filter((file) => !existsSync(join(modelDir, file)));
    // One file at a time, so that download progress reports one file at a time.
    await forEachSequential(missing, (file) =>
      downloadModelFile(this.localModel, file, join(modelDir, file), this.onDownloadProgress),
    );
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
      const ids = truncateTokenIds(tokenizer.encode(text).ids, this.localModel.maxTokens);
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
      switch (this.localModel.pooling) {
        case "mean":
          return meanPoolNormalized(hidden, ids.length, this.dimensions);
        case "cls":
          return clsPoolNormalized(hidden, this.dimensions);
      }
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
