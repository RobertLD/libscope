import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateDeviceCode } from "../../src/connectors/onenote.js";

const sleep = vi.hoisted(() => vi.fn((_ms: number) => Promise.resolve()));
vi.mock("node:timers/promises", () => ({ setTimeout: sleep }));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Device code response, then the given token responses in order. */
function stubSignIn(expiresIn: number, tokenResponses: Array<() => Response>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url.includes("/devicecode") ? "devicecode" : "token");
      if (url.includes("/devicecode")) {
        return Promise.resolve(
          json({
            device_code: "dev",
            user_code: "CODE",
            verification_uri: "https://example.test/login",
            expires_in: expiresIn,
            interval: 2,
          }),
        );
      }
      const next = tokenResponses.shift();
      return Promise.resolve(next ? next() : json({ error: "authorization_pending" }, 400));
    }),
  );
  return calls;
}

describe("authenticateDeviceCode polling", () => {
  beforeEach(() => {
    sleep.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits the extra 5 seconds after slow_down and keeps polling", async () => {
    const calls = stubSignIn(900, [
      (): Response => json({ error: "slow_down" }, 400),
      (): Response => json({ error: "authorization_pending" }, 400),
      (): Response => json({ access_token: "a", refresh_token: "r", expires_in: 60 }),
    ]);

    const result = await authenticateDeviceCode("client");

    expect(result).toMatchObject({ accessToken: "a", refreshToken: "r" });
    expect(calls).toEqual(["devicecode", "token", "token", "token"]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 5000, 2000, 2000]);
  });

  it("times out without polling when the code has already expired", async () => {
    const calls = stubSignIn(0, []);

    await expect(authenticateDeviceCode("client")).rejects.toThrow(
      "Device code authentication timed out",
    );
    expect(calls).toEqual(["devicecode"]);
    expect(sleep).not.toHaveBeenCalled();
  });
});
