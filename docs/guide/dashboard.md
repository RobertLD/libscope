# Web Dashboard

LibScope includes a local web dashboard for browsing, searching, and managing your knowledge base without the CLI.

## Starting the Dashboard

```bash
libscope serve dashboard
```

This starts an HTTP server at `http://localhost:3377` by default.

```bash
# Use a custom port
libscope serve dashboard --port 8080

# Bind to all interfaces (for LAN access)
libscope serve dashboard --host 0.0.0.0 --port 3377
```

The dashboard page needs no external files. The knowledge graph page (`/graph`) loads d3 from `d3js.org`.

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
- **Edges** represent cross-reference links (`libscope docs link`, the `link-documents` MCP tool, `POST /api/v1/documents/:documentId/links`)
- **Clusters** are automatically detected and color-coded by topic
- Hover a node to see the document title; click to open it in the document browser

The graph is useful for discovering how your documents relate to each other and for finding isolated documents that have no connections.

### Light / Dark Mode

Click the sun/moon icon in the top-right corner to toggle between light and dark mode. The preference is saved in `localStorage`.

## Data API

The dashboard pages read their data from a small JSON API on the same server. Each URL runs one LibScope operation, the same operation as the CLI, MCP server and REST API:

| URL                                           | Operation                                     |
| --------------------------------------------- | --------------------------------------------- |
| `GET /api/stats`                              | `overview` (document, topic and chunk counts) |
| `GET /api/topics`                             | `list-topics`                                 |
| `GET /api/documents?limit&offset&topic`       | `list-documents`                              |
| `GET /api/documents/:id`                      | `get-document`                                |
| `DELETE /api/documents/:id`                   | `delete-document`                             |
| `GET /api/search?q&limit&topic`               | `search`                                      |
| `GET /api/graph?threshold&maxNodes&topic&tag` | `graph`                                       |

These URLs are for the dashboard pages. For your own scripts, use the [REST API](../reference/rest-api.md) (`libscope serve api`), which has every operation, API-key authentication and an OpenAPI document.

## Rate Limiting

The dashboard server allows 120 requests per minute from each IP address. A request over the limit gets `429`.

## Running Alongside the MCP Server

The dashboard, the REST API and the MCP server are separate servers. You can start them independently:

```bash
# Dashboard in one terminal
libscope serve dashboard --port 3377

# REST API in another
libscope serve api --port 3378

# MCP server (or configure it in your AI client)
libscope serve
```

All of them use the same workspace database.

## Security Considerations

The dashboard is for **local use**. It has no authentication. Anyone who can connect to its port can read and delete documents.

- The server listens on `localhost` by default. If you use `--host 0.0.0.0`, every network interface can reach it.
- The server sends no `Access-Control-Allow-Origin` header, so pages from other origins cannot read its responses.
- The server rejects write requests (`DELETE`) from pages on other origins with `403`.
- To expose the dashboard on a network, put it behind a reverse proxy (nginx, Caddy) that adds authentication.
