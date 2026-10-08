import { describe, expect, it } from "vitest";
import { deriveRegistryName, validateGitUrl } from "../../src/registry/config.js";

describe("validateGitUrl credential check", () => {
  it.each([
    "https://user:pass@github.com/org/repo.git",
    "https://user:@github.com/org/repo.git",
    "https://token@github.com/org/repo.git",
    "https://github.com/org/repo?mirror=http://user@host",
    "https://github.com/x/http://a:b@host",
  ])("rejects %s", (url) => {
    expect(() => validateGitUrl(url)).toThrow(/embedded credentials/);
  });

  it.each([
    "https://github.com/org/repo.git",
    "https://github.com/org/repo@v1",
    "https://@github.com/org/repo.git",
    "ssh://git@host.example.com:7999/org/repo.git",
    "git@github.com:org/repo.git",
    "https://github.com/org/ftp://user@host",
  ])("accepts %s", (url) => {
    expect(() => validateGitUrl(url)).not.toThrow();
  });

  it("checks a long URL quickly", () => {
    const url = "https://" + "https://a".repeat(50_000);
    const started = Date.now();
    expect(validateGitUrl(url)).toBe(url);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("removes every trailing slash", () => {
    expect(validateGitUrl("https://github.com/org/repo.git///")).toBe(
      "https://github.com/org/repo.git",
    );
  });
});

describe("deriveRegistryName", () => {
  it("ignores trailing slashes", () => {
    expect(deriveRegistryName("https://github.com/org/packs.git//")).toBe("packs");
  });
});
