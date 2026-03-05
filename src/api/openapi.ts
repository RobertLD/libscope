export const OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "LibScope REST API",
    version: "1.0.0",
    description: "AI-powered knowledge base with semantic search, document indexing, and RAG Q&A.",
  },
  servers: [{ url: "http://localhost:3378", description: "Local development" }],
  paths: {
    "/api/v1/search": {
      get: {
        summary: "Semantic search",
        operationId: "searchDocuments",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Search query",
          },
          {
            name: "topic",
            in: "query",
            schema: { type: "string" },
            description: "Filter by topic",
          },
          { name: "tag", in: "query", schema: { type: "string" }, description: "Filter by tag" },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 10 },
            description: "Max results",
          },
        ],
        responses: {
          "200": {
            description: "Search results",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchResponse" },
                example: {
                  data: {
                    results: [
                      {
                        documentId: "abc123",
                        title: "Getting Started",
                        content: "...",
                        score: 0.95,
                      },
                    ],
                    totalCount: 1,
                  },
                  meta: { took: 42 },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/documents": {
      get: {
        summary: "List documents with filters",
        operationId: "listDocuments",
        parameters: [
          { name: "topic", in: "query", schema: { type: "string" } },
          { name: "tag", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "List of documents",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/DocumentListResponse" } },
            },
          },
        },
      },
      post: {
        summary: "Index a new document",
        operationId: "indexDocument",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IndexDocumentRequest" },
              example: { content: "# Guide\nHow to...", title: "My Guide", topic: "tutorials" },
            },
          },
        },
        responses: {
          "201": {
            description: "Document indexed",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/DocumentResponse" } },
            },
          },
        },
      },
    },
    "/api/v1/documents/{id}": {
      get: {
        summary: "Get a single document",
        operationId: "getDocument",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Document found",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/DocumentResponse" } },
            },
          },
          "404": { description: "Document not found" },
        },
      },
      delete: {
        summary: "Delete a document",
        operationId: "deleteDocument",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Document deleted" },
          "404": { description: "Document not found" },
        },
      },
    },
    "/api/v1/documents/url": {
      post: {
        summary: "Index document from URL (with optional spidering)",
        operationId: "indexFromUrl",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IndexFromUrlRequest" },
              examples: {
                single: {
                  summary: "Single URL",
                  value: { url: "https://example.com/page", topic: "guides" },
                },
                spider: {
                  summary: "Spider mode",
                  value: {
                    url: "https://docs.example.com",
                    spider: true,
                    maxPages: 50,
                    maxDepth: 2,
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description:
              "Document(s) indexed. Returns DocumentResponse for single-URL mode, SpiderResponse for spider mode.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/DocumentResponse" },
                    { $ref: "#/components/schemas/SpiderResponse" },
                  ],
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/ask": {
      post: {
        summary: "RAG Q&A — ask a question",
        operationId: "askQuestion",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AskRequest" },
              example: { question: "How do I configure authentication?", topic: "security" },
            },
          },
        },
        responses: {
          "200": {
            description: "Answer with sources",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AskResponse" } },
            },
          },
        },
      },
    },
    "/api/v1/topics": {
      get: {
        summary: "List all topics",
        operationId: "listTopics",
        responses: {
          "200": {
            description: "List of topics",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/TopicListResponse" } },
            },
          },
        },
      },
      post: {
        summary: "Create a topic",
        operationId: "createTopic",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateTopicRequest" },
              example: { name: "tutorials", parentId: null },
            },
          },
        },
        responses: {
          "201": {
            description: "Topic created",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/TopicResponse" } },
            },
          },
        },
      },
    },
    "/api/v1/tags": {
      get: {
        summary: "List all tags",
        operationId: "listTags",
        responses: {
          "200": {
            description: "List of tags",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/TagListResponse" } },
            },
          },
        },
      },
    },
    "/api/v1/documents/{id}/tags": {
      post: {
        summary: "Add tags to a document",
        operationId: "addTagsToDocument",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AddTagsRequest" },
              example: { tags: ["typescript", "api"] },
            },
          },
        },
        responses: {
          "200": { description: "Tags added" },
        },
      },
    },
    "/api/v1/stats": {
      get: {
        summary: "Usage statistics",
        operationId: "getStats",
        responses: {
          "200": {
            description: "Statistics",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/StatsResponse" } },
            },
          },
        },
      },
    },
    "/api/v1/health": {
      get: {
        summary: "Health check",
        operationId: "healthCheck",
        responses: {
          "200": {
            description: "Service health",
            content: {
              "application/json": {
                example: { data: { status: "ok", docCount: 42, dbSize: 1048576 } },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "OpenAPI 3.0 specification",
        operationId: "getOpenApiSpec",
        responses: {
          "200": { description: "OpenAPI spec JSON" },
        },
      },
    },
  },
  components: {
    schemas: {
      SearchResponse: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    documentId: { type: "string" },
                    title: { type: "string" },
                    content: { type: "string" },
                    score: { type: "number" },
                  },
                },
              },
              totalCount: { type: "integer" },
            },
          },
          meta: { type: "object", properties: { took: { type: "number" } } },
        },
      },
      DocumentListResponse: {
        type: "object",
        properties: { data: { type: "array", items: { $ref: "#/components/schemas/Document" } } },
      },
      DocumentResponse: {
        type: "object",
        properties: { data: { $ref: "#/components/schemas/Document" } },
      },
      Document: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          sourceType: { type: "string" },
          library: { type: "string", nullable: true },
          topicId: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      IndexDocumentRequest: {
        type: "object",
        required: ["content", "title"],
        properties: {
          content: { type: "string" },
          title: { type: "string" },
          topic: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
      },
      IndexFromUrlRequest: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
          topic: { type: "string" },
          spider: {
            type: "boolean",
            description: "When true, crawl linked pages starting from the URL (BFS spider mode).",
          },
          maxPages: {
            type: "integer",
            minimum: 1,
            description:
              "Maximum total pages to fetch in spider mode (default: 25, hard cap: 200).",
          },
          maxDepth: {
            type: "integer",
            minimum: 0,
            description:
              "Maximum hop depth from the seed URL in spider mode (default: 2, hard cap: 5).",
          },
          sameDomain: {
            type: "boolean",
            description: "Only follow links sharing the seed hostname (default: true).",
          },
          pathPrefix: {
            type: "string",
            description: "Only follow links whose path starts with this prefix (e.g. '/docs/').",
          },
          excludePatterns: {
            type: "array",
            items: { type: "string" },
            description: "Glob patterns for URLs to skip during spidering (e.g. ['*/changelog*']).",
          },
        },
      },
      SpiderResponse: {
        type: "object",
        properties: {
          documents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
              },
            },
          },
          pagesFetched: { type: "integer", description: "Pages successfully fetched and indexed." },
          pagesCrawled: { type: "integer", description: "Total pages attempted." },
          pagesSkipped: { type: "integer", description: "Pages skipped by filters or robots.txt." },
          errors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                error: { type: "string" },
              },
            },
          },
          abortReason: {
            type: "string",
            nullable: true,
            enum: ["maxPages", "timeout", null],
            description: "Set if the crawl was aborted early.",
          },
        },
      },
      AskRequest: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string" },
          topic: { type: "string" },
        },
      },
      AskResponse: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              answer: { type: "string" },
              sources: { type: "array", items: { type: "object" } },
              model: { type: "string" },
            },
          },
        },
      },
      CreateTopicRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          parentId: { type: "string", nullable: true },
        },
      },
      TopicResponse: {
        type: "object",
        properties: { data: { type: "object" } },
      },
      TopicListResponse: {
        type: "object",
        properties: { data: { type: "array", items: { type: "object" } } },
      },
      TagListResponse: {
        type: "object",
        properties: { data: { type: "array", items: { type: "object" } } },
      },
      AddTagsRequest: {
        type: "object",
        required: ["tags"],
        properties: { tags: { type: "array", items: { type: "string" } } },
      },
      StatsResponse: {
        type: "object",
        properties: { data: { $ref: "#/components/schemas/Stats" } },
      },
      Stats: {
        type: "object",
        properties: {
          totalDocuments: { type: "integer" },
          totalChunks: { type: "integer" },
          totalTopics: { type: "integer" },
          databaseSizeBytes: { type: "integer" },
          totalSearches: { type: "integer" },
          avgLatencyMs: { type: "number" },
        },
      },
    },
  },
} as const;
