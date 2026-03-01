import { generateKeyPairSync, sign, verify } from "node:crypto";
import { getLogger } from "../logger.js";

export interface LicensePayload {
  tier: "free" | "pro" | "enterprise";
  org: string;
  email: string;
  features: string[];
  exp: string;
  iat: string;
}

export interface LicenseKey {
  payload: LicensePayload;
  signature: string;
}

export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export function createLicenseKey(payload: LicensePayload, privateKey: string): string {
  const payloadJson = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(payloadJson, "utf-8"), privateKey);
  const licenseKey: LicenseKey = {
    payload,
    signature: signature.toString("base64"),
  };
  return Buffer.from(JSON.stringify(licenseKey), "utf-8").toString("base64");
}

export function verifyLicenseKey(encodedKey: string, publicKey: string): LicensePayload | null {
  const logger = getLogger();
  try {
    const decoded = Buffer.from(encodedKey, "base64").toString("utf-8");
    const licenseKey: unknown = JSON.parse(decoded);

    if (!isLicenseKey(licenseKey)) {
      logger.warn("Invalid license key structure");
      return null;
    }

    const payloadJson = JSON.stringify(licenseKey.payload);
    const signatureBuffer = Buffer.from(licenseKey.signature, "base64");
    const isValid = verify(null, Buffer.from(payloadJson, "utf-8"), publicKey, signatureBuffer);

    if (!isValid) {
      logger.warn("License key signature verification failed");
      return null;
    }

    return licenseKey.payload;
  } catch (err: unknown) {
    logger.warn({ err }, "Failed to verify license key");
    return null;
  }
}

export function isExpired(payload: LicensePayload): boolean {
  const expDate = new Date(payload.exp);
  return expDate.getTime() <= Date.now();
}

function isLicenseKey(value: unknown): value is LicenseKey {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["signature"] !== "string") return false;
  if (typeof obj["payload"] !== "object" || obj["payload"] === null) return false;
  const payload = obj["payload"] as Record<string, unknown>;
  return (
    typeof payload["tier"] === "string" &&
    typeof payload["org"] === "string" &&
    typeof payload["email"] === "string" &&
    Array.isArray(payload["features"]) &&
    typeof payload["exp"] === "string" &&
    typeof payload["iat"] === "string"
  );
}
