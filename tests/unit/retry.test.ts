import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../src/utils/retry.js";

describe("withRetry", () => {
  it("should return result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and succeed", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should throw after max retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("should use default options", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries (default)
  });

  it("should handle non-Error thrown values", async () => {
    const fn = vi.fn().mockRejectedValueOnce("string error").mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
  });
});
