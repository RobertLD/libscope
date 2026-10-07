# Knowledge Packs

Knowledge packs are portable collections of documents you can share, install, and version. Think of them like npm packages, but for documentation. A pack is a `.json` file, or a gzip-compressed `.json.gz` file.

## Installing Packs

```bash
# From a local file
libscope pack install ./react-docs.json
libscope pack install ./react-docs.json.gz

# From a pack registry (see Pack Registries)
libscope pack install react-docs
libscope pack install react-docs@1.2.0
libscope pack install react-docs --registry official

# List installed packs
libscope pack list

# List the packs available in your registries
libscope pack list --available
```

Pack names are looked up in the git [pack registries](/guide/pack-registries) you added with `libscope registry add`. When you install a pack, its documents get indexed into your knowledge base just like any other content. They show up in search results and can be queried via RAG.

## Creating Packs

You can export documents from your knowledge base as a pack:

```bash
libscope pack create \
  --name "react-docs" \
  --topic react \
  --pack-version 1.0.0 \
  --description "React documentation" \
  --author "team"
```

This creates a JSON file containing the documents, their metadata, and topic assignments. Share it with your team, commit it to a repo, or [publish it to a registry](/guide/pack-registries#publishing-packs).

## Removing Packs

```bash
libscope pack remove react-docs
```

This removes the pack's documents from your knowledge base.

## MCP Usage

Packs are also available in the MCP admin toolset (see [MCP tools](/reference/mcp-tools)):

- `install-pack` — install a pack by name (or `name@version`) from the configured registries. Local pack files can be installed only with the CLI or the Node.js API.
- `list-packs` — list installed packs, or with `available: true` the packs in the configured registries

Your AI assistant can install packs directly when it needs documentation for a specific library.
