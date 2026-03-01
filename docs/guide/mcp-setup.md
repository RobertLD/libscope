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

Once connected, your AI assistant gets access to all of LibScope's MCP tools. See the [MCP Tools Reference](/reference/mcp-tools) for the full list.

The most commonly used ones:

- **`search-docs`** — semantic search across your knowledge base
- **`ask-question`** — RAG Q&A with synthesized answers
- **`submit-document`** — index new content (by text or URL)
- **`list-topics`** — browse what's in the knowledge base

Your AI assistant will call these tools automatically when it needs information from your docs.
