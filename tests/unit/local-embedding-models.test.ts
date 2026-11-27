import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const TOKENS = 600;
const run = vi.fn();
const fetchMock = vi.fn();
const existsSync = vi.fn();
const rename = vi.fn();
const rm = vi.fn();
const written = new Map<string, Buffer[]>();

vi.stubGlobal("fetch", fetchMock);

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync,
    createWriteStream: vi.fn((path: string) => {
      const chunks: Buffer[] = [];
      written.set(path, chunks);
      return new Writable({
        write(chunk: Buffer, _encoding, done): void {
          chunks.push(chunk);
          done();
        },
      });
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn(() => Promise.resolve(undefined)),
    readFile: vi.fn(() => Promise.resolve("{}")),
    rename,
    rm,
  };
});

vi.mock("../../src/utils/retry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/utils/retry.js")>();
  return {
    withRetry: <T>(fn: () => Promise<T>): Promise<T> => original.withRetry(fn, { baseDelayMs: 0 }),
  };
});

vi.mock("@huggingface/tokenizers", () => ({
  Tokenizer: class {
    encode(): { ids: number[] } {
      return { ids: Array.from({ length: TOKENS }, (_, i) => i) };
    }
  },
}));

vi.mock("onnxruntime-web", () => ({
  env: { wasm: {} },
  InferenceSession: { create: vi.fn(() => Promise.resolve({ run })) },
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array,
      readonly dims: number[],
    ) {}
  },
}));

const { getModelCacheDir, LOCAL_MODELS, LocalEmbeddingProvider } =
  await import("../../src/providers/local.js");
const { initLogger } = await import("../../src/logger.js");

/** Hidden state where the [CLS] vector is the first axis and every other token the second. */
function hiddenState(tokens: number, dimensions: number): Float32Array {
  const hidden = new Float32Array(tokens * dimensions);
  hidden[0] = 1;
  for (let t = 1; t < tokens; t++) {
    hidden[t * dimensions + 1] = 1;
  }
  return hidden;
}

function mockSession(dimensions: number): void {
  run.mockImplementation((feeds: { input_ids: { dims: number[] } }) =>
    Promise.resolve({
      last_hidden_state: { data: hiddenState(feeds.input_ids.dims[1]!, dimensions) },
    }),
  );
}

beforeAll(() => {
  initLogger("silent");
});

beforeEach(() => {
  run.mockReset();
  fetchMock.mockReset();
  existsSync.mockReset();
  rename.mockReset();
  rm.mockReset();
  written.clear();
});

describe.each([...LOCAL_MODELS])(
  "LocalEmbeddingProvider with %s",
  (name, { maxTokens, pooling, dimensions }) => {
    it(`truncates to ${maxTokens} tokens and pools with ${pooling}`, async () => {
      existsSync.mockReturnValue(true);
      mockSession(dimensions);

      const vector = await new LocalEmbeddingProvider(name).embed("some text");

      const feeds = run.mock.calls[0]![0] as { input_ids: { data: BigInt64Array } };
      expect(feeds.input_ids.data).toHaveLength(maxTokens);
      expect(feeds.input_ids.data.at(-1)).toBe(BigInt(TOKENS - 1));

      expect(vector).toHaveLength(dimensions);
      const others = maxTokens - 1;
      const expected = {
        cls: [1, 0],
        mean: [1 / Math.hypot(1, others), others / Math.hypot(1, others)],
      }[pooling];
      expect(vector[0]).toBeCloseTo(expected[0]!, 6);
      expect(vector[1]).toBeCloseTo(expected[1]!, 6);
      expect(vector.slice(2).every((x) => x === 0)).toBe(true);
    });
  },
);

describe("LocalEmbeddingProvider model download", () => {
  const name = "bge-small-en-v1.5";
  const { repo, revision, dimensions } = LOCAL_MODELS.get(name)!;
  const content = new Uint8Array([1, 2, 3, 4]);
  const tokenizerDest = join(getModelCacheDir(), repo, "tokenizer.json");
  const onnxDest = join(getModelCacheDir(), repo, "onnx/model.onnx");
  const TEMP_SUFFIX = /^\.[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.partial$/;

  /** The one temporary file that was opened for `dest`. */
  function tempFileOf(dest: string): string {
    const temps = [...written.keys()].filter(
      (path) => path.startsWith(dest) && TEMP_SUFFIX.test(path.slice(dest.length)),
    );
    expect(temps).toHaveLength(1);
    return temps[0]!;
  }

  /** A body without content-length that sends `content`, then fails if `fail` is set. */
  function streamBody(fail: boolean): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (!sent) {
          sent = true;
          controller.enqueue(content);
        } else if (fail) {
          controller.error(new Error("connection reset"));
        } else {
          controller.close();
        }
      },
    });
  }

  function embedCollectingEvents(): { result: Promise<number[]>; events: unknown[] } {
    const provider = new LocalEmbeddingProvider(name);
    const events: unknown[] = [];
    provider.onDownloadProgress = (event): void => {
      events.push(event);
    };
    return { result: provider.embed("some text"), events };
  }

  beforeEach(() => {
    existsSync.mockReturnValue(false);
    rename.mockResolvedValue(undefined);
    rm.mockResolvedValue(undefined);
    mockSession(dimensions);
  });

  it("removes the temporary file and rejects when the body fails on every attempt", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(streamBody(true))));

    await expect(embedCollectingEvents().result).rejects.toThrow(
      "Failed to load local embedding model",
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const removal = [tempFileOf(tokenizerDest), { force: true }];
    expect(rm.mock.calls).toEqual([removal, removal, removal, removal]);
    expect(rename).not.toHaveBeenCalled();
  });

  it("retries a download whose body fails", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(new Response(streamBody(true))))
      .mockImplementation(() => Promise.resolve(new Response(streamBody(false))));

    await embedCollectingEvents().result;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const temp = tempFileOf(tokenizerDest);
    expect(rm.mock.calls).toEqual([[temp, { force: true }]]);
    expect(Buffer.concat(written.get(temp)!)).toEqual(Buffer.from(content));
    expect(rename).toHaveBeenCalledWith(temp, tokenizerDest);
  });

  it("rejects with the download error when removing the temporary file fails", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 404 })));
    rm.mockRejectedValue(new Error("EISDIR"));

    await expect(embedCollectingEvents().result).rejects.toMatchObject({
      cause: { message: expect.stringContaining("HTTP 404") as unknown },
    });
  });

  it("reports only ready when the response has no content-length", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(streamBody(false))));

    const { result, events } = embedCollectingEvents();
    await result;

    expect(events).toEqual([{ status: "ready" }]);
  });

  it("streams the files of the pinned revision into the model's cache directory", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(content, { headers: { "content-length": "4" } })),
    );

    const { result, events } = embedCollectingEvents();
    await result;

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual(
      ["tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"].map(
        (file) => `https://huggingface.co/${repo}/resolve/${revision}/${file}`,
      ),
    );

    const temp = tempFileOf(onnxDest);
    expect(Buffer.concat(written.get(temp)!)).toEqual(Buffer.from(content));
    expect(rename).toHaveBeenCalledWith(temp, onnxDest);
    expect(events).toContainEqual({ status: "progress", file: "onnx/model.onnx", progress: 100 });
    expect(events.at(-1)).toEqual({ status: "ready" });
  });
});
