import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createLite, ValidationError, type LibScope } from "../../src/lite/index.js";
import { initLogger } from "../../src/logger.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";

/**
 * Integration test: the libscope/lite preset end to end on a real in-memory SQLite database
 * with MockEmbeddingProvider: add -> search -> ask (passthrough context) -> rate -> delete.
 */
describe("libscope/lite integration", () => {
  let scope: LibScope;

  const corpus = [
    {
      title: "React useState Hook",
      content:
        "The useState hook lets you add state to functional components. " +
        "Call useState with the initial state value and it returns an array with " +
        "the current state and a setter function. Re-renders happen when state changes.",
      library: "react",
    },
    {
      title: "React useEffect Hook",
      content:
        "useEffect runs side effects in functional components. " +
        "Pass a function and a dependency array. The effect re-runs when dependencies change. " +
        "Return a cleanup function for subscriptions or timers.",
      library: "react",
    },
    {
      title: "TypeScript Generics",
      content:
        "Generics allow creating reusable components that work with multiple types. " +
        "Use angle brackets <T> to declare type parameters. " +
        "Constraints narrow what types are accepted using the extends keyword.",
    },
    {
      title: "Node.js Event Loop",
      content:
        "The Node.js event loop processes callbacks in phases: timers, pending, idle, " +
        "poll, check, and close. setTimeout and setInterval run in the timers phase. " +
        "setImmediate runs in the check phase, after I/O callbacks.",
    },
  ];

  beforeAll(async () => {
    initLogger("silent");
    scope = createLite({
      dbPath: ":memory:",
      provider: new MockEmbeddingProvider(),
      config: { llm: { provider: "passthrough" } },
    });
    await Promise.all(corpus.map((doc) => scope.add(doc)));
  });

  afterAll(() => {
    scope.close();
  });

  it("search returns chunk results with document IDs", async () => {
    const { items, total } = await scope.search({ query: "generics", limit: 2 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(2);
    expect(total).toBeGreaterThanOrEqual(items.length);
    const r = items[0]!;
    expect(typeof r.documentId).toBe("string");
    expect(typeof r.chunkId).toBe("string");
    expect(typeof r.score).toBe("number");
  });

  it("filters by library", async () => {
    const { items } = await scope.search({ query: "functional components", library: "react" });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((r) => r.library === "react")).toBe(true);
  });

  it("ask in passthrough mode returns the context prompt and sources", async () => {
    const result = await scope.ask("How does the Node.js event loop work?");
    expect(result.mode).toBe("context");
    if (result.mode === "context") {
      expect(result.contextPrompt).toContain("event loop");
      expect(result.sources.length).toBeGreaterThan(0);
    }
  });

  it("rates, rejects an invalid rating, and deletes", async () => {
    const { items } = await scope.search("React hooks");
    const documentId = items[0]!.documentId;
    await scope.docs.rate({ documentId, rating: 5 });
    await expect(scope.docs.rate({ documentId, rating: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await scope.docs.get({ documentId })).ratings.totalRatings).toBe(1);

    await scope.docs.delete({ documentId });
    expect((await scope.docs.list()).total).toBe(corpus.length - 1);
  });
});
