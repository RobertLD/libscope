import { adminOperations } from "./admin.js";
import { analyticsOperations } from "./analytics.js";
import { connectorOperations } from "./connectors.js";
import { documentOperations } from "./documents.js";
import { graphOperations } from "./graph.js";
import { linkOperations } from "./links.js";
import { packOperations } from "./packs.js";
import { registryOperations } from "./registries.js";
import { savedSearchOperations } from "./searches.js";
import { searchOperations } from "./search.js";
import { tagOperations } from "./tags.js";
import { taskOperations } from "./tasks.js";
import { topicOperations } from "./topics.js";
import type { Operation } from "./types.js";
import { webhookOperations } from "./webhooks.js";

export * from "./types.js";
export * from "./admin.js";
export * from "./analytics.js";
export * from "./connectors.js";
export * from "./documents.js";
export * from "./graph.js";
export * from "./links.js";
export * from "./packs.js";
export * from "./registries.js";
export * from "./searches.js";
export * from "./search.js";
export * from "./tags.js";
export * from "./tasks.js";
export * from "./topics.js";
export * from "./webhooks.js";

/** Every operation, grouped in the order surfaces list them. */
export const OPERATIONS: readonly Operation[] = [
  ...documentOperations,
  ...searchOperations,
  ...linkOperations,
  ...graphOperations,
  ...tagOperations,
  ...topicOperations,
  ...savedSearchOperations,
  ...packOperations,
  ...registryOperations,
  ...connectorOperations,
  ...adminOperations,
  ...analyticsOperations,
  ...webhookOperations,
  ...taskOperations,
];

const BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));

/** The operation called `name`, or undefined. */
export function getOperation(name: string): Operation | undefined {
  return BY_NAME.get(name);
}
