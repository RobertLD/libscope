import type { SearchResult } from "../core/search.js";
import type { DocumentLink, DocumentLinks } from "../core/links.js";

/** Join context chunks into a labelled block, or return "" when there are none. */
function formatContext(label: string, chunks: SearchResult["contextBefore"]): string {
  if (!chunks || chunks.length === 0) return "";
  return `\n**Context (${label}):**\n${chunks.map((c) => c.content).join("\n\n")}\n`;
}

/** Format one search-docs result, including the IDs that follow-up tools need. */
function formatSearchResult(r: SearchResult, index: number): string {
  const libraryVersion = r.version ? ` v${r.version}` : "";
  return (
    `## Result ${index + 1}: ${r.title} (score: ${r.score.toFixed(2)})\n` +
    `**Document ID:** ${r.documentId} | **Chunk ID:** ${r.chunkId}\n` +
    (r.library ? `**Library:** ${r.library}${libraryVersion}\n` : "") +
    (r.url ? `**Source:** ${r.url}\n` : "") +
    (r.avgRating ? `**Rating:** ${r.avgRating.toFixed(1)}/5\n` : "") +
    formatContext("before", r.contextBefore) +
    `\n${r.content}\n` +
    formatContext("after", r.contextAfter)
  );
}

/** Format the search-docs tool output. */
export function formatSearchResults(results: SearchResult[], totalCount: number): string {
  if (results.length === 0) return "No documents found matching your query.";
  return (
    `**Total results: ${totalCount}**\n\n` +
    results.map((r, i) => formatSearchResult(r, i)).join("\n---\n\n")
  );
}

/** Format the link-documents tool output, including the link ID needed by delete-link. */
export function formatLinkCreated(link: DocumentLink): string {
  const linkLabel = link.label ? ` — ${link.label}` : "";
  return (
    `✓ Link created: ${link.sourceId} → ${link.targetId} (${link.linkType})${linkLabel}\n` +
    `Link ID: ${link.id}`
  );
}

/** Format the get-document-links tool output, including each link's ID. */
export function formatDocumentLinks({ outgoing, incoming }: DocumentLinks): string {
  if (outgoing.length === 0 && incoming.length === 0) return "No links found for this document.";

  const lines: string[] = [];
  if (outgoing.length > 0) {
    lines.push("**Outgoing links:**");
    for (const l of outgoing) {
      const outLabel = l.label ? ` — ${l.label}` : "";
      lines.push(
        `  → [${l.linkType}] ${l.targetTitle} (${l.targetId})${outLabel} [link ID: ${l.id}]`,
      );
    }
  }
  if (incoming.length > 0) {
    lines.push("**Incoming links:**");
    for (const l of incoming) {
      const inLabel = l.label ? ` — ${l.label}` : "";
      lines.push(
        `  ← [${l.linkType}] ${l.sourceTitle} (${l.sourceId})${inLabel} [link ID: ${l.id}]`,
      );
    }
  }
  return lines.join("\n");
}
