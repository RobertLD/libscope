/**
 * Checksum generation and verification for registry packs.
 * Uses SHA-256 of sorted file contents for deterministic hashing.
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, existsSync } from "node:fs";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";

/**
 * Compute SHA-256 checksum of a pack file's contents using streaming.
 * Pipes the file through crypto.createHash to avoid loading the entire file into memory.
 */
export async function computeChecksum(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new ValidationError(`File not found: ${filePath}`);
  }
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Compute a deterministic SHA-256 checksum from a JSON pack object.
 * Sorts keys to ensure deterministic output regardless of property order.
 */
export function computePackChecksum(packData: unknown): string {
  const json = JSON.stringify(packData, Object.keys(packData as object).sort(), 0);
  return createHash("sha256").update(json, "utf-8").digest("hex");
}

/**
 * Write a checksum file at the given path.
 */
export function writeChecksumFile(checksumPath: string, checksum: string): void {
  writeFileSync(checksumPath, checksum + "\n", "utf-8");
}

/**
 * Read a checksum from a checksum file.
 */
export function readChecksumFile(checksumPath: string): string | null {
  if (!existsSync(checksumPath)) return null;
  return readFileSync(checksumPath, "utf-8").trim();
}

/**
 * Verify a pack file against its expected checksum.
 * Returns true if valid, throws on mismatch.
 */
export async function verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
  const log = getLogger();
  const actual = await computeChecksum(filePath);

  if (actual !== expectedChecksum) {
    log.error({ filePath, expected: expectedChecksum, actual }, "Checksum verification failed");
    throw new ValidationError(
      `Checksum verification failed for "${filePath}": ` +
        `expected ${expectedChecksum}, got ${actual}. ` +
        "The pack file may have been tampered with or corrupted.",
    );
  }

  log.debug({ filePath, checksum: actual }, "Checksum verified");
  return true;
}
