# Web Dashboard

LibScope includes a local web dashboard for browsing, searching, and managing your knowledge base without the CLI.

## Starting the Dashboard

```bash
libscope serve --dashboard
```

This starts an HTTP server at `http://localhost:3377` by default.

```bash
# Use a custom port
libscope serve --dashboard --port 8080

# Bind to all interfaces (for LAN access)
libscope serve --dashboard --host 0.0.0.0 --port 3377
```

The dashboard is fully self-contained — no external CDN dependencies.

## Features

### Search

The top search bar performs live semantic search as you type. Results update with each query and include:

- Document title and library
- Matching chunk excerpt with highlighted terms
- Relevance score and scoring method (hybrid / vector / fts5)
- Topic breadcrumb

Click any result to open the full document.

### Document Browser

The **Documents** tab lists all indexed documents. You can:

- Filter by library, topic, or tag using the sidebar controls
- Sort by title, date added, or rating
- Click a document to view its full content and metadata
- See incoming and outgoing cross-reference links

### Topic Navigation

The **Topics** panel shows your topic hierarchy. Clicking a topic filters the document list to that topic and its subtopics.

### Knowledge Graph

Navigate to `/graph` (e.g. `http://localhost:3377/graph`) to view an interactive visualization of your knowledge base:

- **Nodes** represent documents
- **Edges** represent cross-reference links (`link-documents`, `libscope link`)
- **Clusters** are automatically detected and color-coded by topic
- Hover a node to see the document title; click to open it in the document browser

The graph is useful for discovering how your documents relate to each other and for finding isolated documents that have no connections.

### Light / Dark Mode

Click the sun/moon icon in the top-right corner to toggle between light and dark mode. The preference is saved in `localStorage`.

## Rate Limiting

The dashboard server applies per-IP rate limiting to prevent abuse when exposed on a network. The defaults are generous for local use; if you hit limits, restart with `--host localhost` to restrict access to your machine.

## Running Alongside the MCP Server

The dashboard and MCP server run on different ports and can be started independently:

```bash
# Dashboard in one terminal
libscope serve --dashboard --port 3377

# MCP server in another (or configured in your AI client)
libscope serve
```

Or run the REST API and use it as the dashboard's data source:

```bash
libscope serve --api --port 3378
libscope serve --dashboard --port 3377
```

## Security Considerations

The dashboard is designed for **local use only**. If you expose it on a network:

- Use `--host` carefully — binding to `0.0.0.0` exposes it to all network interfaces
- Consider putting it behind a reverse proxy (nginx, Caddy) with authentication
- The REST API (`--api`) does require an `X-API-Key` header for write operations; the dashboard uses the same key automatically when running on the same host
