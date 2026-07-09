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
const validUser: UserConfig = {
  interestAxes: [
    {
      id: "web-fw",
      label: "Web FW",
      seedText: "I am interested in web frameworks",
    },
    {
      id: "ai",
      label: "AI",
      seedText: "I am interested in AI",
    },
  ],
  sources: {
    githubRepos: ["owner/repo1", "owner/repo2"],
    hnMinPoints: 50,
    mediumAuthorFeeds: ["@author1"],
    mediumTagFeeds: ["tag-name"],
    fowlerFeed: true,
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
        interestAxes: [{ id: "", label: "Web FW", seedText: "text" }],
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
        interestAxes: [{ id: "web-fw", label: "", seedText: "text" }],
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "InterestAxis.label must be a non-empty string",
      );
    });

    it("throws when an interestAxis has an empty seedText", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        interestAxes: [{ id: "web-fw", label: "Web FW", seedText: "" }],
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "InterestAxis.seedText must be a non-empty string",
      );
    });

    it("throws when interestAxes has duplicate ids", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        interestAxes: [
          { id: "dup", label: "A", seedText: "a" },
          { id: "dup", label: "B", seedText: "b" },
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

    it("throws when sources.githubRepos is not an array", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: { ...validUser.sources, githubRepos: "not-array" },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.githubRepos must be an array",
      );
    });

    it("throws when githubRepos has a non owner/repo entry", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: {
          ...validUser.sources,
          githubRepos: ["owner/repo", "not-a-repo"],
        },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        'sources.githubRepos entries must be "owner/repo" strings',
      );
    });

    it("throws when sources.hnMinPoints is negative", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: { ...validUser.sources, hnMinPoints: -1 },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.hnMinPoints must be a non-negative integer",
      );
    });

    it("throws when sources.hnMinPoints is not an integer", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: { ...validUser.sources, hnMinPoints: 1.5 },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.hnMinPoints must be a non-negative integer",
      );
    });

    it("throws when mediumTagFeeds has a non-string entry", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: { ...validUser.sources, mediumTagFeeds: [true] },
      };
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.mediumTagFeeds entries must be strings",
      );
    });

    it("throws when sources.fowlerFeed is missing", async () => {
      const env = createMockEnv();
      const user = {
        ...validUser,
        sources: { ...validUser.sources },
      };
      delete (user.sources as any).fowlerFeed;
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(user));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.fowlerFeed must be a boolean",
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
        interestAxes: [{ id: "web-fw", label: "Web FW", seedText: "" }],
      };

      await expect(saveConfig(env, invalid as any)).rejects.toThrow(
        "InterestAxis.seedText must be a non-empty string",
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
          githubRepos: [],
          mediumAuthorFeeds: [],
          mediumTagFeeds: [],
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
