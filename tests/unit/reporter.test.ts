import { describe, it, expect, vi } from "vitest";
import { createProgressLine, formatProgress } from "../../src/cli/reporter.js";

function fakeStream(isTTY: boolean): { stream: NodeJS.WriteStream; written: string[] } {
  const written: string[] = [];
  const stream = {
    isTTY,
    columns: 60,
    write: vi.fn((s: string) => {
      written.push(s);
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  return { stream, written };
}

describe("formatProgress", () => {
  it("shows a bar, percent and counts when the total is known", () => {
    const line = formatProgress({ done: 5, total: 10, message: "docs/a.md" });
    expect(line).toContain("50% (5/10) docs/a.md");
    expect(line).toContain("█".repeat(10) + "░".repeat(10));
  });

  it("shows only the count without a total, and shortens long labels", () => {
    const line = formatProgress({ done: 3, message: "x".repeat(80) });
    expect(line.startsWith("(3) ...")).toBe(true);
    expect(line.length).toBeLessThan(60);
  });
});

describe("createProgressLine", () => {
  it("writes and clears one line on a terminal", () => {
    const { stream, written } = fakeStream(true);
    const progress = createProgressLine(stream);
    progress.update({ done: 1, total: 2 });
    progress.clear();
    expect(written).toHaveLength(2);
    expect(written[0]?.startsWith("\r[")).toBe(true);
    expect(written[1]?.trim()).toBe("");
  });

  it("writes nothing when the stream is not a terminal", () => {
    const { stream, written } = fakeStream(false);
    const progress = createProgressLine(stream);
    progress.update({ done: 1, total: 2 });
    progress.clear();
    expect(written).toEqual([]);
  });
});
