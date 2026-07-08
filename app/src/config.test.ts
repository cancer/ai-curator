import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig, saveConfig, type Config } from "./config";
import type { Env } from "./index";

// Valid minimal config for testing
const validConfig: Config = {
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
  scoring: {
    weights: {
      interest: 0.6,
      freshness: 0.3,
      sourceTrust: 0.1,
    },
    freshnessHalfLifeDays: 3,
    semanticDedupThreshold: 0.9,
    sourceTrust: {
      github: 1.0,
      fowler: 1.0,
      medium: 0.7,
      hn: 0.5,
    },
  },
  embedding: {
    model: "@cf/baai/bge-m3",
    maxInputChars: 20000,
  },
  digest: {
    model: "gpt-4",
    summaryTopN: 10,
    maxOutputTokens: 300,
  },
};

// Create a mock Env with properly typed KVNamespace mock
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
    it("should load valid config from KV", async () => {
      const env = createMockEnv();
      const configJson = JSON.stringify(validConfig);

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(configJson);

      const result = await loadConfig(env);

      expect(result).toEqual(validConfig);
      expect(env.CONFIG.get).toHaveBeenCalledWith("config:v1");
    });

    it("should throw when config key is not found", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue(null);

      await expect(loadConfig(env)).rejects.toThrow(
        'Config key "config:v1" not found in KV'
      );
    });

    it("should throw when JSON is invalid", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.get as any).mockResolvedValue("invalid json {");

      await expect(loadConfig(env)).rejects.toThrow(
        "Failed to parse config JSON"
      );
    });

    it("should throw when interestAxes is missing", async () => {
      const env = createMockEnv();
      const config = { ...validConfig };
      delete (config as any).interestAxes;

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "interestAxes must be an array"
      );
    });

    it("should throw when interestAxes element has empty id", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        interestAxes: [
          { id: "", label: "Web FW", seedText: "text" },
        ],
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "InterestAxis.id must be a non-empty string"
      );
    });

    it("should throw when interestAxes element has empty seedText", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        interestAxes: [
          { id: "web-fw", label: "Web FW", seedText: "" },
        ],
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "InterestAxis.seedText must be a non-empty string"
      );
    });

    it("should throw when interestAxes is empty", async () => {
      const env = createMockEnv();
      const config = { ...validConfig, interestAxes: [] };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "interestAxes must not be empty"
      );
    });

    it("should throw when interestAxes has duplicate ids", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        interestAxes: [
          { id: "dup", label: "A", seedText: "a" },
          { id: "dup", label: "B", seedText: "b" },
        ],
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        'Duplicate interestAxis id: "dup"'
      );
    });

    it("should throw when scoring.freshnessHalfLifeDays is not positive", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        scoring: { ...validConfig.scoring, freshnessHalfLifeDays: 0 },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "scoring.freshnessHalfLifeDays must be a positive number"
      );
    });

    it("should throw when githubRepos has a non owner/repo entry", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        sources: { ...validConfig.sources, githubRepos: ["owner/repo", "not-a-repo"] },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        'sources.githubRepos entries must be "owner/repo" strings'
      );
    });

    it("should throw when mediumAuthorFeeds has a non-string entry", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        sources: { ...validConfig.sources, mediumAuthorFeeds: ["@ok", 123] },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.mediumAuthorFeeds entries must be strings"
      );
    });

    it("should throw when mediumTagFeeds has a non-string entry", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        sources: { ...validConfig.sources, mediumTagFeeds: [true] },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.mediumTagFeeds entries must be strings"
      );
    });

    it("should throw when sources is missing", async () => {
      const env = createMockEnv();
      const config = { ...validConfig };
      delete (config as any).sources;

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources must be an object"
      );
    });

    it("should throw when sources.githubRepos is not an array", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        sources: { ...validConfig.sources, githubRepos: "not-array" },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.githubRepos must be an array"
      );
    });

    it("should throw when sources.hnMinPoints is not a number", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        sources: { ...validConfig.sources, hnMinPoints: "not-number" },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "sources.hnMinPoints must be a number"
      );
    });

    it("should throw when scoring.weights has missing field", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        scoring: {
          ...validConfig.scoring,
          weights: { interest: 0.6, freshness: 0.3 },
        },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "scoring.weights.sourceTrust must be a number"
      );
    });

    it("should throw when embedding.model is empty string", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        embedding: { ...validConfig.embedding, model: "" },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "embedding.model must be a non-empty string"
      );
    });

    it("should throw when embedding.maxInputChars is not positive", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        embedding: { ...validConfig.embedding, maxInputChars: 0 },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "embedding.maxInputChars must be a positive integer"
      );
    });

    it("should throw when digest.summaryTopN is not positive", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        digest: { ...validConfig.digest, summaryTopN: -5 },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "digest.summaryTopN must be a positive integer"
      );
    });

    it("should throw when digest.maxOutputTokens is not positive", async () => {
      const env = createMockEnv();
      const config = {
        ...validConfig,
        digest: { ...validConfig.digest, maxOutputTokens: 0 },
      };

      vi.mocked(env.CONFIG.get as any).mockResolvedValue(JSON.stringify(config));

      await expect(loadConfig(env)).rejects.toThrow(
        "digest.maxOutputTokens must be a positive integer"
      );
    });
  });

  describe("saveConfig", () => {
    it("should save valid config to KV", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.put as any).mockResolvedValue(undefined);

      await saveConfig(env, validConfig);

      expect(env.CONFIG.put).toHaveBeenCalledWith(
        "config:v1",
        JSON.stringify(validConfig)
      );
    });

    it("should throw validation error when saving invalid config", async () => {
      const env = createMockEnv();
      const invalidConfig = {
        ...validConfig,
        embedding: { ...validConfig.embedding, maxInputChars: -1 },
      };

      await expect(saveConfig(env, invalidConfig as any)).rejects.toThrow(
        "embedding.maxInputChars must be a positive integer"
      );

      // Verify put was never called
      expect(env.CONFIG.put).not.toHaveBeenCalled();
    });

    it("should reject config with missing sources.fowlerFeed", async () => {
      const env = createMockEnv();
      const invalidConfig = {
        ...validConfig,
        sources: { ...validConfig.sources },
      };
      delete (invalidConfig.sources as any).fowlerFeed;

      await expect(saveConfig(env, invalidConfig as any)).rejects.toThrow(
        "sources.fowlerFeed must be a boolean"
      );

      expect(env.CONFIG.put).not.toHaveBeenCalled();
    });

    it("should accept empty lists in sources", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.put as any).mockResolvedValue(undefined);

      const config: Config = {
        ...validConfig,
        sources: {
          ...validConfig.sources,
          githubRepos: [],
          mediumAuthorFeeds: [],
          mediumTagFeeds: [],
        },
      };

      await saveConfig(env, config);

      expect(env.CONFIG.put).toHaveBeenCalled();
    });

    it("should accept digest.model with any non-empty string", async () => {
      const env = createMockEnv();
      vi.mocked(env.CONFIG.put as any).mockResolvedValue(undefined);

      const config: Config = {
        ...validConfig,
        digest: { ...validConfig.digest, model: "any-custom-model" },
      };

      await saveConfig(env, config);

      expect(env.CONFIG.put).toHaveBeenCalled();
    });
  });
});
