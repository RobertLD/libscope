import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RegistryEntry } from "../../../src/registry/types.js";
import { isRegistryStale } from "../../../src/registry/sync.js";

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: "test-reg",
    url: "https://github.com/org/registry.git",
    syncInterval: 3600, // 1 hour
    priority: 1,
    lastSyncedAt: null,
    ...overrides,
  };
}

describe("registry stale-cache detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isRegistryStale", () => {
    it("should return true when lastSyncedAt is null (never synced)", () => {
      const entry = makeEntry({ lastSyncedAt: null });
      expect(isRegistryStale(entry)).toBe(true);
    });

    it("should return false when syncInterval is 0 (manual only)", () => {
      const entry = makeEntry({ syncInterval: 0, lastSyncedAt: null });
      expect(isRegistryStale(entry)).toBe(false);
    });

    it("should return false when syncInterval is negative", () => {
      const entry = makeEntry({ syncInterval: -1, lastSyncedAt: null });
      expect(isRegistryStale(entry)).toBe(false);
    });

    it("should return true when last sync was longer ago than syncInterval", () => {
      const now = new Date("2026-03-11T12:00:00.000Z");
      vi.setSystemTime(now);

      // Last synced 2 hours ago, interval is 1 hour
      const entry = makeEntry({
        syncInterval: 3600,
        lastSyncedAt: "2026-03-11T10:00:00.000Z",
      });
      expect(isRegistryStale(entry)).toBe(true);
    });

    it("should return false when last sync was within syncInterval", () => {
      const now = new Date("2026-03-11T12:00:00.000Z");
      vi.setSystemTime(now);

      // Last synced 30 minutes ago, interval is 1 hour
      const entry = makeEntry({
        syncInterval: 3600,
        lastSyncedAt: "2026-03-11T11:30:00.000Z",
      });
      expect(isRegistryStale(entry)).toBe(false);
    });

    it("should return true at exactly the boundary (1 ms past interval)", () => {
      // syncInterval = 60 seconds = 60000ms
      const entry = makeEntry({ syncInterval: 60 });
      const baseTime = new Date("2026-03-11T12:00:00.000Z");
      entry.lastSyncedAt = baseTime.toISOString();

      // Set time to 60001ms later (1ms past the boundary)
      vi.setSystemTime(new Date(baseTime.getTime() + 60001));
      expect(isRegistryStale(entry)).toBe(true);
    });

    it("should return false at exactly the boundary (exactly syncInterval)", () => {
      const entry = makeEntry({ syncInterval: 60 });
      const baseTime = new Date("2026-03-11T12:00:00.000Z");
      entry.lastSyncedAt = baseTime.toISOString();

      // Set time to exactly 60000ms later
      vi.setSystemTime(new Date(baseTime.getTime() + 60000));
      expect(isRegistryStale(entry)).toBe(false);
    });

    it("should handle very short syncInterval (1 second)", () => {
      const entry = makeEntry({ syncInterval: 1 });
      const baseTime = new Date("2026-03-11T12:00:00.000Z");
      entry.lastSyncedAt = baseTime.toISOString();

      vi.setSystemTime(new Date(baseTime.getTime() + 2000));
      expect(isRegistryStale(entry)).toBe(true);
    });

    it("should handle very large syncInterval (24 hours)", () => {
      const entry = makeEntry({ syncInterval: 86400 });
      const now = new Date("2026-03-11T12:00:00.000Z");
      vi.setSystemTime(now);

      // Synced 12 hours ago — still fresh
      entry.lastSyncedAt = "2026-03-11T00:00:00.000Z";
      expect(isRegistryStale(entry)).toBe(false);

      // Synced 25 hours ago — stale
      entry.lastSyncedAt = "2026-03-10T11:00:00.000Z";
      expect(isRegistryStale(entry)).toBe(true);
    });
  });
});
