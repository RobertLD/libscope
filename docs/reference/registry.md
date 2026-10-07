# Registry Reference

Complete reference for git-based pack registries. A registry is a git repository of knowledge packs; `--registry <name>` always means the name of a configured registry.

## CLI Commands

### `libscope registry add`

Add a git repository as a pack registry and clone it.

```bash
libscope registry add <git-url> [options]
```

| Option              | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `<git-url>`         | Git URL: `https://`, `ssh://`, `git@host:path` or `file:///` |
| `-n, --name <name>` | Registry name (default: the last part of the URL)            |
| `--no-sync`         | Do not clone the registry now                                |

```bash
# Examples
libscope registry add https://github.com/org/registry.git
libscope registry add git@github.com:team/packs.git --name team
libscope registry add file:///srv/libscope-packs.git --no-sync
```

### `libscope registry remove`

Remove a registry and delete its local clone.

```bash
libscope registry remove <name> [-y, --yes]
```

| Option      | Description              |
| ----------- | ------------------------ |
| `-y, --yes` | Skip confirmation prompt |

### `libscope registry list`

List the configured registries.

```bash
libscope registry list
```

Output includes: name, URL, pack count, and last synced timestamp.

### `libscope registry sync`

Fetch the latest packs of one or all registries (git fetch + reset to the remote branch). This is the only command that updates the local copies.

```bash
libscope registry sync [<name>]
```

Without a name, syncs all registries. With a name, syncs only that registry. A registry that cannot be reached keeps its local copy (`offline`); one that was never cloned reports an error and the command exits with code 1.

### `libscope registry search`

Search the local copies of the registry indexes.

```bash
libscope registry search <query> [--registry <name>]
```

| Option              | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `<query>`           | Search term (matches name, description, tags, author) |
| `--registry <name>` | Search only this registry                             |

```bash
# Examples
libscope registry search "react"
libscope registry search "kubernetes" --registry official
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

Publish a pack file (`.json` or `.json.gz`) to a registry.

```bash
libscope registry publish <file> --registry <name> [options]
```

| Option                    | Description                                                             |
| ------------------------- | ----------------------------------------------------------------------- |
| `<file>`                  | Path to the pack `.json` or `.json.gz` file to publish                  |
| `--registry <name>`       | Target registry (required)                                              |
| `--pack-version <semver>` | Version to publish (default: next patch version, or the pack's version) |
| `-m, --message <msg>`     | Git commit message                                                      |
| `--submit`                | Push to a feature branch instead of main (for PR workflow)              |

**Direct publish** (you have write access):

```bash
libscope registry publish ./react-docs.json --registry my-registry --pack-version 1.0.0
```

**Submit for inclusion** (you don't have write access):

```bash
libscope registry publish ./react-docs.json --registry community --submit
```

The `--submit` flag creates a `feature/add-<pack-name>` branch and pushes it. You then create a pull request manually.

### `libscope registry unpublish`

Remove a specific pack version from a registry.

```bash
libscope registry unpublish <name>@<version> --registry <name> [options]
```

| Option                | Description                   |
| --------------------- | ----------------------------- |
| `<name>@<version>`    | Pack and version to unpublish |
| `--registry <name>`   | Target registry (required)    |
| `-m, --message <msg>` | Git commit message            |
| `-y, --yes`           | Skip confirmation prompt      |

If the last version of a pack is unpublished, the entire pack is removed from the registry index.

### `libscope pack install`

`pack install` resolves pack names from the configured registries.

```bash
libscope pack install <name>[@<version>] [--registry <name>]
```

| Option              | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `--registry <name>` | Look only in this registry (needed when several have the pack) |

```bash
# Install latest from the registry that has the pack
libscope pack install react-docs

# Install specific version
libscope pack install react-docs@1.2.0

# Install from a specific registry
libscope pack install react-docs --registry official
```

`libscope pack list --available [--registry <name>]` lists the packs in the registries.

### Other interfaces

| Operation           | Node.js API                    | REST                               | MCP (admin toolset) |
| ------------------- | ------------------------------ | ---------------------------------- | ------------------- |
| `list-registries`   | `scope.registries.list()`      | `GET /api/v1/registries`           | —                   |
| `search-registries` | `scope.registries.search()`    | `GET /api/v1/registries/search`    | —                   |
| `add-registry`      | `scope.registries.add()`       | —                                  | —                   |
| `remove-registry`   | `scope.registries.remove()`    | —                                  | —                   |
| `sync-registries`   | `scope.registries.sync()`      | —                                  | —                   |
| `create-registry`   | `scope.registries.create()`    | —                                  | —                   |
| `publish-pack`      | `scope.registries.publish()`   | —                                  | —                   |
| `unpublish-pack`    | `scope.registries.unpublish()` | —                                  | —                   |
| `install-pack`      | `scope.packs.install()`        | `POST /api/v1/packs`               | `install-pack`      |
| `list-packs`        | `scope.packs.list()`           | `GET /api/v1/packs?available=true` | `list-packs`        |

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

| Field           | Type       | Description                            |
| --------------- | ---------- | -------------------------------------- |
| `name`          | `string`   | Pack name (unique within the registry) |
| `description`   | `string`   | One-line description                   |
| `tags`          | `string[]` | Tags/categories for search filtering   |
| `latestVersion` | `string`   | Latest published semver version        |
| `author`        | `string`   | Author name or handle                  |
| `updatedAt`     | `string`   | ISO-8601 timestamp of last publish     |

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

| Field                     | Type       | Description                         |
| ------------------------- | ---------- | ----------------------------------- |
| `name`                    | `string`   | Pack name                           |
| `description`             | `string`   | One-line description                |
| `tags`                    | `string[]` | Tags/categories                     |
| `author`                  | `string`   | Author name or handle               |
| `license`                 | `string`   | License identifier (e.g. "MIT")     |
| `versions[].version`      | `string`   | Semver version string               |
| `versions[].publishedAt`  | `string`   | ISO-8601 publish timestamp          |
| `versions[].checksumPath` | `string`   | Relative path to the checksum file  |
| `versions[].checksum`     | `string`   | SHA-256 checksum hex value          |
| `versions[].docCount`     | `number`   | Number of documents in this version |

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
      "lastSyncedAt": "2026-03-10T14:30:00Z"
    },
    {
      "name": "team",
      "url": "https://github.com/team/internal-packs.git",
      "lastSyncedAt": null
    }
  ]
}
```

| Field          | Type             | Description                                                    | Default |
| -------------- | ---------------- | -------------------------------------------------------------- | ------- |
| `name`         | `string`         | Local name for the registry (`/^[a-zA-Z0-9_-]+$/`, 2-64 chars) | —       |
| `url`          | `string`         | Git URL: `https://`, `ssh://`, `git@host:path` or `file:///`   | —       |
| `lastSyncedAt` | `string \| null` | ISO-8601 timestamp of last sync, null if never                 | `null`  |

You can edit this file directly or use `libscope registry add/remove`.

---

## Authentication

libscope delegates all authentication to git. No special auth configuration is needed.

- **SSH**: If you have SSH keys configured (`~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, or via ssh-agent), SSH URLs (`git@github.com:...`) work automatically.
- **HTTPS**: If you have a git credential helper configured (`git config credential.helper`), HTTPS URLs work automatically. GitHub CLI (`gh auth setup-git`), macOS Keychain, and Windows Credential Manager are all supported.

To test access: `git ls-remote <registry-url>`. If that works, libscope will too.

---

## Offline Behavior

Each registry is cloned to `~/.libscope/registries/<name>/`. Searching, listing (`pack list --available`) and installing read only this local copy; they never use the network. The network is used only by `registry add`, `registry sync`, `registry publish` and `registry unpublish`.

| Scenario                                                 | Behavior                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `registry sync`, registry unreachable, local copy exists | Status `offline`: the local copy is kept and used                           |
| `registry sync`, registry unreachable, no local copy     | Status `error` and exit code 1                                              |
| Search, list or install, registry never synced           | The registry is skipped with a warning: run `libscope registry sync <name>` |

---

## Checksum Validation

Every pack version includes a `checksum.sha256` file containing the SHA-256 hex hash of the pack file.

- **On publish**: libscope generates the checksum automatically and writes it alongside the pack file.
- **On install**: libscope verifies the checksum before extracting. A mismatch fails with a `ValidationError`: "Checksum verification failed for ...: expected ..., got .... The pack file may have been tampered with or corrupted."

---

## Versioning

Pack versions follow [semver](https://semver.org/):

- Versions must be valid semver strings (e.g. `1.0.0`, `2.3.1`)
- `pack install <name>` installs the latest version
- `pack install <name>@1.0.0` installs a specific version
- Old versions are preserved in the registry — publishing a new version does not remove previous ones
- When publishing without `--pack-version`, the patch version is auto-bumped from the latest
- The `latestVersion` in `index.json` always points to the most recently published version

## Packs in Several Registries

When more than one configured registry has a pack with the same name, `pack install <name>` fails with an error that names the registries. Choose one with `--registry <name>` (`registry` in the Node.js, REST and MCP interfaces).
