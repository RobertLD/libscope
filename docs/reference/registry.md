# Registry Reference

Complete reference for the git-based pack registry feature.

## CLI Commands

### `libscope registry add`

Register a git repository as a pack registry.

```bash
libscope registry add <git-url> [options]
```

| Option                        | Description                                              |
| ----------------------------- | -------------------------------------------------------- |
| `<git-url>`                   | Git clone URL (HTTPS or SSH)                             |
| `-n, --name <alias>`         | Short name for this registry (default: inferred from URL)|
| `--priority <n>`             | Priority for conflict resolution — lower wins (default: 10) |
| `--sync-interval <seconds>`  | Auto-sync interval in seconds, 0 = manual only (default: 0) |
| `--no-sync`                  | Skip the initial sync after adding                       |

```bash
# Examples
libscope registry add https://github.com/org/registry.git
libscope registry add git@github.com:team/packs.git --name team --priority 5
libscope registry add https://github.com/org/registry.git --sync-interval 86400
```

### `libscope registry remove`

Unregister a registry and delete its local cache.

```bash
libscope registry remove <name> [-y, --yes]
```

| Option       | Description                |
| ------------ | -------------------------- |
| `-y, --yes`  | Skip confirmation prompt   |

### `libscope registry list`

List all configured registries with their sync status.

```bash
libscope registry list
```

Output includes: name, URL, priority, pack count, and last synced timestamp.

### `libscope registry sync`

Manually sync one or all registries (git fetch + fast-forward).

```bash
libscope registry sync [<name>]
```

Without a name, syncs all registries. With a name, syncs only that registry.

### `libscope registry search`

Search across cached registry indexes.

```bash
libscope registry search <query> [-r, --registry <name>]
```

| Option                | Description                                    |
| --------------------- | ---------------------------------------------- |
| `<query>`             | Search term (matches name, description, tags, author) |
| `-r, --registry <name>` | Limit search to a specific registry          |

```bash
# Examples
libscope registry search "react"
libscope registry search "kubernetes" -r official
```

### `libscope registry create`

Initialize a new empty registry repo with the correct folder structure.

```bash
libscope registry create <path>
```

Creates a git repo with:
- `index.json` — empty pack index (JSON array)
- `packs/` — directory for pack contents (with `.gitkeep`)
- An initial commit

### `libscope registry publish`

Publish a pack file to a registry.

```bash
libscope registry publish <packFile> -r <name> [options]
```

| Option                  | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `<packFile>`            | Path to the pack `.json` file to publish                 |
| `-r, --registry <name>` | Target registry (required)                              |
| `--version <semver>`    | Version to publish as (default: auto-bump patch)         |
| `-m, --message <msg>`   | Git commit message                                      |
| `--submit`              | Push to a feature branch instead of main (for PR workflow) |

**Direct publish** (you have write access):
```bash
libscope registry publish ./react-docs.json -r my-registry --version 1.0.0
```

**Submit for inclusion** (you don't have write access):
```bash
libscope registry publish ./react-docs.json -r community --submit
```

The `--submit` flag creates a `feature/add-<pack-name>` branch and pushes it. You then create a pull request manually.

### `libscope registry unpublish`

Remove a specific pack version from a registry.

```bash
libscope registry unpublish <packName> -r <name> --version <semver> [options]
```

| Option                  | Description                       |
| ----------------------- | --------------------------------- |
| `<packName>`            | Name of the pack to unpublish     |
| `-r, --registry <name>` | Target registry (required)       |
| `--version <semver>`    | Version to remove (required)      |
| `-m, --message <msg>`   | Git commit message                |
| `-y, --yes`             | Skip confirmation prompt          |

If the last version of a pack is unpublished, the entire pack is removed from the registry index.

### `libscope pack install` (extended)

The existing `pack install` command is extended to resolve packs from registries.

```bash
libscope pack install <name> [--version <semver>] [--registry <name>]
```

| Option               | Description                                    |
| -------------------- | ---------------------------------------------- |
| `--version <semver>` | Install a specific version (default: latest)   |
| `--registry <name>`  | Install from a specific registry               |

```bash
# Install latest from any registry
libscope pack install react-docs

# Install specific version
libscope pack install react-docs@1.2.0
libscope pack install react-docs --version 1.2.0

# Install from a specific registry
libscope pack install react-docs --registry official
```

---

## Registry Folder Structure

A registry repo has this canonical structure (managed by libscope, never hand-edited):

```
registry-root/
  index.json                    # Top-level index — JSON array of PackSummary
  packs/
    <pack-name>/
      pack.json                 # Full pack metadata + version history
      1.0.0/
        <pack-name>.json        # The actual knowledge pack file
        checksum.sha256         # SHA-256 checksum of the pack file
      1.1.0/
        <pack-name>.json
        checksum.sha256
```

---

## Schema: `index.json`

A JSON array of pack summaries for fast search without traversing subdirectories.

```json
[
  {
    "name": "react-docs",
    "description": "Official React documentation",
    "tags": ["react", "frontend", "javascript"],
    "latestVersion": "2.1.0",
    "author": "react-team",
    "updatedAt": "2026-03-10T14:30:00Z"
  },
  {
    "name": "kubernetes-ops",
    "description": "Kubernetes operations runbooks",
    "tags": ["kubernetes", "devops", "infrastructure"],
    "latestVersion": "1.0.0",
    "author": "platform-eng",
    "updatedAt": "2026-02-28T09:00:00Z"
  }
]
```

| Field            | Type       | Description                              |
| ---------------- | ---------- | ---------------------------------------- |
| `name`           | `string`   | Pack name (unique within the registry)   |
| `description`    | `string`   | One-line description                     |
| `tags`           | `string[]` | Tags/categories for search filtering     |
| `latestVersion`  | `string`   | Latest published semver version          |
| `author`         | `string`   | Author name or handle                    |
| `updatedAt`      | `string`   | ISO-8601 timestamp of last publish       |

## Schema: `pack.json`

Per-pack manifest with full metadata and version history.

```json
{
  "name": "react-docs",
  "description": "Official React documentation",
  "tags": ["react", "frontend", "javascript"],
  "author": "react-team",
  "license": "MIT",
  "versions": [
    {
      "version": "2.1.0",
      "publishedAt": "2026-03-10T14:30:00Z",
      "checksumPath": "2.1.0/checksum.sha256",
      "checksum": "a1b2c3d4e5f6...",
      "docCount": 42
    },
    {
      "version": "2.0.0",
      "publishedAt": "2026-02-15T10:00:00Z",
      "checksumPath": "2.0.0/checksum.sha256",
      "checksum": "f6e5d4c3b2a1...",
      "docCount": 38
    }
  ]
}
```

| Field                    | Type       | Description                                    |
| ------------------------ | ---------- | ---------------------------------------------- |
| `name`                   | `string`   | Pack name                                      |
| `description`            | `string`   | One-line description                           |
| `tags`                   | `string[]` | Tags/categories                                |
| `author`                 | `string`   | Author name or handle                          |
| `license`                | `string`   | License identifier (e.g. "MIT")                |
| `versions[].version`     | `string`   | Semver version string                          |
| `versions[].publishedAt` | `string`   | ISO-8601 publish timestamp                     |
| `versions[].checksumPath`| `string`   | Relative path to the checksum file             |
| `versions[].checksum`    | `string`   | SHA-256 checksum hex value                     |
| `versions[].docCount`    | `number`   | Number of documents in this version            |

Versions are ordered newest first.

---

## Configuration

Registries are stored in `~/.libscope/config.json` under the `registries` key:

```json
{
  "registries": [
    {
      "name": "official",
      "url": "git@github.com:org/libscope-registry.git",
      "syncInterval": 86400,
      "priority": 10,
      "lastSyncedAt": "2026-03-10T14:30:00Z"
    },
    {
      "name": "team",
      "url": "https://github.com/team/internal-packs.git",
      "syncInterval": 0,
      "priority": 5,
      "lastSyncedAt": null
    }
  ]
}
```

| Field          | Type              | Description                                        | Default |
| -------------- | ----------------- | -------------------------------------------------- | ------- |
| `name`         | `string`          | Local alias for the registry                       | —       |
| `url`          | `string`          | Git clone URL (HTTPS or SSH)                       | —       |
| `syncInterval` | `number`          | Auto-sync interval in seconds (0 = manual only)    | `0`     |
| `priority`     | `number`          | Conflict resolution priority — lower wins          | `10`    |
| `lastSyncedAt` | `string \| null`  | ISO-8601 timestamp of last sync, null if never     | `null`  |

You can edit this file directly or use `libscope registry add/remove`.

---

## Authentication

libscope delegates all authentication to git. No special auth configuration is needed.

- **SSH**: If you have SSH keys configured (`~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, or via ssh-agent), SSH URLs (`git@github.com:...`) work automatically.
- **HTTPS**: If you have a git credential helper configured (`git config credential.helper`), HTTPS URLs work automatically. GitHub CLI (`gh auth setup-git`), macOS Keychain, and Windows Credential Manager are all supported.

To test access: `git ls-remote <registry-url>`. If that works, libscope will too.

---

## Offline Behavior

Registries cache their index locally at `~/.libscope/registries/<name>/`.

| Scenario                              | Behavior                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Registry unreachable, cache exists    | Uses cached index with warning: "Registry '\<name\>' is unreachable. Using cached index from \<date\>." |
| Registry unreachable, no cache        | Fails with: "Registry '\<name\>' has never been synced and is unreachable."                |
| Cache stale, registry reachable       | Auto-syncs before proceeding                                                               |

Pack content downloads still require network access — only the index lookup can work offline.

---

## Checksum Validation

Every pack version includes a `checksum.sha256` file containing the SHA-256 hex hash of the pack file.

- **On publish**: libscope generates the checksum automatically and writes it alongside the pack file.
- **On install**: libscope verifies the checksum before extracting. A mismatch fails with: "Checksum verification failed — the pack file may have been tampered with or corrupted."

---

## Versioning

Pack versions follow [semver](https://semver.org/):

- Versions must be valid semver strings (e.g. `1.0.0`, `2.3.1`)
- `pack install <name>` installs the latest version
- `pack install <name>@1.0.0` or `--version 1.0.0` installs a specific version
- Old versions are preserved in the registry — publishing a new version does not remove previous ones
- When publishing without `--version`, the patch version is auto-bumped from the latest
- The `latestVersion` in `index.json` always points to the most recently published version

## Conflict Resolution

When multiple registries contain a pack with the same name:

- **Priority-based** (default): the registry with the lowest `priority` value wins
- **Explicit**: use `--registry <name>` to specify which registry to use
- **Interactive**: when running in a terminal without `--registry`, libscope prompts you to choose

In non-interactive / CI mode, conflicts without `--registry` fail with an actionable error.
