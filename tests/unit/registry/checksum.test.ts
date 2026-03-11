import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initLogger } from "../../../src/logger.js";
import {
  computeChecksum,
  computePackChecksum,
  writeChecksumFile,
  readChecksumFile,
  verifyChecksum,
} from "../../../src/registry/checksum.js";

describe("registry checksum", () => {
  let tempDir: string;

  beforeEach(() => {
    initLogger("silent");
    tempDir = mkdtempSync(join(tmpdir(), "libscope-checksum-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computeChecksum", () => {
    it("should produce a deterministic checksum for the same file content", async () => {
      const filePath = join(tempDir, "test.json");
      writeFileSync(filePath, '{"name":"test"}', "utf-8");

      const hash1 = await computeChecksum(filePath);
      const hash2 = await computeChecksum(filePath);
      expect(hash1).toBe(hash2);
    });

    it("should produce different checksums for different content", async () => {
      const file1 = join(tempDir, "a.json");
      const file2 = join(tempDir, "b.json");
      writeFileSync(file1, '{"name":"a"}', "utf-8");
      writeFileSync(file2, '{"name":"b"}', "utf-8");

      expect(await computeChecksum(file1)).not.toBe(await computeChecksum(file2));
    });

    it("should return a 64-character hex string (SHA-256)", async () => {
      const filePath = join(tempDir, "test.json");
      writeFileSync(filePath, "content", "utf-8");

      const hash = await computeChecksum(filePath);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should throw for non-existent file", async () => {
      await expect(computeChecksum(join(tempDir, "nonexistent.json"))).rejects.toThrow(
        /File not found/,
      );
    });

    it("should handle empty file", async () => {
      const filePath = join(tempDir, "empty.json");
      writeFileSync(filePath, "", "utf-8");

      const hash = await computeChecksum(filePath);
      expect(hash).toHaveLength(64);
    });

    it("should handle large content", async () => {
      const filePath = join(tempDir, "large.json");
      writeFileSync(filePath, "x".repeat(10_000_000), "utf-8");

      const hash = await computeChecksum(filePath);
      expect(hash).toHaveLength(64);
    });
  });

  describe("computePackChecksum", () => {
    it("should produce a deterministic checksum for the same object", () => {
      const data = { name: "test", version: "1.0.0" };
      expect(computePackChecksum(data)).toBe(computePackChecksum(data));
    });

    it("should be key-order-independent (sorted keys)", () => {
      const a = { name: "test", version: "1.0.0" };
      const b = { version: "1.0.0", name: "test" };
      expect(computePackChecksum(a)).toBe(computePackChecksum(b));
    });

    it("should produce different checksums for different content", () => {
      const a = { name: "pack-a" };
      const b = { name: "pack-b" };
      expect(computePackChecksum(a)).not.toBe(computePackChecksum(b));
    });

    it("should return a 64-character hex string", () => {
      const hash = computePackChecksum({ name: "test" });
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("writeChecksumFile / readChecksumFile", () => {
    it("should round-trip a checksum value", () => {
      const checksumPath = join(tempDir, "checksum.sha256");
      const value = "abcdef1234567890".repeat(4);

      writeChecksumFile(checksumPath, value);
      const read = readChecksumFile(checksumPath);
      expect(read).toBe(value);
    });

    it("should return null for non-existent file", () => {
      expect(readChecksumFile(join(tempDir, "nope.sha256"))).toBeNull();
    });

    it("should write with trailing newline", () => {
      const checksumPath = join(tempDir, "cs.sha256");
      writeChecksumFile(checksumPath, "abc");
      const raw = readFileSync(checksumPath, "utf-8");
      expect(raw).toBe("abc\n");
    });
  });

  describe("verifyChecksum", () => {
    it("should return true when checksum matches", async () => {
      const filePath = join(tempDir, "good.json");
      writeFileSync(filePath, "pack content", "utf-8");
      const expected = await computeChecksum(filePath);

      expect(await verifyChecksum(filePath, expected)).toBe(true);
    });

    it("should throw when checksum does not match", async () => {
      const filePath = join(tempDir, "bad.json");
      writeFileSync(filePath, "pack content", "utf-8");

      await expect(verifyChecksum(filePath, "wrong_checksum_value")).rejects.toThrow(
        /Checksum verification failed/,
      );
    });

    it("should throw with informative message including file path", async () => {
      const filePath = join(tempDir, "tampered.json");
      writeFileSync(filePath, "original", "utf-8");
      const originalChecksum = await computeChecksum(filePath);

      // Tamper with file
      writeFileSync(filePath, "tampered", "utf-8");

      await expect(verifyChecksum(filePath, originalChecksum)).rejects.toThrow(filePath);
    });

    it("should detect even single-byte changes", async () => {
      const filePath = join(tempDir, "exact.json");
      writeFileSync(filePath, "hello world", "utf-8");
      const hash = await computeChecksum(filePath);

      writeFileSync(filePath, "hello worlD", "utf-8");
      await expect(verifyChecksum(filePath, hash)).rejects.toThrow(/Checksum verification failed/);
    });
  });
});
