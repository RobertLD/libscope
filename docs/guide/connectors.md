# Connectors

Connectors pull documents from external tools into your LibScope knowledge base: Notion, Slack, Confluence, Obsidian, OneNote and documentation sites. Each connector handles authentication, pagination and incremental sync.

## Connections

`libscope connect <type>` saves a **connection** and syncs it. A connection is the connector's settings, including credentials, in `~/.libscope/connectors/<name>.json` (file mode `0600`). The default name is the connector type. Use `--name` to keep more than one connection of the same type:

```bash
libscope connect slack --token xoxb-work-token --name work-slack
```

| Command                                      | What it does                                                    |
| -------------------------------------------- | --------------------------------------------------------------- |
| `libscope connect <type> [source] [options]` | Create or update a connection, then sync it (`--no-sync` skips) |
| `libscope sync <name>`                       | Sync one connection with its saved settings                     |
| `libscope sync --all`                        | Sync every connection                                           |
| `libscope connections`                       | List connections with their schedule, last sync and last run    |
| `libscope disconnect <name>`                 | Delete the connection's documents and its saved settings        |

Running `connect` again for a saved connection changes only the settings you give and keeps the rest. `disconnect --keep-documents` deletes only the saved settings. The [CLI reference](/reference/cli#connectors) lists every option.

A connection holds these settings:

| Type         | Saved settings                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `notion`     | `token`, `excludePages`                                                                              |
| `slack`      | `token`, `channels`, `excludeChannels`, `threadMode`                                                 |
| `confluence` | `baseUrl`, `type` (cloud or server), `email`, `token`, `spaces`, `excludeSpaces`                     |
| `obsidian`   | `vaultPath`, `topicMapping`, `excludePatterns`                                                       |
| `onenote`    | `clientId`, `tenantId`, `accessToken`, `refreshToken`, `tokenExpiry`, `notebooks`, `excludeSections` |
| `docs`       | `url`, `type` (site generator), `library`, `version`, `maxPages`, `maxDepth`, `pathPrefix`           |

Each file also stores `connectorType`, the `schedule` (if set) and `lastSync`. After each successful sync, `lastSync` is set to the time the sync started. Notion, Slack and OneNote use it to fetch only what changed since then. Obsidian re-indexes only files whose modification time changed.

### Schedules

`--schedule <cron>` syncs a connection on a cron schedule. Schedules run while the REST API server runs (`libscope serve api`):

```bash
libscope connect notion --schedule "0 */6 * * *" --no-sync   # every 6 hours
libscope connections                                         # shows the schedule
libscope connect notion --schedule off --no-sync             # remove the schedule
```

Each run, scheduled or manual, records its status. `libscope connections` shows the last run.

## Obsidian

Sync an Obsidian vault. LibScope parses frontmatter, wikilinks, embeds and tags. The folder structure maps to topics.

```bash
# First sync
libscope connect obsidian /path/to/vault

# Map topics from frontmatter instead of folders
libscope connect obsidian /path/to/vault --topic-mapping frontmatter

# Skip folders (comma-separated globs)
libscope connect obsidian /path/to/vault --exclude "templates/*,daily/*"

# Sync again (only changed files are re-indexed)
libscope sync obsidian

# Remove the vault's documents and the connection
libscope disconnect obsidian
```

## Notion

Sync pages and databases from your Notion workspace. You need a [Notion integration token](https://www.notion.so/my-integrations).

```bash
# Sync with an integration token
libscope connect notion --token secret_abc123

# Skip pages or databases (comma-separated IDs)
libscope connect notion --exclude page-id-1,db-id-2

# Sync again (pages edited since the last sync)
libscope sync notion

libscope disconnect notion
```

## Confluence

Sync Confluence spaces and pages. For Confluence Cloud you need an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). The base URL is the `[source]` argument.

```bash
# All spaces (Cloud)
libscope connect confluence https://acme.atlassian.net \
  --email user@acme.com \
  --token "$CONFLUENCE_API_TOKEN"

# Some spaces, skip one
libscope connect confluence https://acme.atlassian.net \
  --email user@acme.com \
  --token "$CONFLUENCE_API_TOKEN" \
  --spaces ENG,DEVOPS \
  --exclude ARCHIVE

# Server or Data Center with a personal access token
libscope connect confluence https://wiki.internal.example.com --server --token "$CONFLUENCE_PAT"

libscope sync confluence
libscope disconnect confluence
```

The examples read the token from a shell variable to keep it out of your shell history. LibScope does not read connector credentials from environment variables.

## Slack

Index Slack channel messages and threads. You need a [Slack bot token](https://api.slack.com/authentication/token-types#bot) with the read scopes for the channels.

```bash
# All channels
libscope connect slack --token xoxb-your-bot-token

# Some channels
libscope connect slack --token xoxb-... --channels general,engineering --thread-mode aggregate

# Thread modes:
#   aggregate: one document per thread (default)
#   separate:  one document per reply

# Sync again (messages since the last sync)
libscope sync slack

libscope disconnect slack
```

## OneNote

Sync OneNote notebooks through the Microsoft Graph API. LibScope signs in with a device code: it prints a URL and a code, and you sign in in a browser.

```bash
# Sign in and sync (needs an Azure app registration client ID)
libscope connect onenote --client-id your-client-id

# One notebook only
libscope connect onenote --notebook "Work Notes"

# Sync again (the access token is refreshed when it has expired)
libscope sync onenote

# Use an access token instead of signing in (it cannot be refreshed)
libscope connect onenote --token "$GRAPH_ACCESS_TOKEN"

libscope disconnect onenote
```

You need an Azure AD app registration with the `Notes.Read` permission. See [Microsoft's guide](https://learn.microsoft.com/en-us/graph/auth-register-app-v2). `--tenant-id` defaults to `common`.

## Documentation sites

Crawl a documentation site (Sphinx, VitePress, Doxygen or a generic site). The site type is detected unless you set `--site-type`.

```bash
libscope connect docs https://docs.example.com --library example --lib-version 2.0
libscope connect docs https://docs.example.com --name example-guide --path-prefix /guide --max-pages 200
libscope sync example-guide
```

The defaults are 500 pages and a link depth of 10.

## GitHub and GitLab repositories

A repository is not a connector. Add it with `libscope add`:

```bash
# Public repository
libscope add https://github.com/org/repo

# Private repository, one branch, some folders and file types
libscope add https://github.com/org/private-repo \
  --token "$GITHUB_TOKEN" \
  --branch develop \
  --path docs \
  --extensions .md,.mdx,.rst
```

See [Code Indexing](/guide/code-indexing) for source code.

## MCP and REST

Credentials are never tool or request parameters. Save the connection with `libscope connect` first. Then:

- **MCP**: the `sync` tool in the admin toolset (`LIBSCOPE_MCP_TOOLSETS=admin`) syncs one connection (`{"name": "notion"}`) or all of them (`{"all": true}`). With `async: true` it returns a task ID; `task {"action": "cancel", "taskId": "..."}` stops the sync. See the [MCP Tools Reference](/reference/mcp-tools#sync).
- **REST**: `POST /api/v1/sync` with `{ "name": "notion" }` or `{ "all": true }` starts a task. `GET /api/v1/connections` lists the connections (secrets masked), and `DELETE /api/v1/connections/:name` disconnects one. See the [REST API reference](/reference/rest-api).
