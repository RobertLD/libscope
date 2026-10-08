# MCP Tools

LibScope exposes its knowledge base over the Model Context Protocol. Any MCP client (Claude, Cursor, VS Code, and others) can call these tools. See [MCP Setup](/guide/mcp-setup) to connect a client.

The server has 11 core tools. Four admin tools are available when you enable the admin toolset. Each tool is generated from a LibScope operation, so its parameters, defaults and validation are the same as in the CLI, the REST API and the SDK.

## Workflow

1. `search` finds chunks. Each result shows a `documentId` and a `chunkId`.
2. `get-document` reads a document with its tags, links and ratings. For a long document, set `maxLength`, then pass the `offset` that the output shows as "next page".
3. `rate-document` records whether a document was useful, wrong or out of date.

The server sends these steps to the client as its `instructions`, so the assistant knows the workflow without extra prompting.

## Output

Tools return compact text. Each line that names a document, chunk, link or task includes its ID (`documentId`, `chunkId`, `linkId`, `taskId`), so the assistant can pass the ID to the next tool. Lists show their position, for example `Documents 1-50 of 120 — next page: offset 50`.

Errors return `isError: true` with a message. Invalid parameters fail with an input validation error that names the parameter.

## Background tasks

`submit-document`, `sync`, `install-pack` and `reindex-documents` accept `async: true`. With it, the tool starts a background task and returns a `taskId` immediately. Then:

- `task {"action": "status", "taskId": "..."}` shows the status (`pending`, `running`, `completed`, `failed` or `cancelled`), the progress and, when the task is done, the same output that the tool returns without `async`.
- `task {"action": "cancel", "taskId": "..."}` asks the task to stop.
- `task {"action": "list"}` lists the tasks from the last hour.

Tasks are kept in memory for one hour after they finish. They are lost when the server stops.

## ask and passthrough

`ask` is registered only when it can answer:

- With `llm.provider` set to `auto` (the default) or `passthrough`, the MCP server does not call an LLM. `ask` returns the retrieved context and its sources. The calling assistant writes the answer.
- With `llm.provider` set to `openai`, `anthropic` or `ollama` and the provider configured, `ask` returns the LLM's answer and its sources.
- When an LLM provider is selected but cannot be created (for example, an API key is missing), the server does not register `ask`.

## Admin toolset

The `mcp.toolsets` config key enables optional toolsets (`libscope config set mcp.toolsets admin`, or the environment variable `LIBSCOPE_MCP_TOOLSETS` as a comma-separated list). `admin` enables `sync`, `install-pack`, `list-packs` and `reindex-documents`. `all` enables every optional toolset. `core` (the default tools) is always on.

```json
{
  "mcpServers": {
    "libscope": {
      "command": "npx",
      "args": ["-y", "libscope", "serve"],
      "env": { "LIBSCOPE_MCP_TOOLSETS": "admin" }
    }
  }
}
```

`sync` uses connections saved with `libscope connect`. It does not accept tokens or other credentials as parameters.

## Core tools

The tool descriptions and parameter tables below are generated from the server code (`npm run docs:gen`).

<!-- generated:start mcp:core -->

### search

Search the knowledge base by meaning and keywords (query), or find content similar to a document or chunk (relatedTo). Results carry documentId and chunkId.

Annotations: read-only.

| Parameter              | Type                                                  | Required | Description                                                                 |
| ---------------------- | ----------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `query`                | string                                                |          | What to search for                                                          |
| `relatedTo`            | string                                                |          | Document or chunk ID: return similar content instead of running a query     |
| `topic`                | string                                                |          | Topic ID or name                                                            |
| `library`              | string                                                |          | Library name                                                                |
| `version`              | string                                                |          | Library version                                                             |
| `sourceType`           | `library` \| `topic` \| `manual` \| `model-generated` |          | Document source type                                                        |
| `tags`                 | string[]                                              |          | Only documents carrying all of these tags                                   |
| `minRating`            | number                                                |          | Minimum average rating                                                      |
| `limit`                | integer                                               |          | Maximum results (default 10, max 100)                                       |
| `offset`               | integer                                               |          | Results to skip (paging). Default: `0`.                                     |
| `maxChunksPerDocument` | integer                                               |          | At most this many chunks per document (default: no limit)                   |
| `contextChunks`        | integer                                               |          | Neighbouring chunks to include before and after each result. Default: `0`.  |
| `diversity`            | number                                                |          | Query search: MMR reranking, 0 = relevance only (default), 1 = most diverse |

### ask

Answer a question from the knowledge base with an LLM, or (passthrough) return the context to answer from

Annotations: read-only.

| Parameter      | Type                                                  | Required | Description                                                                  |
| -------------- | ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `question`     | string                                                | yes      | The question                                                                 |
| `topic`        | string                                                |          | Topic ID or name                                                             |
| `library`      | string                                                |          | Library name                                                                 |
| `version`      | string                                                |          | Library version                                                              |
| `sourceType`   | `library` \| `topic` \| `manual` \| `model-generated` |          | Document source type                                                         |
| `tags`         | string[]                                              |          | Only documents carrying all of these tags                                    |
| `minRating`    | number                                                |          | Minimum average rating                                                       |
| `topK`         | integer                                               |          | Chunks to retrieve as context. Default: `5`.                                 |
| `systemPrompt` | string                                                |          | System prompt for the LLM (default: answer from the context and cite titles) |

### get-document

Get a document with its tags, links and rating summary; long content can be paged

Annotations: read-only.

| Parameter    | Type    | Required | Description                                            |
| ------------ | ------- | -------- | ------------------------------------------------------ |
| `documentId` | string  | yes      | Document ID                                            |
| `offset`     | integer |          | Character offset into the content. Default: `0`.       |
| `maxLength`  | integer |          | Maximum characters of content to return (default: all) |

### list-documents

List documents (newest first) with optional filters

Annotations: read-only.

| Parameter    | Type                                                  | Required | Description                               |
| ------------ | ----------------------------------------------------- | -------- | ----------------------------------------- |
| `topic`      | string                                                |          | Topic ID or name                          |
| `library`    | string                                                |          | Library name                              |
| `version`    | string                                                |          | Library version                           |
| `sourceType` | `library` \| `topic` \| `manual` \| `model-generated` |          | Document source type                      |
| `tags`       | string[]                                              |          | Only documents carrying all of these tags |
| `limit`      | integer                                               |          | Maximum results (default 50, max 1000)    |
| `offset`     | integer                                               |          | Results to skip (paging). Default: `0`.   |

### overview

Knowledge base overview: counts, topics, installed packs, embedding model of the index, and health

Annotations: read-only.

No parameters.

### submit-document

Add to the knowledge base: inline content (with title), a web page (url), a site crawl (url + spider: true) or a public GitHub/GitLab repository URL. Local file paths are not accepted.

Annotations: not destructive.

| Parameter         | Type                                                  | Required | Description                                                                                               |
| ----------------- | ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `content`         | string                                                |          | Inline document content (markdown)                                                                        |
| `title`           | string                                                |          | Title (required with content; detected for files and URLs)                                                |
| `url`             | string (uri)                                          |          | Source URL. Without content, the URL is fetched; with content, it is stored                               |
| `topic`           | string                                                |          | Topic ID or name                                                                                          |
| `library`         | string                                                |          | Library name                                                                                              |
| `version`         | string                                                |          | Library version                                                                                           |
| `sourceType`      | `library` \| `topic` \| `manual` \| `model-generated` |          | Source type (default: library if library is set, topic if topic is set, else manual)                      |
| `tags`            | string[]                                              |          | Tags to add to every new document                                                                         |
| `expiresAt`       | string (date-time)                                    |          | ISO 8601 time after which the document is pruned                                                          |
| `dedup`           | `skip` \| `warn` \| `force`                           |          | Duplicate handling: skip returns the existing document, warn indexes anyway, force skips the check        |
| `spider`          | boolean                                               |          | URL: also crawl linked pages. Default: `false`.                                                           |
| `maxPages`        | integer                                               |          | Crawl: page limit (default 25, max 200)                                                                   |
| `maxDepth`        | integer                                               |          | Crawl: link depth (default 2, max 5)                                                                      |
| `sameDomain`      | boolean                                               |          | Crawl: stay on the seed domain (default true)                                                             |
| `pathPrefix`      | string                                                |          | Crawl: only follow links under this path                                                                  |
| `excludePatterns` | string[]                                              |          | Crawl: globs of URLs to skip                                                                              |
| `branch`          | string                                                |          | Repository: branch (default: from URL, else main)                                                         |
| `paths`           | string[]                                              |          | Repository: only these subdirectories                                                                     |
| `extensions`      | string[]                                              |          | Repository: file extensions (default .md, .mdx, .txt, .rst)                                               |
| `dryRun`          | boolean                                               |          | List what would be added without adding it. Default: `false`.                                             |
| `async`           | boolean                                               |          | Run in the background and return a taskId at once; poll with task {"action": "status"}. Default: `false`. |

### update-document

Update a document's title, content, metadata or tags (content changes are re-indexed)

Annotations: not destructive, idempotent.

| Parameter    | Type                 | Required | Description                              |
| ------------ | -------------------- | -------- | ---------------------------------------- |
| `documentId` | string               | yes      | Document ID                              |
| `title`      | string               |          | New title                                |
| `content`    | string               |          | New content (re-chunked and re-embedded) |
| `library`    | string \| null       |          | New library (null clears it)             |
| `version`    | string \| null       |          | New version (null clears it)             |
| `url`        | string (uri) \| null |          | New URL (null clears it)                 |
| `topic`      | string \| null       |          | New topic ID or name (null clears it)    |
| `tags`       | string[]             |          | Replace the document's tags with these   |

### delete-document

Delete a document with its chunks, vectors, tags, links and ratings

Annotations: destructive.

| Parameter    | Type   | Required | Description |
| ------------ | ------ | -------- | ----------- |
| `documentId` | string | yes      | Document ID |

### rate-document

Rate a document (1-5), optionally with feedback or a suggested correction

Annotations: not destructive.

| Parameter             | Type    | Required | Description                              |
| --------------------- | ------- | -------- | ---------------------------------------- |
| `documentId`          | string  | yes      | Document ID                              |
| `chunkId`             | string  |          | Rate one chunk of the document           |
| `rating`              | integer | yes      | 1 (poor) to 5 (excellent)                |
| `feedback`            | string  |          | What is good or wrong                    |
| `suggestedCorrection` | string  |          | Replacement text if the content is wrong |

### link-documents

Create a typed link from one document to another (action: create), or delete a link by linkId (action: delete). get-document lists a document's links.

Annotations: destructive.

| Parameter          | Type                                                                      | Required | Description                                                                                 |
| ------------------ | ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `action`           | `create` \| `delete`                                                      | yes      | What to do: create, delete                                                                  |
| `documentId`       | string                                                                    |          | Source document ID (action: create)                                                         |
| `targetDocumentId` | string                                                                    |          | Target document ID (action: create)                                                         |
| `linkType`         | `see_also` \| `prerequisite` \| `supersedes` \| `related` \| `references` |          | Relationship type: see_also, prerequisite, supersedes, related, references (action: create) |
| `label`            | string                                                                    |          | Short description of the relationship (action: create)                                      |
| `linkId`           | string                                                                    |          | Link ID (action: delete)                                                                    |

### task

Background tasks started with async: true. status: progress and result of a task; cancel: stop it; list: tasks from the last hour.

Annotations: not destructive, idempotent.

| Parameter | Type                           | Required | Description                                                              |
| --------- | ------------------------------ | -------- | ------------------------------------------------------------------------ |
| `action`  | `status` \| `cancel` \| `list` | yes      | What to do: status, cancel, list                                         |
| `taskId`  | string                         |          | Task ID returned when a background task started (action: status, cancel) |

<!-- generated:end mcp:core -->

## Admin tools

These tools are registered only when `mcp.toolsets` contains `admin` or `all`.

<!-- generated:start mcp:admin -->

### sync

Sync one saved connector connection (name) or all of them (all: true) with the settings saved by 'libscope connect'

Annotations: not destructive.

| Parameter | Type    | Required | Description                                                                                               |
| --------- | ------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `name`    | string  |          | Name of a saved connection                                                                                |
| `all`     | boolean |          | Sync every saved connection. Default: `false`.                                                            |
| `async`   | boolean |          | Run in the background and return a taskId at once; poll with task {"action": "status"}. Default: `false`. |

### install-pack

Install a knowledge pack from a registry (name or name@version)

Annotations: not destructive, idempotent.

| Parameter     | Type    | Required | Description                                                                                               |
| ------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `pack`        | string  | yes      | Pack name or name@version from a registry, or a local .json/.json.gz file                                 |
| `registry`    | string  |          | Look only in this registry (needed when several registries have the pack)                                 |
| `batchSize`   | integer |          | Documents per batch (default 10)                                                                          |
| `concurrency` | integer |          | Batches embedded in parallel (default 4)                                                                  |
| `resumeFrom`  | integer |          | Skip the first N documents (resume a partial install)                                                     |
| `async`       | boolean |          | Run in the background and return a taskId at once; poll with task {"action": "status"}. Default: `false`. |

### list-packs

List installed packs, or the packs available in the configured registries

Annotations: read-only.

| Parameter   | Type    | Required | Description                                                                              |
| ----------- | ------- | -------- | ---------------------------------------------------------------------------------------- |
| `available` | boolean |          | List the packs in the configured registries instead of installed ones. Default: `false`. |
| `registry`  | string  |          | With available: only this registry                                                       |

### reindex-documents

Re-embed chunks with the configured embedding model (rebuild after changing models)

Annotations: not destructive, idempotent.

| Parameter     | Type                                | Required | Description                                                                                               |
| ------------- | ----------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `documentIds` | string[]                            |          | Only these documents                                                                                      |
| `since`       | string (date) \| string (date-time) |          | Only documents created on or after                                                                        |
| `before`      | string (date) \| string (date-time) |          | Only documents created on or before                                                                       |
| `batchSize`   | integer                             |          | Chunks per embedding call (default 50)                                                                    |
| `rebuild`     | boolean                             |          | Drop and recreate the vector table for the configured model, then re-embed everything. Default: `false`.  |
| `async`       | boolean                             |          | Run in the background and return a taskId at once; poll with task {"action": "status"}. Default: `false`. |

<!-- generated:end mcp:admin -->
