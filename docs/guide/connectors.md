# Connectors

Connectors pull documents from external tools into your LibScope knowledge base. Each connector handles authentication, pagination, and incremental sync so you don't have to think about it.

## Saved Configs, Re-sync and Schedules

Every `libscope connect <type>` command saves its settings as a named connector config in `~/.libscope/connectors/<name>.json` (file mode 0600). The default name is the connector type. Use `--name` to keep more than one config of the same type:

```bash
libscope connect slack --token xoxb-work-token --name work-slack
```

A saved config holds what a later run needs, including credentials:

| Connector  | Saved fields                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Notion     | `token`, `excludePages`, `lastSync`                                                                  |
| Slack      | `token`, `channels`, `excludeChannels`, `threadMode`, `lastSync`                                     |
| Confluence | `baseUrl`, `type` (cloud/server), `email`, `token`, `spaces`, `excludeSpaces`, `lastSync`            |
| Obsidian   | `vaultPath`, `topicMapping`, `excludePatterns`, `lastSync`                                           |
| OneNote    | `clientId`, `tenantId`, `accessToken`, `refreshToken`, `tokenExpiry`, `notebooks`, `excludeSections`, `lastSync` |

Each file also stores `connectorType` and, after `libscope schedule set`, a `schedule`.

`--sync` on any connect command re-runs the saved config (`--name` selects which one). Other options on the command line are ignored with `--sync`. After each successful sync, `lastSync` is set to the time the sync started.

To sync a saved config on a schedule, set a cron expression. Schedules run while the API server is running (`libscope serve --api`):

```bash
libscope schedule set notion "0 */6 * * *"
libscope schedule list
libscope schedule remove notion
```

Each run, scheduled or manual, writes one entry to the connector sync history under the config name. `libscope disconnect <type>` also deletes the saved config (`--name` selects which one).

## Obsidian

Sync an entire Obsidian vault. Parses frontmatter, wikilinks, embeds, and tags. Folder structure maps to topics.

```bash
# Initial sync
libscope connect obsidian /path/to/vault

# Map topics from frontmatter instead of folder structure
libscope connect obsidian /path/to/vault --topic-mapping frontmatter

# Re-sync the saved vault config (only changed files are re-indexed)
libscope connect obsidian --sync

# Exclude folders
libscope connect obsidian /path/to/vault --exclude "templates/*" "daily/*"

# Remove vault data from LibScope
libscope disconnect obsidian /path/to/vault
```

## Notion

Sync pages and databases from your Notion workspace. Requires a [Notion integration token](https://www.notion.so/my-integrations).

```bash
# Sync with integration token
libscope connect notion --token secret_abc123

# Exclude specific pages or databases
libscope connect notion --token $NOTION_TOKEN --exclude page-id-1 db-id-2

# Re-sync with the saved config (pages edited since the last sync)
libscope connect notion --sync

# Disconnect
libscope disconnect notion
```

## Confluence

Sync Confluence Cloud spaces and pages. Requires an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).

```bash
# Sync all spaces
libscope connect confluence \
  --url https://acme.atlassian.net \
  --email user@acme.com \
  --token $CONFLUENCE_TOKEN

# Sync specific spaces
libscope connect confluence \
  --url https://acme.atlassian.net \
  --email user@acme.com \
  --token $CONFLUENCE_TOKEN \
  --spaces ENG,DEVOPS \
  --exclude-spaces ARCHIVE

# Re-sync with the saved config
libscope connect confluence --sync

# Disconnect
libscope disconnect confluence
```

## Slack

Index Slack channel messages and threads. Requires a [Slack bot token](https://api.slack.com/authentication/token-types#bot) with appropriate scopes.

```bash
# Sync all channels
libscope connect slack --token xoxb-your-bot-token

# Sync specific channels
libscope connect slack \
  --token xoxb-... \
  --channels general,engineering \
  --thread-mode aggregate

# Thread modes:
#   aggregate — combines thread replies into one document (default)
#   separate  — one document per reply

# Re-sync with the saved config (messages since the last sync)
libscope connect slack --sync

# Disconnect
libscope disconnect slack
```

## OneNote

Sync OneNote notebooks via the Microsoft Graph API. Uses device code authentication — you'll be prompted to open a browser and log in.

```bash
# Set your app registration client ID
export ONENOTE_CLIENT_ID=your-client-id

# Authenticate and sync
libscope connect onenote

# Sync a specific notebook
libscope connect onenote --notebook "Work Notes"

# Re-sync with the saved config (refreshes the access token when it has expired)
libscope connect onenote --sync

# Use an existing access token instead of signing in (it cannot be refreshed)
libscope connect onenote --token <access-token>

# Disconnect
libscope disconnect onenote
```

You'll need an Azure AD app registration with `Notes.Read` permission. See [Microsoft's guide](https://learn.microsoft.com/en-us/graph/auth-register-app-v2) for setup.

## GitHub / GitLab

Index documentation from any GitHub or GitLab repository.

```bash
# Public repo
libscope add-repo https://github.com/org/repo

# Private repo with token, specific branch and path
libscope add-repo https://github.com/org/private-repo \
  --token $GITHUB_TOKEN \
  --branch develop \
  --path docs/ \
  --extensions .md,.mdx,.rst
```

## MCP Usage

All connectors are also available as MCP tools, so your AI assistant can trigger syncs directly:

- `sync-obsidian-vault`
- `sync-notion`
- `sync-confluence`
- `sync-slack`
- `sync-onenote`

See the [MCP Tools Reference](/reference/mcp-tools) for parameter details.
