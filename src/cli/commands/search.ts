/** `libscope search` (including interactive mode) and `libscope ask`. */
import type { Command } from "commander";
import type { ListResult } from "../../core/operations/index.js";
import { askOperation, searchOperation } from "../../core/operations/index.js";
import type { AnswerResult } from "../../core/rag.js";
import type { SearchResult } from "../../core/search.js";
import { ValidationError } from "../../errors.js";
import { startInteractiveSearch } from "../repl.js";
import { addDocumentOptions, defined, documentInput, type DocumentFlags } from "../options.js";
import { isJsonOutput, libraryLabel, preview, run } from "../run.js";

/** One search hit: title, score, IDs, metadata and a content preview. */
export function printSearchItem(r: SearchResult): void {
  console.log(`\n── ${r.title} (score ${r.score.toFixed(2)})`);
  console.log(`   document ${r.documentId}  chunk ${r.chunkId}`);
  const meta = [r.library ? libraryLabel(r.library, r.version) : "", r.url ?? ""];
  const metaLine = meta.filter(Boolean).join(" | ");
  if (metaLine) console.log(`   ${metaLine}`);
  for (const c of r.contextBefore ?? []) console.log(`   ↑ ${preview(c.content, 120)}`);
  console.log(`   ${preview(r.content)}`);
  for (const c of r.contextAfter ?? []) console.log(`   ↓ ${preview(c.content, 120)}`);
}

export function printSearchResults(result: ListResult<SearchResult>): void {
  if (result.items.length === 0) {
    console.log("No results.");
    return;
  }
  const first = result.offset + 1;
  const last = result.offset + result.items.length;
  console.log(`Results ${first}-${last} of ${result.total}:`);
  result.items.forEach(printSearchItem);
}

function printAnswer(result: AnswerResult): void {
  if (result.mode === "context") {
    console.log("llm.provider is passthrough: no answer is generated. Context for the question:\n");
    console.log(result.contextPrompt);
  } else {
    console.log(`\n${result.answer}\n`);
  }
  if (result.sources.length > 0) {
    console.log("Sources:");
    for (const s of result.sources) {
      console.log(`  • ${s.title} (score ${s.score.toFixed(2)})  ${s.documentId}`);
    }
  }
  if (result.mode === "answer") {
    const tokens = result.tokensUsed === undefined ? "" : ` | tokens: ${result.tokensUsed}`;
    console.log(`\nModel: ${result.model}${tokens}`);
  }
}

interface SearchFlags extends DocumentFlags {
  related?: string;
  offset?: number;
  minRating?: number;
  maxPerDoc?: number;
  context?: number;
}

export function searchInput(
  query: string | undefined,
  flags: SearchFlags,
): Record<string, unknown> {
  return defined({
    query,
    relatedTo: flags.related,
    ...documentInput(flags),
    offset: flags.offset,
    minRating: flags.minRating,
    maxChunksPerDocument: flags.maxPerDoc,
    contextChunks: flags.context,
  });
}

interface AskFlags extends DocumentFlags {
  minRating?: number;
  model?: string;
}

export function askInput(question: string, flags: AskFlags): Record<string, unknown> {
  const { limit, ...filters } = documentInput(flags);
  return defined({ question, ...filters, minRating: flags.minRating, topK: limit });
}

export function register(program: Command): void {
  const search = program
    .command("search [query]")
    .description(
      "Search by meaning and keywords. With no query on a terminal, start interactive search",
    )
    .option("--related <id>", "Find content similar to this document or chunk ID instead");
  addDocumentOptions(search)
    .option("--offset <n>", "Results to skip (paging)", Number)
    .option("--min-rating <n>", "Only documents rated at least this (1-5)", Number)
    .option("--max-per-doc <n>", "At most this many chunks per document", Number)
    .option("--context <n>", "Neighbouring chunks to show around each result (0-2)", Number)
    .action(async (query: string | undefined, flags: SearchFlags) => {
      if (query === undefined && flags.related === undefined) {
        if (!process.stdin.isTTY || isJsonOutput()) {
          throw new ValidationError("Give a search query, or --related <documentId|chunkId>");
        }
        await startInteractiveSearch({
          onQuery: async (q) => {
            await run(searchOperation, searchInput(q, flags), printSearchResults, {
              embeddings: true,
            });
          },
        });
        return;
      }
      await run(searchOperation, searchInput(query, flags), printSearchResults, {
        embeddings: true,
      });
    });

  const ask = program
    .command("ask <question>")
    .description("Answer a question from the knowledge base with the configured LLM");
  addDocumentOptions(ask, { limit: "Chunks to use as context (default 5)" })
    .option("--min-rating <n>", "Only documents rated at least this (1-5)", Number)
    .option("--model <model>", "LLM model for this question (default: llm.model)");
  ask.action(async (question: string, flags: AskFlags) => {
    await run(askOperation, askInput(question, flags), printAnswer, {
      embeddings: true,
      configOverrides: flags.model === undefined ? undefined : { llm: { model: flags.model } },
    });
  });
}
