import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateRow, validateRows } from "../../src/db/validate.js";
import { DatabaseError } from "../../src/errors.js";

const TestSchema = z.object({ id: z.string(), count: z.number() });

describe("validateRow (Zod)", () => {
  it("returns parsed data for a valid row", () => {
    const result = validateRow(TestSchema, { id: "abc", count: 5 }, "test");
    expect(result).toEqual({ id: "abc", count: 5 });
  });

  it("strips unknown keys", () => {
    const result = validateRow(TestSchema, { id: "abc", count: 5, extra: true }, "test");
    expect(result).toEqual({ id: "abc", count: 5 });
  });

  it("throws DatabaseError when a required field is missing", () => {
    expect(() => validateRow(TestSchema, { id: "abc" }, "myContext")).toThrow(DatabaseError);
    expect(() => validateRow(TestSchema, { id: "abc" }, "myContext")).toThrow("myContext");
  });

  it("throws DatabaseError when a field has the wrong type", () => {
    expect(() => validateRow(TestSchema, { id: "abc", count: "notANumber" }, "ctx")).toThrow(
      DatabaseError,
    );
  });

  it("throws DatabaseError for null input", () => {
    expect(() => validateRow(TestSchema, null, "ctx")).toThrow(DatabaseError);
  });

  it("throws DatabaseError for undefined input", () => {
    expect(() => validateRow(TestSchema, undefined, "ctx")).toThrow(DatabaseError);
  });

  it("works with optional schema", () => {
    const OptSchema = TestSchema.optional();
    expect(validateRow(OptSchema, undefined, "ctx")).toBeUndefined();
    expect(validateRow(OptSchema, { id: "x", count: 1 }, "ctx")).toEqual({ id: "x", count: 1 });
  });
});

describe("validateRows (Zod)", () => {
  it("returns parsed data for valid rows", () => {
    const rows = [
      { id: "a", count: 1 },
      { id: "b", count: 2 },
    ];
    expect(validateRows(TestSchema, rows, "test")).toEqual(rows);
  });

  it("returns empty array for empty input", () => {
    expect(validateRows(TestSchema, [], "test")).toEqual([]);
  });

  it("throws DatabaseError if any row is invalid", () => {
    const rows = [{ id: "a", count: 1 }, { id: "b" }];
    expect(() => validateRows(TestSchema, rows, "ctx")).toThrow(DatabaseError);
  });
});
