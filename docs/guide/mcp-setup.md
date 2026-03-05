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

## Available Tools

Once connected, your AI assistant gets access to all 26 of LibScope's MCP tools. See the [MCP Tools Reference](/reference/mcp-tools) for full parameter details.

**Search & Q&A**
- **`search-docs`** — semantic search with topic/library/version/rating filters
- **`ask-question`** — RAG Q&A with synthesized answers and source citations

**Document Management**
- **`submit-document`** — index new content by text or URL
- **`update-document`** — update title, content, or metadata
- **`get-document`** — retrieve a document by ID
- **`list-documents`** — list docs with filters
- **`delete-document`** — remove a document
- **`rate-document`** — rate 1–5 with feedback
- **`suggest-tags`** — auto-suggest tags based on content

**Organization**
- **`list-topics`** — browse the topic hierarchy
- **`link-documents`** — create cross-references between docs
- **`get-document-links`** — list a document's incoming and outgoing links
- **`delete-link`** — remove a cross-reference

**Saved Searches**
- **`save-search`** — save a named query with filters
- **`list-saved-searches`** — list saved searches
- **`run-saved-search`** — execute a saved search

**Connectors** — trigger syncs directly from your AI assistant:
- **`sync-obsidian-vault`**, **`sync-notion`**, **`sync-confluence`**, **`sync-slack`**, **`sync-onenote`**

**Packs & Maintenance**
- **`install-pack`**, **`list-packs`** — manage knowledge packs
- **`reindex-documents`** — re-embed after switching providers
- **`health-check`** — DB status and doc/chunk counts

Your AI assistant will call these tools automatically when it needs information from your docs.
