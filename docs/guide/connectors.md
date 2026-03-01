# Connectors

Connectors pull documents from external tools into your LibScope knowledge base. Each connector handles authentication, pagination, and incremental sync so you don't have to think about it.

## Obsidian

Sync an entire Obsidian vault. Parses frontmatter, wikilinks, embeds, and tags. Folder structure maps to topics.

```bash
# Initial sync
libscope connect obsidian /path/to/vault

# Map topics from frontmatter instead of folder structure
libscope connect obsidian /path/to/vault --topic-mapping frontmatter

# Incremental re-sync (only changed files)
libscope connect obsidian /path/to/vault --sync

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

# Re-sync (uses stored token)
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

# Re-sync
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

# Re-sync with token refresh
libscope connect onenote --sync

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
