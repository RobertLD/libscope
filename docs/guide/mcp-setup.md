# MCP Setup

LibScope implements the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), which lets AI assistants query your knowledge base directly. Start the server with:

```bash
libscope serve
```

This runs a stdio-based MCP server. Your AI assistant launches it as a subprocess and communicates over stdin/stdout.

## Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "libscope": {
      "command": "npx",
      "args": ["-y", "libscope", "serve"]
    }
  }
}
```

Restart Cursor, and LibScope's tools will be available in chat.

## Claude Code

```bash
claude mcp add --scope user libscope -- npx -y libscope serve
```

## Claude Desktop

Add to your Claude Desktop config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "libscope": {
      "command": "npx",
      "args": ["-y", "libscope", "serve"]
    }
  }
}
```

## VS Code

Add to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "libscope": {
        "command": "npx",
        "args": ["-y", "libscope", "serve"]
      }
    }
  }
}
```

## Using a Specific Workspace

If you're using [workspaces](/guide/configuration#workspaces), pass the workspace name to the serve command:

```json
{
  "mcpServers": {
    "libscope": {
      "command": "npx",
      "args": ["-y", "libscope", "serve", "--workspace", "my-project"]
    }
  }
}
```

## Admin Tools

The server starts with 11 core tools. To also give the assistant `sync`, `install-pack`, `list-packs` and `reindex-documents`, set `LIBSCOPE_MCP_TOOLSETS` in the server's environment:

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

## Available Tools

See the [MCP Tools Reference](/reference/mcp-tools) for all parameters.

**Core tools**

- **`search`**: search by meaning and keywords, or find content related to a document or chunk (`relatedTo`). Filters: topic, library, version, source type, tags, minimum rating.
- **`ask`**: answer a question from the knowledge base. By default (`llm.provider: auto`) the server returns the retrieved context and your assistant writes the answer. Registered only when an answer is possible.
- **`get-document`**: read a document with its tags, links and ratings. Long content is paged.
- **`list-documents`**: list documents with filters, `offset` and a total count.
- **`overview`**: document, chunk and topic counts, topics, installed packs, the embedding model of the index, and health.
- **`submit-document`**: add inline content, a web page, a site crawl (`spider: true`) or a public repository URL.
- **`update-document`**: change the title, content, metadata or tags.
- **`delete-document`**: delete a document.
- **`rate-document`**: rate a document 1-5, with optional feedback or a correction.
- **`link-documents`**: create (`action: "create"`) or delete (`action: "delete"`) a link between documents.
- **`task`**: status, cancel or list of background tasks started with `async: true`.

**Admin tools** (with `LIBSCOPE_MCP_TOOLSETS=admin`)

- **`sync`**: sync one saved connector connection, or all of them. Set up connections with `libscope connect`; the tool does not accept credentials.
- **`install-pack`**, **`list-packs`**: manage knowledge packs.
- **`reindex-documents`**: re-embed chunks after you change the embedding model.

Your AI assistant calls these tools when it needs information from your docs. The server also sends the assistant short instructions that describe the search, read and rate workflow.

## Logs

The MCP server writes JSON-RPC messages to stdout and its logs to stderr. Set the log level with `logging.level` in the config file or `LIBSCOPE_LOGGING_LEVEL`.

## Embedding the Server

`libscope/mcp` exports `createMcpServer()`. Importing the module does not start a server.

```ts
import { createMcpServer, runStdioServer } from "libscope/mcp";

// Build a server and connect your own transport.
const { server, tools, close } = createMcpServer({ workspace: "my-project", toolsets: ["admin"] });

// Or serve over stdio, the same as `libscope serve`.
await runStdioServer({ workspace: "my-project" });
```

`createMcpServer` accepts the same options as LibScope's startup (`workspace`, `dbPath`, `config`, `provider`) or an existing operation context (`ctx`). `close()` closes the server and the database that it opened.
