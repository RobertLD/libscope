import { describe, expect, it } from "vitest";
import { forEachSequential, mapSequential, runConcurrent } from "../../src/utils/async.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe("forEachSequential", () => {
  it("runs one call at a time, in order, with the index", async () => {
    const events: string[] = [];
    let running = 0;
    await forEachSequential(["a", "b", "c"], async (item, index) => {
      running++;
      expect(running).toBe(1);
      events.push(`start ${item}${index}`);
      await tick();
      events.push(`end ${item}${index}`);
      running--;
    });
    expect(events).toEqual(["start a0", "end a0", "start b1", "end b1", "start c2", "end c2"]);
  });

  it("stops at the first rejection", async () => {
    const seen: number[] = [];
    const run = forEachSequential([1, 2, 3], async (n) => {
      seen.push(n);
      await tick();
      if (n === 2) throw new Error("stop at 2");
    });
    await expect(run).rejects.toThrow("stop at 2");
    expect(seen).toEqual([1, 2]);
  });

  it("turns a synchronous throw into a rejection", async () => {
    const run = forEachSequential([1], () => {
      throw new Error("sync");
    });
    await expect(run).rejects.toThrow("sync");
  });

  it("accepts any iterable and resolves at once when it is empty", async () => {
    const seen: string[] = [];
    await forEachSequential(new Set(["x", "y"]), async (item) => {
      seen.push(item);
      await tick();
    });
    await forEachSequential([], () => Promise.reject(new Error("not called")));
    expect(seen).toEqual(["x", "y"]);
  });
});

describe("mapSequential", () => {
  it("resolves to the results in input order", async () => {
    const delays = [5, 1, 3];
    const results = await mapSequential(delays, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${index}:${ms}`;
    });
    expect(results).toEqual(["0:5", "1:1", "2:3"]);
  });

  it("returns an empty array for no items", async () => {
    await expect(mapSequential([], () => Promise.resolve(1))).resolves.toEqual([]);
  });
});

describe("runConcurrent", () => {
  it("keeps at most `concurrency` tasks in flight and preserves order", async () => {
    let running = 0;
    let maxRunning = 0;
    const tasks = [4, 1, 3, 2, 1].map((ms, i) => async (): Promise<number> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return i;
    });
    await expect(runConcurrent(tasks, 2)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(maxRunning).toBe(2);
  });

  it("handles more workers than tasks and an empty task list", async () => {
    const tasks = [(): Promise<string> => Promise.resolve("only")];
    await expect(runConcurrent(tasks, 5)).resolves.toEqual(["only"]);
    await expect(runConcurrent([], 3)).resolves.toEqual([]);
  });

  it("rejects when a task rejects", async () => {
    const tasks: Array<() => Promise<number>> = [
      (): Promise<number> => Promise.resolve(1),
      (): Promise<number> => Promise.reject(new Error("task failed")),
    ];
    await expect(runConcurrent(tasks, 2)).rejects.toThrow("task failed");
  });
});
