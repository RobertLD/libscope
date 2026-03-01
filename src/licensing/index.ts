import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "../logger.js";
import { LibScopeError } from "../errors.js";
import { verifyLicenseKey, isExpired } from "./keys.js";
import { hasFeature, TIER_FEATURES, type Feature } from "./features.js";

export { generateKeyPair, createLicenseKey, verifyLicenseKey, isExpired } from "./keys.js";
export type { LicensePayload, LicenseKey } from "./keys.js";
export { hasFeature, getTierName, TIER_FEATURES } from "./features.js";
export type { Feature } from "./features.js";

export class LicenseError extends LibScopeError {
  constructor(message: string, cause?: unknown) {
    super(message, "LICENSE_ERROR", cause);
    this.name = "LicenseError";
  }
}

const PUBLIC_KEY = ""; // Placeholder — set via env or config in production

let cachedTier: string = "free";
let cachedOrg: string | undefined;
let cachedExp: string | undefined;
let cachedFeatures: string[] = TIER_FEATURES["free"]!;

function getLicenseFilePath(): string {
  return join(homedir(), ".libscope", "license.key");
}

export function activateLicense(key: string): {
  success: boolean;
  tier: string;
  error: string | undefined;
} {
  const logger = getLogger();
  const publicKey = process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] ?? PUBLIC_KEY;

  if (!publicKey) {
    logger.warn("No license public key configured");
    return { success: false, tier: "free", error: "No license public key configured" };
  }

  const payload = verifyLicenseKey(key, publicKey);
  if (!payload) {
    logger.warn("Invalid license key");
    return { success: false, tier: "free", error: "Invalid or tampered license key" };
  }

  if (isExpired(payload)) {
    logger.warn("License key has expired");
    return { success: false, tier: "free", error: "License key has expired" };
  }

  const dir = join(homedir(), ".libscope");
  mkdirSync(dir, { recursive: true });
  writeFileSync(getLicenseFilePath(), key, "utf-8");

  cachedTier = payload.tier;
  cachedOrg = payload.org;
  cachedExp = payload.exp;
  cachedFeatures = payload.features;

  logger.info({ tier: payload.tier, org: payload.org }, "License activated");
  return { success: true, tier: payload.tier, error: undefined };
}

export function deactivateLicense(): void {
  const logger = getLogger();
  const filePath = getLicenseFilePath();

  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  cachedTier = "free";
  cachedOrg = undefined;
  cachedExp = undefined;
  cachedFeatures = TIER_FEATURES["free"]!;

  logger.info("License deactivated, reverted to free tier");
}

export function getLicenseStatus(): {
  tier: string;
  org: string | undefined;
  expiresAt: string | undefined;
  features: string[];
} {
  return {
    tier: cachedTier,
    org: cachedOrg,
    expiresAt: cachedExp,
    features: cachedFeatures,
  };
}

export function requireFeature(feature: Feature): void {
  if (!isFeatureAvailable(feature)) {
    throw new LicenseError(
      `Feature "${feature}" requires a higher license tier (current: ${cachedTier})`,
    );
  }
}

export function isFeatureAvailable(feature: Feature): boolean {
  return hasFeature(cachedTier, feature);
}

export function loadStoredLicense(): void {
  const logger = getLogger();
  const filePath = getLicenseFilePath();
  const publicKey = process.env["LIBSCOPE_LICENSE_PUBLIC_KEY"] ?? PUBLIC_KEY;

  if (!existsSync(filePath) || !publicKey) {
    cachedTier = "free";
    cachedOrg = undefined;
    cachedExp = undefined;
    cachedFeatures = TIER_FEATURES["free"]!;
    return;
  }

  try {
    const key = readFileSync(filePath, "utf-8").trim();
    const payload = verifyLicenseKey(key, publicKey);

    if (!payload || isExpired(payload)) {
      logger.warn("Stored license is invalid or expired, falling back to free tier");
      cachedTier = "free";
      cachedOrg = undefined;
      cachedExp = undefined;
      cachedFeatures = TIER_FEATURES["free"]!;
      return;
    }

    cachedTier = payload.tier;
    cachedOrg = payload.org;
    cachedExp = payload.exp;
    cachedFeatures = payload.features;
    logger.info({ tier: payload.tier }, "Loaded stored license");
  } catch (err: unknown) {
    logger.warn({ err }, "Failed to load stored license, falling back to free tier");
    cachedTier = "free";
    cachedOrg = undefined;
    cachedExp = undefined;
    cachedFeatures = TIER_FEATURES["free"]!;
  }
}
