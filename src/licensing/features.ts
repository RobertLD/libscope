export type Feature =
  | "core"
  | "mcp"
  | "cli"
  | "packs_basic"
  | "connectors"
  | "api_server"
  | "packs_unlimited"
  | "postgres"
  | "priority_support";

export const TIER_FEATURES: Record<string, Feature[]> = {
  free: ["core", "mcp", "cli", "packs_basic"],
  pro: ["core", "mcp", "cli", "packs_basic", "connectors", "api_server", "packs_unlimited"],
  enterprise: [
    "core",
    "mcp",
    "cli",
    "packs_basic",
    "connectors",
    "api_server",
    "packs_unlimited",
    "postgres",
    "priority_support",
  ],
};

export function hasFeature(tier: string, feature: Feature): boolean {
  const features = TIER_FEATURES[tier];
  if (!features) return false;
  return features.includes(feature);
}

export function getTierName(tier: string): string {
  const names: Record<string, string> = {
    free: "Free",
    pro: "Pro",
    enterprise: "Enterprise",
  };
  return names[tier] ?? "Unknown";
}
