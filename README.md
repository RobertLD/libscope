# LibScope

[![npm version](https://img.shields.io/npm/v/libscope)](https://www.npmjs.com/package/libscope)
[![CI](https://github.com/RobertLD/libscope/actions/workflows/ci.yml/badge.svg)](https://github.com/RobertLD/libscope/actions/workflows/ci.yml)
[![License: Source Available](https://img.shields.io/badge/License-Source%20Available-orange.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Website](https://img.shields.io/badge/docs-libscope.com-blue)](https://libscope.com)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=RobertLD_libscope&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=RobertLD_libscope)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=RobertLD_libscope&metric=bugs)](https://sonarcloud.io/summary/new_code?id=RobertLD_libscope)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=RobertLD_libscope&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=RobertLD_libscope)

LibScope is a local knowledge base that makes your documentation searchable by AI assistants. Add markdown files, PDFs, web pages, repositories, or connect Obsidian, Notion, Confluence, Slack and OneNote. LibScope chunks, embeds and indexes everything into a local SQLite database. Your AI tools query it through [MCP](https://modelcontextprotocol.io/) (Model Context Protocol), the CLI, a REST API or the Node.js SDK.

Everything runs on your machine. The default embedding model runs locally, so no cloud service is needed for indexing and search.

**Upgrading from 1.x?** LibScope 2.0 renames many commands, MCP tools, REST routes, config keys and SDK methods. See [Migrating to LibScope 2.0](docs/migration-v2.md).

## Quick start

### CLI

```bash
npm install -g libscope

# Add files, directories, web pages or GitHub/GitLab repositories
libscope add ./docs --library my-lib
libscope add https://docs.example.com/guide --spider --max-pages 50
libscope add https://github.com/org/repo

# Search, and ask questions (ask needs an LLM: set an OpenAI or Anthropic key, or use Ollama)
libscope search "how to authenticate"
libscope ask "How do I configure OAuth2?"

# Check the setup: config, database, embedding model, index and LLM
libscope doctor
```

The database is created on first use. The first command that embeds text downloads the local model [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (about 80 MB, first run only).

### MCP (Claude, Cursor, VS Code, ...)

Add LibScope to your MCP client config:

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

For Claude Code:

```bash
claude mcp add --scope user libscope -- npx -y libscope serve
```

The server has 11 core tools (`search`, `ask`, `get-document`, `list-documents`, `overview`, `submit-document`, `update-document`, `delete-document`, `rate-document`, `link-documents`, `task`). Set `LIBSCOPE_MCP_TOOLSETS=admin` to add `sync`, `install-pack`, `list-packs` and `reindex-documents`. Under MCP, `ask` returns the retrieved context by default, and your assistant writes the answer.

### SDK (Node.js)

```ts
import { LibScope } from "libscope";

const scope = LibScope.create(); // the same database as the CLI and MCP server

await scope.add({
  title: "Auth Guide",
  content: "# Authentication\n\nUse OAuth2...",
  library: "my-lib",
});
await scope.add("./docs");

const { items } = await scope.search("how to authenticate");
for (const hit of items) console.log(hit.documentId, hit.title, hit.score);

const result = await scope.ask("How do I configure OAuth2?");
if (result.mode === "answer") console.log(result.answer);

scope.close();
```

To embed LibScope in another application without reading config files, use `createLite()` from `libscope/lite`.

## Documentation

The full documentation is at [libscope.com](https://libscope.com).

Guides:

- [Getting started](https://libscope.com/guide/getting-started)
- [Configuration](https://libscope.com/guide/configuration): embedding providers, LLM for `ask`, API keys
- [MCP setup](https://libscope.com/guide/mcp-setup)
- [Connectors](https://libscope.com/guide/connectors): Obsidian, Notion, Confluence, Slack, OneNote, documentation sites
- [Knowledge packs](https://libscope.com/guide/knowledge-packs) and [pack registries](https://libscope.com/guide/pack-registries)
- [Programmatic usage](https://libscope.com/guide/programmatic-usage) and [LibScope Lite](https://libscope.com/guide/lite)
- [Web dashboard](https://libscope.com/guide/dashboard), [webhooks](https://libscope.com/guide/webhooks), [troubleshooting](https://libscope.com/guide/troubleshooting)

Reference (generated from the code):

- [CLI commands](docs/reference/cli.md)
- [MCP tools](docs/reference/mcp-tools.md)
- [REST API](docs/reference/rest-api.md) (`libscope serve api`)
- [Configuration keys and environment variables](docs/reference/configuration.md)

Client SDKs for the REST API: [Python](sdk/python/README.md) and [Go](sdk/go/README.md).

## Supported formats

Markdown (`.md`, `.mdx`, `.markdown`), plain text, HTML, JSON, YAML, CSV, EPUB and PowerPoint (`.pptx`) are built in. PDF (`pdf-parse`) and Word `.docx` (`mammoth`) need optional dependencies, which npm installs when your Node.js version supports them.

## How it works

LibScope stores everything in one SQLite database per workspace (`~/.libscope/workspaces/default/libscope.db` for the default workspace). The CLI, MCP server, REST API and SDK all open the same file and call the same operations, so they take the same parameters and return the same results.

- Documents are split into chunks at heading boundaries.
- Each chunk is embedded with the configured provider (local, Ollama or OpenAI).
- Search combines vector similarity ([sqlite-vec](https://github.com/asg017/sqlite-vec)) with FTS5 full-text search.
- Connectors fetch content from other platforms and feed it through the same indexing pipeline.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
git clone https://github.com/RobertLD/libscope.git
cd libscope && npm install
npm run dev        # watch mode
npm test           # run tests
npm run typecheck  # type check
npm run lint       # lint
```

## License

[Business Source License 1.1](LICENSE) — see [LICENSE](LICENSE) for full terms.
