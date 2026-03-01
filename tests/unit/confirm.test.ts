import { describe, it, expect, vi } from "vitest";
import { confirmAction } from "../../src/cli/confirm.js";
import { EventEmitter } from "node:events";

function createMockInterface(answer: string) {
  const emitter = new EventEmitter();
  return () =>
    ({
      question: vi.fn().mockResolvedValue(answer),
      close: vi.fn(),
      ...emitter,
    }) as never;
}

describe("confirmAction", () => {
  it("returns true immediately when yes flag is set", async () => {
    const result = await confirmAction("Delete?", true);
    expect(result).toBe(true);
  });

  it("returns true when user answers 'y'", async () => {
    const result = await confirmAction("Delete?", false, createMockInterface("y"));
    expect(result).toBe(true);
  });

  it("returns true when user answers 'yes'", async () => {
    const result = await confirmAction("Delete?", false, createMockInterface("yes"));
    expect(result).toBe(true);
  });

  it("returns true when user answers 'YES' (case-insensitive)", async () => {
    const result = await confirmAction("Delete?", false, createMockInterface("YES"));
    expect(result).toBe(true);
  });

  it("returns false when user answers 'n'", async () => {
    const result = await confirmAction("Delete?", false, createMockInterface("n"));
    expect(result).toBe(false);
  });

  it("returns false when user answers empty string", async () => {
    const result = await confirmAction("Delete?", false, createMockInterface(""));
    expect(result).toBe(false);
  });

  it("returns false when user answers arbitrary text", async () => {
    const result = await confirmAction("Delete?", false, createMockInterface("maybe"));
    expect(result).toBe(false);
  });

  it("closes the readline interface after prompting", async () => {
    const factory = createMockInterface("y");
    const rl = factory();
    await confirmAction("Delete?", false, () => rl);
    expect(rl.close).toHaveBeenCalled();
  });
});
