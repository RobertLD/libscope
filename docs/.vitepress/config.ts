import { defineConfig } from "vitepress";

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
        text: "v1.1.0",
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
            {
              text: "Programmatic Usage",
              link: "/guide/programmatic-usage",
            },
          ],
        },
        {
          text: "Deep Dives",
          items: [
            { text: "How Search Works", link: "/guide/how-search-works" },
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
