import { DatabaseError } from "../errors.js";

/**
 * Validate that a database row has the expected properties.
 * Throws DatabaseError if any required key is missing.
 */
export function validateRow<T extends Record<string, unknown>>(
  row: unknown,
  requiredKeys: string[],
  context: string,
): T {
  if (row == null || typeof row !== "object") {
    throw new DatabaseError(`Expected a row object for ${context}, got ${typeof row}`);
  }
  const record = row as Record<string, unknown>;
  for (const key of requiredKeys) {
    if (!(key in record)) {
      throw new DatabaseError(`Missing expected column '${key}' in ${context}`);
    }
  }
  return record as T;
}

/**
 * Validate that a count query result has a numeric `cnt` property.
 */
export function validateCountRow(row: unknown, context: string): number {
  const validated = validateRow<{ cnt: unknown }>(row, ["cnt"], context);
  if (typeof validated.cnt !== "number") {
    throw new DatabaseError(`Expected numeric count for ${context}, got ${typeof validated.cnt}`);
  }
  return validated.cnt;
}
