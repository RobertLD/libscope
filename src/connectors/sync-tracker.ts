import type Database from "better-sqlite3";

export interface SyncStats {
  added: number;
  updated: number;
  deleted: number;
  errored: number;
}

export interface ConnectorSyncRow {
  id: number;
  connector_type: string;
  connector_name: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  docs_added: number;
  docs_updated: number;
  docs_deleted: number;
  docs_errored: number;
  error_message: string | null;
}

/** Record the start of a connector sync. Returns the sync row id. */
export function startSync(
  db: Database.Database,
  connectorType: string,
  connectorName: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO connector_syncs (connector_type, connector_name, started_at, status)
       VALUES (?, ?, datetime('now'), 'running')`,
    )
    .run(connectorType, connectorName);
  return Number(result.lastInsertRowid);
}

/** Record the successful completion of a connector sync. */
export function completeSync(db: Database.Database, syncId: number, stats: SyncStats): void {
  db.prepare(
    `UPDATE connector_syncs
     SET completed_at = datetime('now'),
         status = 'completed',
         docs_added = ?,
         docs_updated = ?,
         docs_deleted = ?,
         docs_errored = ?
     WHERE id = ?`,
  ).run(stats.added, stats.updated, stats.deleted, stats.errored, syncId);
}

/** Record a failed connector sync. */
export function failSync(db: Database.Database, syncId: number, error: string): void {
  db.prepare(
    `UPDATE connector_syncs
     SET completed_at = datetime('now'),
         status = 'failed',
         error_message = ?
     WHERE id = ?`,
  ).run(error, syncId);
}

/** Get the latest sync status per connector. Optionally filter by type and/or name. */
export function getConnectorStatus(
  db: Database.Database,
  connectorType?: string,
  connectorName?: string,
): ConnectorSyncRow[] {
  let sql = `
    SELECT cs.*
    FROM connector_syncs cs
    INNER JOIN (
      SELECT connector_type, connector_name, MAX(id) AS max_id
      FROM connector_syncs
  `;
  const params: string[] = [];
  const conditions: string[] = [];

  if (connectorType) {
    conditions.push("connector_type = ?");
    params.push(connectorType);
  }
  if (connectorName) {
    conditions.push("connector_name = ?");
    params.push(connectorName);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  sql += `
      GROUP BY connector_type, connector_name
    ) latest ON cs.id = latest.max_id
    ORDER BY cs.started_at DESC, cs.id DESC
  `;

  return db.prepare(sql).all(...params) as ConnectorSyncRow[];
}

/** Get recent sync history. Optionally filter by connector type and limit results. */
export function getSyncHistory(
  db: Database.Database,
  connectorType?: string,
  limit: number = 20,
): ConnectorSyncRow[] {
  if (connectorType) {
    return db
      .prepare(
        `SELECT * FROM connector_syncs WHERE connector_type = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(connectorType, limit) as ConnectorSyncRow[];
  }
  return db
    .prepare(`SELECT * FROM connector_syncs ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(limit) as ConnectorSyncRow[];
}
