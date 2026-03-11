# Pack Registries

Pack registries are git repositories with a well-defined folder structure that serve as shared catalogs of knowledge packs. You can add public or private registries, search them for packs, and install packs directly by name. If you maintain your own registry, you can publish packs to it — or submit packs to someone else's registry via a PR workflow.

Authentication is handled entirely by git. If you have SSH keys or an HTTPS credential helper configured, private registries work automatically.

## Adding a Registry

```bash
# Add a public registry
libscope registry add https://github.com/org/libscope-registry.git

# Add with a custom alias and priority
libscope registry add git@github.com:team/internal-packs.git --name team-packs --priority 5

# Add with auto-sync every 24 hours
libscope registry add https://github.com/org/registry.git --sync-interval 86400

# Add without cloning immediately
libscope registry add https://github.com/org/registry.git --no-sync

# List configured registries
libscope registry list

# Remove a registry
libscope registry remove team-packs
```

On first add, libscope clones the registry's index locally to `~/.libscope/registries/<name>/`. Subsequent syncs fetch only changes.

## Searching Registries

```bash
# Search all registries
libscope registry search "react"

# Search a specific registry
libscope registry search "react" -r official
```

Results show the pack name, description, tags, latest version, and which registry it came from.

## Installing Packs from a Registry

The existing `pack install` command now resolves packs from your configured registries:

```bash
# Install the latest version
libscope pack install react-docs

# Install a specific version
libscope pack install react-docs --version 1.2.0
# or
libscope pack install react-docs@1.2.0

# Install from a specific registry (skips conflict resolution)
libscope pack install react-docs --registry official
```

If multiple registries contain a pack with the same name, libscope resolves the conflict by priority (lower `priority` value wins). You can override this with `--registry <name>`.

### Offline Behavior

If a registry is unreachable during install, libscope falls back to the cached index with a warning. If the registry has never been synced, it tells you to run `libscope registry sync` when online.

## Syncing Registries

```bash
# Sync all registries
libscope registry sync

# Sync a specific registry
libscope registry sync official
```

Registries also auto-sync when the local cache is older than the configured `syncInterval` (in seconds). This happens automatically before pack installs when the cache is stale.

## Creating Your Own Registry

```bash
# Initialize a new registry repo
libscope registry create ./my-registry
cd my-registry && git remote add origin <your-git-url> && git push -u origin main
```

This creates a git repo with the correct folder structure (`index.json`, `packs/` directory) and an initial commit. Push it to any git host to share it.

## Publishing Packs

```bash
# Publish a pack file to a registry you own
libscope registry publish ./my-pack.json -r my-registry --version 1.0.0

# Auto-bump patch version (from latest in registry)
libscope registry publish ./my-pack.json -r my-registry

# Submit a pack to someone else's registry (creates a feature branch)
libscope registry publish ./my-pack.json -r community --submit

# Unpublish a specific version
libscope registry unpublish my-pack -r my-registry --version 1.0.0
```

Publishing assembles the pack into the registry's folder structure, generates a SHA-256 checksum, updates `index.json` and `pack.json`, and commits + pushes. The `--submit` flag pushes to a `feature/add-<pack-name>` branch instead — you then create a pull request manually.

### Checksum Validation

Every published pack version includes a `checksum.sha256` file. On install, libscope verifies the checksum before extracting. A mismatch fails the install with a clear error.

## Versioning

Pack versions follow [semver](https://semver.org/) (e.g. `1.0.0`, `1.2.3`). When you publish without `--version`, the patch version is auto-bumped from the latest. Old versions are preserved in the registry. `pack install` defaults to the latest version unless you specify one.

## MCP Usage

Your AI assistant can also work with registries through MCP:

- `install-pack` — install from a registry by name
- `list-packs --available` — browse packs available in registries

See the [Registry Reference](/reference/registry) for complete schema details, configuration format, and all CLI flags.
