import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { connectSettings, type ConnectFlags } from "../../src/cli/commands/connectors.js";
import { ValidationError } from "../../src/errors.js";

const noFlags: ConnectFlags = { sync: true };

describe("connectSettings", () => {
  it("notion passes the token and excluded pages", () => {
    expect(
      connectSettings("notion", undefined, { sync: true, token: "t", exclude: "a, b" }, true),
    ).toEqual({
      token: "t",
      excludePages: ["a", "b"],
    });
  });

  it("slack applies defaults only to a new connection", () => {
    expect(connectSettings("slack", undefined, noFlags, true)).toEqual({
      token: undefined,
      channels: ["all"],
      excludeChannels: undefined,
      threadMode: "aggregate",
    });
    expect(connectSettings("slack", undefined, noFlags, false)).toEqual({
      token: undefined,
      channels: undefined,
      excludeChannels: undefined,
      threadMode: undefined,
    });
    expect(
      connectSettings(
        "slack",
        undefined,
        { sync: true, channels: "x", threadMode: "separate" },
        true,
      ),
    ).toMatchObject({ channels: ["x"], threadMode: "separate" });
  });

  it("confluence needs a base URL for a new connection", () => {
    expect(() => connectSettings("confluence", undefined, noFlags, true)).toThrow(ValidationError);
    expect(connectSettings("confluence", "https://c.example", noFlags, true)).toEqual({
      baseUrl: "https://c.example",
      type: "cloud",
      email: undefined,
      token: undefined,
      spaces: ["all"],
      excludeSpaces: undefined,
    });
  });

  it("confluence keeps saved values for an existing connection", () => {
    expect(connectSettings("confluence", undefined, noFlags, false)).toEqual({
      baseUrl: undefined,
      type: undefined,
      email: undefined,
      token: undefined,
      spaces: undefined,
      excludeSpaces: undefined,
    });
  });

  it.each([true, false])("confluence --server sets the server type (new: %s)", (isNew) => {
    const settings = connectSettings(
      "confluence",
      "https://c.example",
      { sync: true, server: true },
      isNew,
    );
    expect(settings["type"]).toBe("server");
  });

  it("obsidian resolves the vault path and applies defaults to a new connection", () => {
    expect(connectSettings("obsidian", "vault", noFlags, true)).toEqual({
      vaultPath: resolve("vault"),
      topicMapping: "folder",
      excludePatterns: [],
    });
    expect(() => connectSettings("obsidian", undefined, noFlags, true)).toThrow(ValidationError);
  });

  it("obsidian keeps saved values for an existing connection", () => {
    expect(connectSettings("obsidian", undefined, noFlags, false)).toEqual({
      vaultPath: undefined,
      topicMapping: undefined,
      excludePatterns: undefined,
    });
    expect(connectSettings("obsidian", "", noFlags, false)["vaultPath"]).toBe("");
    expect(
      connectSettings("obsidian", "v2", { sync: true, topicMapping: "tags", exclude: "x" }, false),
    ).toEqual({ vaultPath: resolve("v2"), topicMapping: "tags", excludePatterns: ["x"] });
  });

  it("onenote applies defaults to a new connection", () => {
    expect(connectSettings("onenote", undefined, noFlags, true)).toEqual({
      clientId: "",
      tenantId: "common",
      notebooks: ["all"],
      excludeSections: [],
    });
  });

  it("onenote keeps saved values for an existing connection", () => {
    expect(connectSettings("onenote", undefined, noFlags, false)).toEqual({
      clientId: undefined,
      tenantId: undefined,
      notebooks: undefined,
      excludeSections: undefined,
    });
  });

  it.each([true, false])("onenote --notebook and --token override (new: %s)", (isNew) => {
    expect(
      connectSettings(
        "onenote",
        undefined,
        { sync: true, notebook: "Work", token: "tok", clientId: "c", tenantId: "t" },
        isNew,
      ),
    ).toMatchObject({
      clientId: "c",
      tenantId: "t",
      notebooks: ["Work"],
      accessToken: "tok",
      refreshToken: undefined,
      tokenExpiry: undefined,
    });
  });

  it("docs needs a site URL for a new connection and passes the crawl flags", () => {
    expect(() => connectSettings("docs", undefined, noFlags, true)).toThrow(ValidationError);
    expect(
      connectSettings(
        "docs",
        "https://docs.example",
        {
          sync: true,
          siteType: "sphinx",
          library: "lib",
          libVersion: "1",
          maxPages: 5,
          maxDepth: 2,
          pathPrefix: "/p",
        },
        true,
      ),
    ).toEqual({
      url: "https://docs.example",
      type: "sphinx",
      library: "lib",
      version: "1",
      maxPages: 5,
      maxDepth: 2,
      pathPrefix: "/p",
    });
    expect(connectSettings("docs", undefined, noFlags, false)["url"]).toBeUndefined();
  });
});
