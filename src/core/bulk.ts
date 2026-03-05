import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";
import { ValidationError } from "../errors.js";
import { deleteDocument, listDocuments } from "./documents.js";
import {
  addTagsToDocument,
  removeTagFromDocument,
  getDocumentTags,
  getDocumentTagsBatch,
} from "./tags.js";

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

  if (limit !== undefined && limit < 0) {
    throw new ValidationError("limit must be a non-negative integer");
  }

  const effectiveLimit = Math.max(0, Math.min(limit ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE));

  if (effectiveLimit === 0) {
    return [];
  }

  // Push date filters into the SQL query so they apply before LIMIT
  const docs = listDocuments(db, {
    library: selector.library,
    topicId: selector.topicId,
    sourceType: selector.sourceType,
    dateFrom: selector.dateFrom,
    dateTo: selector.dateTo,
    limit: effectiveLimit,
  });

  let ids = docs.map((d) => d.id);

  // Apply tag filter (AND logic — document must have ALL specified tags).
  // Fetch all tags in a single query instead of one query per document.
  if (selector.tags && selector.tags.length > 0) {
    const requiredTags = selector.tags.map((t) => t.trim().toLowerCase());
    const tagsByDoc = getDocumentTagsBatch(db, ids);
    ids = ids.filter((id) => {
      const docTags = (tagsByDoc.get(id) ?? []).map((t) => t.name);
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
