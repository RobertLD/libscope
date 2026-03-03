import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";
import { ValidationError } from "../errors.js";
import { deleteDocument, listDocuments } from "./documents.js";
import { addTagsToDocument, removeTagFromDocument, getDocumentTags } from "./tags.js";

export interface BulkSelector {
  topicId?: string;
  tags?: string[];
  library?: string;
  sourceType?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface BulkResult {
  affected: number;
  documentIds: string[];
}

/** Max batch size safety limit to prevent mass accidents. */
const MAX_BATCH_SIZE = 1000;

function isSelectorEmpty(selector: BulkSelector): boolean {
  return (
    !selector.topicId &&
    (!selector.tags || selector.tags.length === 0) &&
    !selector.library &&
    !selector.sourceType &&
    !selector.dateFrom &&
    !selector.dateTo
  );
}

/** Resolve a selector to matching document IDs. */
export function resolveSelector(
  db: Database.Database,
  selector: BulkSelector,
  limit?: number,
): string[] {
  if (isSelectorEmpty(selector)) {
    throw new ValidationError("Bulk selector must specify at least one filter criterion");
  }

  const effectiveLimit = Math.max(0, Math.min(limit ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE));

  if (effectiveLimit === 0) {
    return [];
  }

  // Use listDocuments for basic filters
  const docs = listDocuments(db, {
    library: selector.library,
    topicId: selector.topicId,
    sourceType: selector.sourceType,
    limit: effectiveLimit,
  });

  let ids = docs.map((d) => d.id);

  // Build a Map for O(1) lookup instead of O(n) .find() per id
  const docMap = new Map(docs.map((d) => [d.id, d]));

  // Apply date filters
  if (selector.dateFrom) {
    const from = selector.dateFrom;
    ids = ids.filter((id) => {
      const doc = docMap.get(id);
      return doc != null && doc.createdAt >= from;
    });
  }
  if (selector.dateTo) {
    const to = selector.dateTo;
    ids = ids.filter((id) => {
      const doc = docMap.get(id);
      return doc != null && doc.createdAt <= to;
    });
  }

  // Apply tag filter (AND logic — document must have ALL specified tags)
  if (selector.tags && selector.tags.length > 0) {
    const requiredTags = selector.tags.map((t) => t.trim().toLowerCase());
    // Batch query: fetch tags for all candidate documents in one query
    const placeholders = ids.map(() => "?").join(", ");
    const tagRows =
      ids.length > 0
        ? (db
            .prepare(
              `SELECT dt.document_id, t.name
             FROM tags t
             JOIN document_tags dt ON dt.tag_id = t.id
             WHERE dt.document_id IN (${placeholders})`,
            )
            .all(...ids) as Array<{ document_id: string; name: string }>)
        : [];
    const tagsByDoc = new Map<string, string[]>();
    for (const row of tagRows) {
      const existing = tagsByDoc.get(row.document_id);
      if (existing) {
        existing.push(row.name);
      } else {
        tagsByDoc.set(row.document_id, [row.name]);
      }
    }
    ids = ids.filter((id) => {
      const docTags = tagsByDoc.get(id) ?? [];
      return requiredTags.every((rt) => docTags.includes(rt));
    });
  }

  return ids.slice(0, effectiveLimit);
}

/** Delete all documents matching selector. If dryRun, return what WOULD be deleted. */
export function bulkDelete(
  db: Database.Database,
  selector: BulkSelector,
  dryRun?: boolean,
): BulkResult {
  const log = getLogger();
  const ids = resolveSelector(db, selector);

  if (!dryRun) {
    const deleteAll = db.transaction(() => {
      for (const id of ids) {
        deleteDocument(db, id);
      }
    });
    deleteAll();
    log.info({ count: ids.length, dryRun: false }, "Bulk delete completed");
  } else {
    log.info({ count: ids.length, dryRun: true }, "Bulk delete dry run");
  }

  return { affected: ids.length, documentIds: ids };
}

/** Add/remove tags from matching documents. */
export function bulkRetag(
  db: Database.Database,
  selector: BulkSelector,
  addTags?: string[],
  removeTags?: string[],
  dryRun?: boolean,
): BulkResult {
  const log = getLogger();

  if ((!addTags || addTags.length === 0) && (!removeTags || removeTags.length === 0)) {
    throw new ValidationError("At least one of addTags or removeTags must be specified");
  }

  const ids = resolveSelector(db, selector);

  if (!dryRun) {
    const retagAll = db.transaction(() => {
      for (const id of ids) {
        if (addTags && addTags.length > 0) {
          addTagsToDocument(db, id, addTags);
        }
        if (removeTags && removeTags.length > 0) {
          const docTags = getDocumentTags(db, id);
          for (const tagName of removeTags) {
            const normalized = tagName.trim().toLowerCase();
            const tag = docTags.find((t) => t.name === normalized);
            if (tag) {
              removeTagFromDocument(db, id, tag.id);
            }
          }
        }
      }
    });
    retagAll();
    log.info({ count: ids.length, addTags, removeTags, dryRun: false }, "Bulk retag completed");
  } else {
    log.info({ count: ids.length, addTags, removeTags, dryRun: true }, "Bulk retag dry run");
  }

  return { affected: ids.length, documentIds: ids };
}

/** Move matching documents to a different topic. */
export function bulkMove(
  db: Database.Database,
  selector: BulkSelector,
  targetTopicId: string,
  dryRun?: boolean,
): BulkResult {
  const log = getLogger();
  const ids = resolveSelector(db, selector);

  if (!dryRun) {
    const moveAll = db.transaction(() => {
      const stmt = db.prepare(
        "UPDATE documents SET topic_id = ?, updated_at = datetime('now') WHERE id = ?",
      );
      for (const id of ids) {
        stmt.run(targetTopicId, id);
      }
    });
    moveAll();
    log.info({ count: ids.length, targetTopicId, dryRun: false }, "Bulk move completed");
  } else {
    log.info({ count: ids.length, targetTopicId, dryRun: true }, "Bulk move dry run");
  }

  return { affected: ids.length, documentIds: ids };
}
