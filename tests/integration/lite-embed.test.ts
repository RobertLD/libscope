import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LibScopeLite } from "../../src/lite/index.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";

/**
 * Integration test: full LibScopeLite workflow.
 *
 * Uses a real in-memory SQLite database with MockEmbeddingProvider
 * to exercise the complete pipeline: indexBatch → search → getContext → rate.
 */
describe("LibScopeLite integration", () => {
  let lite: LibScopeLite;
  let provider: MockEmbeddingProvider;

  const corpus = [
    {
      title: "React useState Hook",
      content:
        "The useState hook lets you add state to functional components. " +
        "Call useState with the initial state value and it returns an array with " +
        "the current state and a setter function. Re-renders happen when state changes.",
    },
    {
      title: "React useEffect Hook",
      content:
        "useEffect runs side effects in functional components. " +
        "Pass a function and a dependency array. The effect re-runs when dependencies change. " +
        "Return a cleanup function for subscriptions or timers.",
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
    {
      title: "SQL Indexes",
      content:
        "Database indexes speed up queries by creating sorted data structures. " +
        "B-tree indexes are the default in most databases. " +
        "Composite indexes cover multiple columns and follow the leftmost prefix rule.",
    },
  ];

  beforeAll(async () => {
    provider = new MockEmbeddingProvider();
    lite = new LibScopeLite({ dbPath: ":memory:", provider });
    await lite.indexBatch(corpus, { concurrency: 2 });
  });

  afterAll(() => {
    lite.close();
  });

  describe("indexBatch → search", () => {
    it("should find indexed documents via search", async () => {
      const results = await lite.search("React hooks");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should return results with all expected fields", async () => {
      const results = await lite.search("generics");
      expect(results.length).toBeGreaterThan(0);

      const r = results[0]!;
      expect(typeof r.docId).toBe("string");
      expect(typeof r.chunkId).toBe("string");
      expect(typeof r.title).toBe("string");
      expect(typeof r.content).toBe("string");
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThan(0);
    });

    it("should respect the limit option", async () => {
      const results = await lite.search("Node.js", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should return results for different queries", async () => {
      const r1 = await lite.search("React useState");
      const r2 = await lite.search("SQL database index");

      expect(r1.length).toBeGreaterThan(0);
      expect(r2.length).toBeGreaterThan(0);
    });
  });

  describe("getContext", () => {
    it("should return a context prompt string containing relevant content", async () => {
      const context = await lite.getContext("How does the Node.js event loop work?");
      expect(typeof context).toBe("string");
      expect(context.length).toBeGreaterThan(0);
    });

    it("should include question in context", async () => {
      const context = await lite.getContext("What are TypeScript generics?");
      // The context prompt typically includes the question
      expect(context).toContain("TypeScript generics");
    });
  });

  describe("rate", () => {
    it("should rate a document found via search", async () => {
      const results = await lite.search("React hooks");
      expect(results.length).toBeGreaterThan(0);

      const docId = results[0]!.docId;
      // Should not throw
      lite.rate(docId, 5);
      lite.rate(docId, 3);
    });

    it("should reject invalid ratings", () => {
      // We need a valid doc ID first
      const rateInvalid = async (): Promise<void> => {
        const results = await lite.search("React");
        const docId = results[0]!.docId;
        lite.rate(docId, 0); // 0 is out of range
      };
      expect(rateInvalid()).rejects.toThrow();
    });
  });

  describe("full pipeline: index → search → getContext → rate", () => {
    it("should execute the complete workflow end-to-end", async () => {
      // 1. Index additional docs
      const extraLite = new LibScopeLite({ dbPath: ":memory:", provider: new MockEmbeddingProvider() });
      await extraLite.index([
        {
          title: "Docker Basics",
          content:
            "Docker containers package applications with their dependencies. " +
            "Images are built from Dockerfiles. Containers run as isolated processes.",
          library: "docker",
        },
        {
          title: "Kubernetes Pods",
          content:
            "Kubernetes pods are the smallest deployable units. " +
            "A pod can contain one or more containers sharing network and storage.",
          library: "kubernetes",
        },
      ]);

      // 2. Search
      const searchResults = await extraLite.search("Docker containers");
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0]!.title).toBeDefined();

      // 3. Get context
      const context = await extraLite.getContext("How does Docker work?");
      expect(context.length).toBeGreaterThan(0);

      // 4. Rate
      const docId = searchResults[0]!.docId;
      extraLite.rate(docId, 4);

      extraLite.close();
    });
  });
});
