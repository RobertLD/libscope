import { z } from "zod";
import { DatabaseError } from "../errors.js";

export function validateRow<T>(schema: z.ZodType<T>, row: unknown, context: string): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new DatabaseError(`DB row validation failed in ${context}: ${result.error.message}`);
  }
  return result.data;
}

export function validateRows<T>(schema: z.ZodType<T>, rows: unknown[], context: string): T[] {
  return rows.map((row) => validateRow(schema, row, context));
}
