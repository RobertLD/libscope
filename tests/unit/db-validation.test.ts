import { describe, it, expect } from "vitest";
import { validateRow, validateCountRow } from "../../src/utils/db-validation.js";

describe("db-validation", () => {
  describe("validateRow", () => {
    it("returns the row when all keys present", () => {
      const row = { id: "1", name: "test" };
      const result = validateRow<{ id: string; name: string }>(row, ["id", "name"], "test");
      expect(result.id).toBe("1");
    });

    it("throws when row is null", () => {
      expect(() => validateRow(null, ["id"], "test")).toThrow("Expected a row object");
    });

    it("throws when row is undefined", () => {
      expect(() => validateRow(undefined, ["id"], "test")).toThrow("Expected a row object");
    });

    it("throws when row is not an object", () => {
      expect(() => validateRow("string", ["id"], "test")).toThrow("Expected a row object");
    });

    it("throws when a required key is missing", () => {
      expect(() => validateRow({ id: "1" }, ["id", "name"], "test")).toThrow(
        "Missing expected column 'name'",
      );
    });
  });

  describe("validateCountRow", () => {
    it("returns the count when valid", () => {
      const result = validateCountRow({ cnt: 42 }, "test");
      expect(result).toBe(42);
    });

    it("throws when cnt is not a number", () => {
      expect(() => validateCountRow({ cnt: "not-a-number" }, "test")).toThrow(
        "Expected numeric count",
      );
    });
  });
});
