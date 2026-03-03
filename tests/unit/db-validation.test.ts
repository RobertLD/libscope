import { describe, it, expect } from "vitest";
import { validateRow, validateCountRow } from "../../src/utils/db-validation.js";
import { DatabaseError } from "../../src/errors.js";

describe("validateRow", () => {
  it("returns the row when all required keys are present", () => {
    const row = { name: "test", age: 42 };
    const result = validateRow<{ name: string; age: number }>(row, ["name", "age"], "test");
    expect(result).toEqual({ name: "test", age: 42 });
  });

  it("throws DatabaseError for null input", () => {
    expect(() => validateRow(null, ["id"], "test")).toThrow(DatabaseError);
    expect(() => validateRow(null, ["id"], "test")).toThrow("Expected a row object");
  });

  it("throws DatabaseError for undefined input", () => {
    expect(() => validateRow(undefined, ["id"], "test")).toThrow(DatabaseError);
    expect(() => validateRow(undefined, ["id"], "test")).toThrow("Expected a row object");
  });

  it("throws DatabaseError for non-object input (string)", () => {
    expect(() => validateRow("not an object", ["id"], "test")).toThrow(DatabaseError);
    expect(() => validateRow("not an object", ["id"], "test")).toThrow("got string");
  });

  it("throws DatabaseError for non-object input (number)", () => {
    expect(() => validateRow(42, ["id"], "test")).toThrow(DatabaseError);
    expect(() => validateRow(42, ["id"], "test")).toThrow("got number");
  });

  it("throws DatabaseError when a required key is missing", () => {
    const row = { name: "test" };
    expect(() => validateRow(row, ["name", "age"], "user row")).toThrow(DatabaseError);
    expect(() => validateRow(row, ["name", "age"], "user row")).toThrow(
      "Missing expected column 'age'",
    );
  });

  it("includes context in error message", () => {
    expect(() => validateRow(null, ["id"], "my-context")).toThrow("my-context");
  });

  it("succeeds with empty required keys", () => {
    const row = { a: 1 };
    const result = validateRow(row, [], "test");
    expect(result).toEqual({ a: 1 });
  });
});

describe("validateCountRow", () => {
  it("returns the count when cnt is a number", () => {
    const result = validateCountRow({ cnt: 42 }, "test count");
    expect(result).toBe(42);
  });

  it("returns zero when cnt is 0", () => {
    const result = validateCountRow({ cnt: 0 }, "test count");
    expect(result).toBe(0);
  });

  it("throws DatabaseError when cnt is a string", () => {
    expect(() => validateCountRow({ cnt: "42" }, "test count")).toThrow(DatabaseError);
    expect(() => validateCountRow({ cnt: "42" }, "test count")).toThrow("Expected numeric count");
  });

  it("throws DatabaseError when cnt is null", () => {
    expect(() => validateCountRow({ cnt: null }, "test count")).toThrow(DatabaseError);
    expect(() => validateCountRow({ cnt: null }, "test count")).toThrow("got object");
  });

  it("throws DatabaseError when cnt is undefined", () => {
    expect(() => validateCountRow({ cnt: undefined }, "test count")).toThrow(DatabaseError);
    expect(() => validateCountRow({ cnt: undefined }, "test count")).toThrow("got undefined");
  });

  it("throws DatabaseError for null row input", () => {
    expect(() => validateCountRow(null, "test")).toThrow(DatabaseError);
  });

  it("throws DatabaseError for row missing cnt key", () => {
    expect(() => validateCountRow({ other: 1 }, "test")).toThrow(DatabaseError);
    expect(() => validateCountRow({ other: 1 }, "test")).toThrow("Missing expected column 'cnt'");
  });
});
