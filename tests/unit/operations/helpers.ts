import type Database from "better-sqlite3";
import { expect } from "vitest";
import type { z } from "zod";
import type { LibScopeConfig } from "../../../src/config.js";
import { indexDocument } from "../../../src/core/indexing.js";
import {
  createOperationContext,
  runOperation,
  type Operation,
  type OperationContext,
  type Surface,
} from "../../../src/core/operations/index.js";
import type { LlmProvider } from "../../../src/core/rag.js";
import { ValidationError } from "../../../src/errors.js";
import { createTestDb } from "../../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../../fixtures/mock-provider.js";

/** Minimal config for operation tests (no files read). */
export function testConfig(llmProvider?: string): LibScopeConfig {
  return {
    embedding: { provider: "local" },
    llm: llmProvider ? { provider: llmProvider } : {},
    database: {},
    indexing: { maxDocumentSize: 1_000_000, allowPrivateUrls: false, allowSelfSignedCerts: false },
    logging: { level: "silent" },
  } as LibScopeConfig;
}

export interface TestContext {
  db: Database.Database;
  provider: MockEmbeddingProvider;
  ctx: OperationContext;
}

export function makeContext(
  options: {
    db?: Database.Database;
    surface?: Surface;
    llm?: LlmProvider | null;
    config?: LibScopeConfig;
  } = {},
): TestContext {
  const db = options.db ?? createTestDb();
  const provider = new MockEmbeddingProvider();
  const ctx = createOperationContext({
    db,
    provider,
    config: options.config ?? testConfig(),
    surface: options.surface ?? "cli",
    // Default: no LLM. Pass `llm: undefined` explicitly to use the configured one.
    llm: "llm" in options ? options.llm : null,
  });
  return { db, provider, ctx };
}

/** Run an operation with raw (unvalidated) input. */
export function run<S extends z.ZodObject, O>(
  op: Operation<S, O>,
  ctx: OperationContext,
  input: unknown = {},
): Promise<O> {
  return runOperation(op, ctx, input);
}

export async function expectValidationError(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ValidationError);
}

/** Index a small document and return its ID. */
export async function addDoc(
  t: TestContext,
  title: string,
  content = `${title} body text about testing operations`,
  extra: { library?: string; topicId?: string } = {},
): Promise<string> {
  const doc = await indexDocument(t.db, t.provider, {
    title,
    content,
    sourceType: extra.library ? "library" : "manual",
    ...extra,
  });
  return doc.id;
}
