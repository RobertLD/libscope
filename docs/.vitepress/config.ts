import { defineConfig } from "vitepress";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

export default defineConfig({
  title: "LibScope",
  description:
    "AI-powered knowledge base with MCP integration — index, search, and query your documentation with semantic search.",
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#5b7ee5" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "AI-powered knowledge base with MCP integration. Semantic search over your docs, wikis, and notes.",
      },
    ],
  ],
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/cli" },
      {
        text: `v${version}`,
        items: [
          {
            text: "Changelog",
            link: "/changelog",
          },
          {
            text: "Contributing",
            link: "/contributing",
          },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Configuration", link: "/guide/configuration" },
          ],
        },
        {
          text: "Integrations",
          items: [
            { text: "MCP Setup", link: "/guide/mcp-setup" },
            { text: "Connectors", link: "/guide/connectors" },
            { text: "Knowledge Packs", link: "/guide/knowledge-packs" },
            { text: "Pack Registries", link: "/guide/pack-registries" },
            {
              text: "Programmatic Usage",
              link: "/guide/programmatic-usage",
            },
            { text: "LibScope Lite", link: "/guide/lite" },
            { text: "Code Indexing", link: "/guide/code-indexing" },
          ],
        },
        {
          text: "Features",
          items: [
            { text: "Web Dashboard", link: "/guide/dashboard" },
            { text: "Webhooks", link: "/guide/webhooks" },
          ],
        },
        {
          text: "Deep Dives",
          items: [
            { text: "How Search Works", link: "/guide/how-search-works" },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI Commands", link: "/reference/cli" },
            { text: "MCP Tools", link: "/reference/mcp-tools" },
            { text: "REST API", link: "/reference/rest-api" },
            { text: "LibScope Lite API", link: "/reference/lite-api" },
            { text: "Registry", link: "/reference/registry" },
            { text: "Configuration", link: "/reference/configuration" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/RobertLD/libscope" },
      { icon: "npm", link: "https://www.npmjs.com/package/libscope" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/RobertLD/libscope/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the Business Source License 1.1.",
      copyright: "Copyright © 2026 RobertLD",
    },
  },
});
