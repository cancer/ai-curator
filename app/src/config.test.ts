import { describe, it, expect, vi } from "vitest";
import {
  loadConfig,
  saveConfig,
  loadUserConfigForForm,
  SYSTEM_CONFIG,
  DEFAULT_USER_CONFIG,
  type UserConfig,
} from "./config";
import type { Env } from "./index";

// KV に置くのは interestAxes / sources のみ（ユーザー可変データ）。
// 関心軸はラベルのみ（seedText は廃止）。sources は feeds のみ。
const validUser: UserConfig = {
  interestAxes: [
    { id: "web-fw", label: "Web フレームワーク" },
    { id: "ai", label: "AI" },
  ],
  sources: {
    feeds: ["https://martinfowler.com/feed.atom", "https://example.com/rss"],
  },
};

function createMockEnv(): Env {
  return {
    AI: {} as any,
    DB: {} as any,
    CONFIG: {
      get: vi.fn(),
      put: vi.fn(),
    } as any,
  } as any;
}

describe("config", () => {
  describe("loadConfig", () => {
    it("merges the KV UserConfig with SYSTEM_CONFIG into a full Config", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(
        JSON.stringify(validUser),
      );

      const result = await loadConfig(env);

      expect(result).toEqual({ ...validUser, ...SYSTEM_CONFIG });
      expect(env.CONFIG.get).toHaveBeenCalledWith("config:v1");
    });

    it("ignores system fields present in the KV value and uses SYSTEM_CONFIG", async () => {
      const env = createMockEnv();
      const polluted = {
        ...validUser,
        scoring: { garbage: true },
        embedding: { model: "x", maxInputChars: 1 },
        digest: { model: "y", maxOutputTokens: 1 },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(
        JSON.stringify(polluted),
      );

      const result = await loadConfig(env);

      expect(result.scoring).toEqual(SYSTEM_CONFIG.scoring);
      expect(result.embedding).toEqual(SYSTEM_CONFIG.embedding);
      expect(result.digest).toEqual(SYSTEM_CONFIG.digest);
    });

    it("throws when config key is not found", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(null);

      await expect(loadConfig(env)).rejects.toThrow(
        'Config key "config:v1" not found in KV',
      );
    });

    it("throws when JSON is invalid", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue("invalid json {");

      await expect(loadConfig(env)).rejects.toThrow(
        "Failed to parse config JSON",
      );
    });

    it("throws when interestAxes is missing", async () => {
      const env = createMockEnv();
      const user = { ...validUser };
      delete (user as any).interestAxes;
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "interestAxes must be an array",
      );
    });

    it("throws when interestAxes is empty", async () => {
      const env = createMockEnv();
      const user = { ...validUser, interestAxes: [] };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "interestAxes must not be empty",
      );
    });

    it("throws when an interestAxis has an empty id", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        interestAxes: [{ id: "", label: "Web FW" }],
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "InterestAxis.id must be a non-empty string",
      );
    });

    it("throws when an interestAxis has an empty label", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        interestAxes: [{ id: "web-fw", label: "" }],
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "InterestAxis.label must be a non-empty string",
      );
    });

    it("throws when interestAxes has duplicate ids", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        interestAxes: [
          { id: "dup", label: "A" },
          { id: "dup", label: "B" },
        ],
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        'Duplicate interestAxis id: "dup"',
      );
    });

    it("throws when sources is missing", async () => {
      const env = createMockEnv();
      const user = { ...validUser };
      delete (user as any).sources;
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow("sources must be an object");
    });

    it("throws when sources.feeds is not an array", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: { ...validUser.sources, feeds: "not-array" },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.feeds must be an array",
      );
    });

    it("throws when feeds has a non-URL entry", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: {
          ...validUser.sources,
          feeds: ["https://ok.example/rss", "not a url"],
        },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.feeds entries must be http(s):// URLs",
      );
    });

  });

  describe("saveConfig", () => {
    it("writes only interestAxes and sources to KV", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.put as any).mockResolvedValue(undefined);

      await saveConfig(env, validUser);

      expect(env.CONFIG.put).toHaveBeenCalledWith(
        "config:v1",
        JSON.stringify(validUser),
      );
    });

    it("never persists system fields even if present on the argument", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.put as any).mockResolvedValue(undefined);

      const polluted = {
        ...validUser,
        scoring: { anything: true },
        digest: { model: "z", maxOutputTokens: 1 },
      };

      await saveConfig(env, polluted as any);

      const [, written] = vi.mocked(env.CONFIG.put as any).mock.calls[0];
      const parsed = JSON.parse(written as string);
      expect(Object.keys(parsed).sort()).toEqual(["interestAxes", "sources"]);
    });

    it("throws validation error and does not write when UserConfig is invalid", async () => {
      const env = createMockEnv();
      const invalid = {
        ...validUser,
        interestAxes: [{ id: "web-fw", label: "" }],
      };

      await expect(saveConfig(env, invalid as any)).rejects.toThrow(
        "InterestAxis.label must be a non-empty string",
      );
      expect(env.CONFIG.put).not.toHaveBeenCalled();
    });

    it("accepts empty source lists", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.put as any).mockResolvedValue(undefined);

      const user: UserConfig = {
        ...validUser,
        sources: {
          ...validUser.sources,
          feeds: [],
        },
      };

      await saveConfig(env, user);

      expect(env.CONFIG.put).toHaveBeenCalled();
    });
  });

  describe("loadUserConfigForForm", () => {
    it("returns the KV UserConfig when present and valid", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(
        JSON.stringify(validUser),
      );

      const result = await loadUserConfigForForm(env);

      expect(result).toEqual(validUser);
    });

    it("returns DEFAULT_USER_CONFIG when KV is empty (does not throw)", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(null);

      const result = await loadUserConfigForForm(env);

      expect(result).toEqual(DEFAULT_USER_CONFIG);
    });

    it("returns DEFAULT_USER_CONFIG when KV JSON is invalid (does not throw)", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue("broken {");

      const result = await loadUserConfigForForm(env);

      expect(result).toEqual(DEFAULT_USER_CONFIG);
    });

    it("returns DEFAULT_USER_CONFIG when KV value fails validation (does not throw)", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(
        JSON.stringify({ ...validUser, interestAxes: [] }),
      );

      const result = await loadUserConfigForForm(env);

      expect(result).toEqual(DEFAULT_USER_CONFIG);
    });
  });

  describe("DEFAULT_USER_CONFIG", () => {
    it("is a valid UserConfig that can be saved", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.put as any).mockResolvedValue(undefined);

      await expect(saveConfig(env, DEFAULT_USER_CONFIG)).resolves.toBeUndefined();
    });
  });
});
