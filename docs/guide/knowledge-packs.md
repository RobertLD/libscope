# Knowledge Packs

Knowledge packs are portable collections of documents you can share, install, and version. Think of them like npm packages, but for documentation.

## Installing Packs

```bash
# From a local file
libscope pack install ./react-docs.json

# From a registry
libscope pack install react-docs --registry https://registry.example.com

# List installed packs
libscope pack list

# List available packs from a registry
libscope pack list --available
```

When you install a pack, its documents get indexed into your knowledge base just like any other content. They show up in search results and can be queried via RAG.

## Creating Packs

You can export documents from your knowledge base as a pack:

```bash
libscope pack create \
  --name "react-docs" \
  --topic react \
  --version 1.0.0 \
  --description "React documentation" \
  --author "team"
```

This creates a JSON file containing the documents, their metadata, and topic assignments. Share it with your team, commit it to a repo, or publish it to a registry.

## Removing Packs

```bash
libscope pack remove react-docs
```

This removes the pack's documents from your knowledge base.

## MCP Usage

Packs are also available via MCP tools:

- `install-pack` — install from registry or file path
- `list-packs` — list installed or available packs

Your AI assistant can install packs directly when it needs documentation for a specific library.
