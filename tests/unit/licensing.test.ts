import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateKeyPair,
  createLicenseKey,
  verifyLicenseKey,
  isExpired,
  type LicensePayload,
} from "../../src/licensing/keys.js";
import { hasFeature, getTierName, TIER_FEATURES } from "../../src/licensing/features.js";
import {
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
  requireFeature,
  isFeatureAvailable,
  LicenseError,
} from "../../src/licensing/index.js";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function createTestPayload(overrides?: Partial<LicensePayload>): LicensePayload {
  return {
    tier: "pro",
    org: "TestOrg",
    email: "test@example.com",
    features: ["core", "mcp", "cli", "packs_basic", "connectors", "api_server", "packs_unlimited"],
    exp: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    iat: new Date().toISOString(),
    ...overrides,
  };
}

describe("License Key Generation and Verification", () => {
  it("should generate a valid Ed25519 key pair", () => {
    const { publicKey, privateKey } = generateKeyPair();
    expect(publicKey).toContain("BEGIN PUBLIC KEY");
    expect(privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("should create and verify a license key", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const payload = createTestPayload();
    const encoded = createLicenseKey(payload, privateKey);

    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);

    const verified = verifyLicenseKey(encoded, publicKey);
    expect(verified).not.toBeNull();
    expect(verified!.tier).toBe("pro");
    expect(verified!.org).toBe("TestOrg");
    expect(verified!.email).toBe("test@example.com");
  });

  it("should reject a tampered license key", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const payload = createTestPayload();
    const encoded = createLicenseKey(payload, privateKey);

    // Tamper with the encoded key
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as {
      payload: LicensePayload;
      signature: string;
    };
    decoded.payload.tier = "enterprise";
    const tampered = Buffer.from(JSON.stringify(decoded), "utf-8").toString("base64");

    const result = verifyLicenseKey(tampered, publicKey);
    expect(result).toBeNull();
  });

  it("should reject an invalid base64 string", () => {
    const { publicKey } = generateKeyPair();
    const result = verifyLicenseKey("not-valid-base64!!!", publicKey);
    expect(result).toBeNull();
  });

  it("should reject a key verified with wrong public key", () => {
    const keyPair1 = generateKeyPair();
    const keyPair2 = generateKeyPair();
    const payload = createTestPayload();
    const encoded = createLicenseKey(payload, keyPair1.privateKey);

    const result = verifyLicenseKey(encoded, keyPair2.publicKey);
    expect(result).toBeNull();
  });

  it("should reject malformed JSON", () => {
    const { publicKey } = generateKeyPair();
    const badKey = Buffer.from("not json", "utf-8").toString("base64");
    expect(verifyLicenseKey(badKey, publicKey)).toBeNull();
  });

  it("should reject missing payload fields", () => {
    const { publicKey } = generateKeyPair();
    const incomplete = Buffer.from(
      JSON.stringify({ payload: { tier: "pro" }, signature: "abc" }),
      "utf-8",
    ).toString("base64");
    expect(verifyLicenseKey(incomplete, publicKey)).toBeNull();
  });
});

describe("License Expiration", () => {
  it("should detect expired license", () => {
    const payload = createTestPayload({
      exp: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isExpired(payload)).toBe(true);
  });

  it("should detect valid license", () => {
    const payload = createTestPayload({
      exp: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(isExpired(payload)).toBe(false);
  });
});

describe("Feature Gates", () => {
  it("should grant free tier features", () => {
    expect(hasFeature("free", "core")).toBe(true);
    expect(hasFeature("free", "mcp")).toBe(true);
    expect(hasFeature("free", "cli")).toBe(true);
    expect(hasFeature("free", "packs_basic")).toBe(true);
  });

  it("should deny pro features on free tier", () => {
    expect(hasFeature("free", "connectors")).toBe(false);
    expect(hasFeature("free", "api_server")).toBe(false);
  });

  it("should grant pro tier features", () => {
    expect(hasFeature("pro", "connectors")).toBe(true);
    expect(hasFeature("pro", "api_server")).toBe(true);
    expect(hasFeature("pro", "packs_unlimited")).toBe(true);
  });

  it("should deny enterprise features on pro tier", () => {
    expect(hasFeature("pro", "postgres")).toBe(false);
    expect(hasFeature("pro", "priority_support")).toBe(false);
  });

  it("should grant all features on enterprise tier", () => {
    expect(hasFeature("enterprise", "postgres")).toBe(true);
    expect(hasFeature("enterprise", "priority_support")).toBe(true);
    expect(hasFeature("enterprise", "core")).toBe(true);
  });

  it("should deny features for unknown tier", () => {
    expect(hasFeature("unknown", "core")).toBe(false);
  });

  it("should return correct tier names", () => {
    expect(getTierName("free")).toBe("Free");
    expect(getTierName("pro")).toBe("Pro");
    expect(getTierName("enterprise")).toBe("Enterprise");
    expect(getTierName("unknown")).toBe("Unknown");
  });

  it("should have correct feature counts per tier", () => {
    expect(TIER_FEATURES["free"]).toHaveLength(4);
    expect(TIER_FEATURES["pro"]).toHaveLength(7);
    expect(TIER_FEATURES["enterprise"]).toHaveLength(9);
  });
});

describe("License Manager Lifecycle", () => {
  const licenseDir = join(homedir(), ".libscope");
  const licensePath = join(licenseDir, "license.key");
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"];
    // Reset to free tier
    deactivateLicense();
  });

  afterEach(() => {
    // Clean up
    if (originalEnv !== undefined) {
      process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] = originalEnv;
    } else {
      delete process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"];
    }
    if (existsSync(licensePath)) {
      unlinkSync(licensePath);
    }
  });

  it("should default to free tier when no license", () => {
    const status = getLicenseStatus();
    expect(status.tier).toBe("free");
    expect(status.org).toBeUndefined();
    expect(status.expiresAt).toBeUndefined();
    expect(status.features).toEqual(TIER_FEATURES["free"]);
  });

  it("should activate a valid license", () => {
    const { publicKey, privateKey } = generateKeyPair();
    process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] = publicKey;

    const payload = createTestPayload();
    const key = createLicenseKey(payload, privateKey);
    const result = activateLicense(key);

    expect(result.success).toBe(true);
    expect(result.tier).toBe("pro");
    expect(result.error).toBeUndefined();

    const status = getLicenseStatus();
    expect(status.tier).toBe("pro");
    expect(status.org).toBe("TestOrg");
    expect(status.expiresAt).toBeDefined();
  });

  it("should reject expired license on activation", () => {
    const { publicKey, privateKey } = generateKeyPair();
    process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] = publicKey;

    const payload = createTestPayload({
      exp: new Date(Date.now() - 1000).toISOString(),
    });
    const key = createLicenseKey(payload, privateKey);
    const result = activateLicense(key);

    expect(result.success).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("should reject invalid license on activation", () => {
    const { publicKey } = generateKeyPair();
    process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] = publicKey;

    const result = activateLicense("invalid-key");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid");
  });

  it("should fail activation without public key", () => {
    delete process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"];
    const result = activateLicense("some-key");
    expect(result.success).toBe(false);
    expect(result.error).toContain("public key");
  });

  it("should deactivate and revert to free tier", () => {
    const { publicKey, privateKey } = generateKeyPair();
    process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] = publicKey;

    const payload = createTestPayload();
    const key = createLicenseKey(payload, privateKey);
    activateLicense(key);

    expect(getLicenseStatus().tier).toBe("pro");

    deactivateLicense();

    const status = getLicenseStatus();
    expect(status.tier).toBe("free");
    expect(status.org).toBeUndefined();
    expect(status.features).toEqual(TIER_FEATURES["free"]);
  });

  it("should store license file on activation", () => {
    const { publicKey, privateKey } = generateKeyPair();
    process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] = publicKey;

    const payload = createTestPayload();
    const key = createLicenseKey(payload, privateKey);
    activateLicense(key);

    expect(existsSync(licensePath)).toBe(true);
  });

  it("should remove license file on deactivation", () => {
    mkdirSync(licenseDir, { recursive: true });
    writeFileSync(licensePath, "dummy-key", "utf-8");

    deactivateLicense();
    expect(existsSync(licensePath)).toBe(false);
  });
});

describe("Feature Availability and Gating", () => {
  beforeEach(() => {
    deactivateLicense();
  });

  afterEach(() => {
    delete process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"];
  });

  it("should check feature availability on free tier", () => {
    expect(isFeatureAvailable("core")).toBe(true);
    expect(isFeatureAvailable("connectors")).toBe(false);
  });

  it("should check feature availability on pro tier", () => {
    const { publicKey, privateKey } = generateKeyPair();
    process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] = publicKey;
    const payload = createTestPayload({ tier: "pro" });
    const key = createLicenseKey(payload, privateKey);
    activateLicense(key);

    expect(isFeatureAvailable("connectors")).toBe(true);
    expect(isFeatureAvailable("postgres")).toBe(false);
  });

  it("should throw LicenseError when requiring unavailable feature", () => {
    expect(() => requireFeature("connectors")).toThrow(LicenseError);
  });

  it("should not throw when requiring available feature", () => {
    expect(() => requireFeature("core")).not.toThrow();
  });
});
