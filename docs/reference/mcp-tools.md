# MCP Tools

LibScope exposes the following tools over the Model Context Protocol. Any MCP-compatible client (Claude, Cursor, VS Code, etc.) can call these directly.

## search-docs

Semantic search across your knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✅ | Search query |
| `library` | string | | Filter by library name |
| `topic` | string | | Filter by topic |
| `version` | string | | Filter by library version |
| `minRating` | number | | Minimum average rating (1–5) |
| `limit` | number | | Max results (default: 10) |
| `offset` | number | | Pagination offset |

## get-document

Retrieve a document by its ID, including ratings and metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | ✅ | The document ID |

## delete-document

Delete a document from the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | ✅ | The document ID to delete |

## submit-document

Index a new document. You can provide content directly, or a URL to fetch automatically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | | Document title (auto-detected from URL if omitted) |
| `content` | string | | Document content in markdown (omit if providing URL) |
| `url` | string | | URL to fetch and index |
| `library` | string | | Library name |
| `version` | string | | Library version |
| `topic` | string | | Topic to categorize under |
| `sourceType` | string | | `library`, `topic`, `manual`, or `model-generated` |

## rate-document

Rate a document and optionally suggest corrections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | ✅ | The document ID |
| `rating` | number | ✅ | Rating from 1 (poor) to 5 (excellent) |
| `chunkId` | string | | Rate a specific chunk |
| `feedback` | string | | Text feedback |
| `suggestedCorrection` | string | | Suggested replacement content |

## list-documents

List documents with optional filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | string | | Filter by library |
| `topic` | string | | Filter by topic |
| `sourceType` | string | | Filter by source type |
| `limit` | number | | Max results (default: 50) |

## list-topics

List available topics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `parentId` | string | | Filter by parent topic (for subtopics) |

## ask-question

RAG question-answering. Retrieves relevant chunks and synthesizes an answer using your configured LLM.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | ✅ | The question to answer |
| `library` | string | | Filter source docs by library |
| `topic` | string | | Filter source docs by topic |
| `topK` | number | | Number of chunks to retrieve (default: 5) |

## health-check

Check database connectivity, document/chunk counts, and FTS5 index status. Takes no parameters.

## reindex-documents

Re-embed all document chunks with the current embedding provider. Use after switching providers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `batchSize` | number | | Chunks per batch (default: 50) |
| `since` | string | | Only reindex docs created after this ISO-8601 date |
| `before` | string | | Only reindex docs created before this ISO-8601 date |
| `documentIds` | string[] | | Only reindex specific documents |

## sync-obsidian-vault

Sync an Obsidian vault into the knowledge base. Parses wikilinks, frontmatter, embeds, and tags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vaultPath` | string | ✅ | Absolute path to the vault directory |

## sync-notion

Sync Notion pages and databases.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | ✅ | Notion integration token |
| `excludePages` | string[] | | Page/database IDs to exclude |
| `lastSync` | string | | ISO-8601 timestamp for incremental sync |

## sync-confluence

Sync Confluence spaces and pages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseUrl` | string | ✅ | Confluence base URL |
| `email` | string | ✅ | User email |
| `token` | string | ✅ | API token |
| `spaces` | string[] | | Space keys to sync (default: all) |
| `excludeSpaces` | string[] | | Space keys to exclude |

## sync-slack

Sync Slack channel messages and threads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `token` | string | ✅ | Slack bot token |
| `channels` | string[] | ✅ | Channel names/IDs, or `["all"]` |
| `excludeChannels` | string[] | | Channels to exclude |
| `threadMode` | string | | `aggregate` (default) or `separate` |

## sync-onenote

Sync OneNote notebooks via Microsoft Graph API.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `accessToken` | string | ✅ | Microsoft Graph API access token |
| `notebookName` | string | | Specific notebook (default: all) |

## install-pack

Install a knowledge pack from the registry or a local file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nameOrPath` | string | ✅ | Pack name or local file path |
| `registryUrl` | string | | Custom registry URL |

## list-packs

List installed or available knowledge packs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `available` | boolean | | If true, list from registry instead of installed |
| `registryUrl` | string | | Custom registry URL |
