/** Shared input fields, so every operation uses the same names, limits and descriptions. */
import { z } from "zod";
import { SOURCE_TYPES } from "../indexing.js";

export const documentId = z.string().min(1).describe("Document ID");
export const chunkId = z.string().min(1).describe("Chunk ID");
export const sourceType = z.enum(SOURCE_TYPES).describe("Document source type");
export const topic = z.string().min(1).describe("Topic ID or name");
export const library = z.string().min(1).describe("Library name");
export const version = z.string().min(1).describe("Library version");
export const tags = z.array(z.string().min(1)).describe("Tag names");
export const url = z.url({ protocol: /^https?$/ }).describe("http(s) URL");

/** `schema.optional()` keeping its description (zod does not copy it to the wrapper). */
export function opt<T extends z.ZodType>(schema: T): z.ZodOptional<T> {
  return schema.optional().describe(schema.description ?? "");
}

/** `limit` with a default and maximum. */
export function limit(defaultValue: number, max: number): z.ZodDefault<z.ZodNumber> {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(defaultValue)
    .describe(`Maximum results (default ${defaultValue}, max ${max})`);
}

export const offset = z.number().int().min(0).default(0).describe("Results to skip (paging)");

/** Filters shared by search, ask and list-documents. */
export const documentFilters = {
  topic: opt(topic),
  library: opt(library),
  version: opt(version),
  sourceType: opt(sourceType),
  tags: tags.optional().describe("Only documents carrying all of these tags"),
};
