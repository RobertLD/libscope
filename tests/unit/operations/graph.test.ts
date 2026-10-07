import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { graphOperation } from "../../../src/core/operations/index.js";
import { createTopic } from "../../../src/core/topics.js";
import { initLogger } from "../../../src/logger.js";
import { addDoc, expectValidationError, makeContext, run, type TestContext } from "./helpers.js";

initLogger("silent");

describe("graph operation", () => {
  let t: TestContext;

  beforeEach(() => {
    t = makeContext();
  });

  afterEach(() => {
    t.db.close();
  });

  it("returns document and topic nodes, filtered by topic name", async () => {
    const topic = createTopic(t.db, { name: "Guides" });
    await addDoc(t, "In topic", undefined, { topicId: topic.id });
    await addDoc(t, "Elsewhere");

    const all = await run(graphOperation, t.ctx);
    expect(all.nodes.filter((n) => n.type === "document")).toHaveLength(2);

    const filtered = await run(graphOperation, t.ctx, { topic: "Guides" });
    const docs = filtered.nodes.filter((n) => n.type === "document");
    expect(docs.map((n) => n.label)).toEqual(["In topic"]);
  });

  it("rejects an out-of-range threshold", async () => {
    await expectValidationError(run(graphOperation, t.ctx, { threshold: 2 }));
  });
});
