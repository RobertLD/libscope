# Pack Registries

Pack registries are git repositories with a well-defined folder structure that serve as shared catalogs of knowledge packs. You can add public or private registries, search them for packs, and install packs directly by name. If you maintain your own registry, you can publish packs to it — or submit packs to someone else's registry via a PR workflow.

Authentication is handled entirely by git. If you have SSH keys or an HTTPS credential helper configured, private registries work automatically.

## Adding a Registry

```bash
# Add a public registry (the name "libscope-registry" comes from the URL)
libscope registry add https://github.com/org/libscope-registry.git

# Add with a custom name
libscope registry add git@github.com:team/internal-packs.git --name team-packs

# Add a registry on a local or shared disk
libscope registry add file:///srv/libscope-packs.git

# Add without cloning now
libscope registry add https://github.com/org/registry.git --no-sync

# List configured registries
libscope registry list

# Remove a registry
libscope registry remove team-packs
```

When you add a registry, libscope clones it to `~/.libscope/registries/<name>/`. Later syncs fetch only changes.

## Searching Registries

```bash
# Search all registries
libscope registry search "react"

# Search a specific registry
libscope registry search "react" --registry official
```

Results show the pack name, description, tags, latest version, and which registry it came from.

## Installing Packs from a Registry

`pack install` finds pack names in your configured registries:

```bash
# Install the latest version
libscope pack install react-docs

# Install a specific version
libscope pack install react-docs@1.2.0

# Install from a specific registry
libscope pack install react-docs --registry official

# List the packs in all registries
libscope pack list --available
```

If more than one registry has a pack with the same name, the install fails and the error names the registries. Run it again with `--registry <name>`.

Before it installs a pack, libscope verifies the pack file against the checksum in the registry.

### Offline Behavior

Searching, listing and installing read only the local copies of the registries. They do not use the network. A registry that was never synced is skipped with a warning that tells you to run `libscope registry sync`.

## Syncing Registries

```bash
# Sync all registries
libscope registry sync

# Sync a specific registry
libscope registry sync official
```

Registries are synced only when you run `registry sync` (or `registry add`). If a registry cannot be reached, libscope keeps its local copy and reports it as offline.

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
libscope registry publish ./my-pack.json --registry my-registry --pack-version 1.0.0

# Publish the next patch version (from the latest in the registry)
libscope registry publish ./my-pack.json.gz --registry my-registry

# Submit a pack to someone else's registry (creates a feature branch)
libscope registry publish ./my-pack.json --registry community --submit

# Unpublish a specific version
libscope registry unpublish my-pack@1.0.0 --registry my-registry
```

Publishing assembles the pack into the registry's folder structure, generates a SHA-256 checksum, updates `index.json` and `pack.json`, and commits + pushes. The `--submit` flag pushes to a `feature/add-<pack-name>` branch instead — you then create a pull request manually.

### Checksum Validation

Every published pack version includes a `checksum.sha256` file. On install, libscope verifies the checksum before extracting. A mismatch fails the install with a clear error.

## Versioning

Pack versions follow [semver](https://semver.org/) (e.g. `1.0.0`, `1.2.3`). When you publish without `--pack-version`, the patch version is auto-bumped from the latest. Old versions are preserved in the registry. `pack install` defaults to the latest version unless you specify one with `name@version`.

## Other Interfaces

- **Node.js API:** `scope.registries.list()`, `.add()`, `.remove()`, `.sync()`, `.search()`, `.create()`, `.publish()`, `.unpublish()`, and `scope.packs.install({ pack, registry })`.
- **REST API:** `GET /api/v1/registries`, `GET /api/v1/registries/search`, `GET /api/v1/packs?available=true` and `POST /api/v1/packs` (read-only access to registries; add, sync and publish with the CLI or the Node.js API).
- **MCP (admin toolset):** `install-pack` installs from a registry by name, and `list-packs` with `available: true` browses the packs in the registries.

See the [Registry Reference](/reference/registry) for complete schema details, configuration format, and all CLI flags.
