import { describe, it, expect } from "vitest";
import { z } from "zod";
import { OPERATIONS, getOperation, runOperation } from "../../../src/core/operations/index.js";
import { ValidationError } from "../../../src/errors.js";
import { makeContext } from "./helpers.js";

describe("OPERATIONS", () => {
  it("has unique kebab-case names", () => {
    const names = OPERATIONS.map((op) => op.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });

  it("describes every input field", () => {
    const missing = OPERATIONS.flatMap((op) =>
      Object.entries(op.input.shape)
        .filter(([, schema]) => !(schema as z.ZodType).description)
        .map(([field]) => `${op.name}.${field}`),
    );
    expect(missing).toEqual([]);
  });

  it("maps every :param in an HTTP path to an input field, with unique routes", () => {
    const routes = new Set<string>();
    for (const op of OPERATIONS) {
      if (!op.http) continue;
      const route = `${op.http.method} ${op.http.path}`;
      expect(routes.has(route), route).toBe(false);
      routes.add(route);
      for (const segment of op.http.path.split("/")) {
        if (segment.startsWith(":")) expect(op.input.shape, route).toHaveProperty(segment.slice(1));
      }
    }
  });

  it("produces JSON Schema for every input (for MCP and OpenAPI)", () => {
    for (const op of OPERATIONS) {
      expect(() => z.toJSONSchema(op.input, { io: "input" }), op.name).not.toThrow();
    }
  });

  it("looks operations up by name", () => {
    expect(getOperation("search")?.group).toBe("search");
    expect(getOperation("nope")).toBeUndefined();
  });

  it("turns non-object input into a ValidationError naming the operation", async () => {
    const { db, ctx } = makeContext();
    try {
      const op = getOperation("get-document")!;
      await expect(runOperation(op, ctx, "doc-1")).rejects.toBeInstanceOf(ValidationError);
      await expect(runOperation(op, ctx, { documentId: 5 })).rejects.toThrow(
        "Invalid input for get-document: documentId:",
      );
    } finally {
      db.close();
    }
  });
});
