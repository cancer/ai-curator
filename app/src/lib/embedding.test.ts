import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingResult } from "./embedding";
import {
  embed,
  embedBatch,
  axisNeedsUpdate,
  sha256Hex,
} from "./embedding";

// Mock Ai interface
const createMockAi = (
  responder: (
    model: string,
    input: { text: string[] }
  ) => Promise<unknown>
): Ai => {
  return {
    run: responder as any,
  } as Ai;
};

describe("embed", () => {
  it("should extract vector from embedding response", async () => {
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    const ai = createMockAi(async () => ({
      data: [mockVector],
      shape: [1, 4],
    }));

    const result = await embed(ai, "@cf/baai/bge-m3", "test text");

    expect(result.vector).toEqual(mockVector);
  });

  it("should extract inputTokens from meta if available", async () => {
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    const ai = createMockAi(async () => ({
      data: [mockVector],
      shape: [1, 4],
      meta: {
        cost_metric_value_1: 42,
        neurons: 123,
      },
    }));

    const result = await embed(ai, "@cf/baai/bge-m3", "test text");

    expect(result.inputTokens).toBe(42);
  });

  it("should not include inputTokens if meta is absent", async () => {
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    const ai = createMockAi(async () => ({
      data: [mockVector],
      shape: [1, 4],
    }));

    const result = await embed(ai, "@cf/baai/bge-m3", "test text");

    expect(result.inputTokens).toBeUndefined();
  });

  it("should truncate input text to maxInputChars", async () => {
    let capturedText: string[] | null = null;

    const ai = createMockAi(async (_model, input) => {
      capturedText = input.text;
      return { data: [[0.1]], shape: [1, 1] };
    });

    const longText = "x".repeat(30000);
    await embed(ai, "@cf/baai/bge-m3", longText, 5000);

    expect(capturedText).toBeDefined();
    expect(capturedText![0]).toHaveLength(5000);
    expect(capturedText![0]).toBe("x".repeat(5000));
  });

  it("should not truncate if text is shorter than maxInputChars", async () => {
    let capturedText: string[] | null = null;

    const ai = createMockAi(async (_model, input) => {
      capturedText = input.text;
      return { data: [[0.1]], shape: [1, 1] };
    });

    const shortText = "hello world";
    await embed(ai, "@cf/baai/bge-m3", shortText, 5000);

    expect(capturedText).toBeDefined();
    expect(capturedText![0]).toBe(shortText);
  });

  it("should retry on error with exponential backoff", async () => {
    let attemptCount = 0;
    const sleepCalls: number[] = [];

    const ai = createMockAi(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error("Temporary error");
      }
      return { data: [[0.1]], shape: [1, 1] };
    });

    const mockSleep = vi.fn((ms: number) =>
      Promise.resolve((sleepCalls.push(ms), undefined))
    );

    const result = await embed(ai, "@cf/baai/bge-m3", "test", 20000, mockSleep);

    // Should succeed on 3rd attempt
    expect(result.vector).toEqual([0.1]);

    // Should have called sleep with backoff intervals: 1000, 2000
    expect(sleepCalls).toEqual([1000, 2000]);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("should throw after max retries are exceeded", async () => {
    const ai = createMockAi(async () => {
      throw new Error("Permanent error");
    });

    const mockSleep = vi.fn(() => Promise.resolve());

    await expect(
      embed(ai, "@cf/baai/bge-m3", "test", 20000, mockSleep)
    ).rejects.toThrow("Permanent error");

    // Should have retried 2 times (total 3 attempts)
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("should throw if response has no data", async () => {
    const ai = createMockAi(async () => ({
      data: [],
      shape: [0],
    }));

    await expect(
      embed(ai, "@cf/baai/bge-m3", "test")
    ).rejects.toThrow("No embedding data in response");
  });

  it("should use default maxInputChars of 20000", async () => {
    let capturedText: string[] | null = null;

    const ai = createMockAi(async (_model, input) => {
      capturedText = input.text;
      return { data: [[0.1]], shape: [1, 1] };
    });

    const longText = "x".repeat(25000);
    await embed(ai, "@cf/baai/bge-m3", longText);

    expect(capturedText![0]).toHaveLength(20000);
  });
});

describe("embedBatch", () => {
  it("should process multiple texts with 150ms delay between calls", async () => {
    const callTimings: number[] = [];
    const startTime = Date.now();

    const ai = createMockAi(async () => {
      callTimings.push(Date.now() - startTime);
      return { data: [[0.1]], shape: [1, 1] };
    });

    const mockSleep = vi.fn((ms: number) => Promise.resolve());

    const texts = ["text1", "text2", "text3"];
    const results = await embedBatch(ai, "@cf/baai/bge-m3", texts, 20000, mockSleep);

    expect(results).toHaveLength(3);
    expect(results.every((r) => Array.isArray(r.vector))).toBe(true);

    // Should have 2 sleep calls (between 3 texts)
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenNthCalledWith(1, 150);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 150);
  });

  it("should not sleep before first call", async () => {
    const ai = createMockAi(async () => ({
      data: [[0.1]],
      shape: [1, 1],
    }));

    const mockSleep = vi.fn(() => Promise.resolve());

    await embedBatch(ai, "@cf/baai/bge-m3", ["only one"], 20000, mockSleep);

    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("should handle empty input array", async () => {
    const ai = createMockAi(async () => ({
      data: [[0.1]],
      shape: [1, 1],
    }));

    const mockSleep = vi.fn(() => Promise.resolve());

    const results = await embedBatch(ai, "@cf/baai/bge-m3", [], 20000, mockSleep);

    expect(results).toHaveLength(0);
    expect(mockSleep).not.toHaveBeenCalled();
  });
});

describe("axisNeedsUpdate", () => {
  it("should return true if axis not registered (existing === null)", () => {
    const result = axisNeedsUpdate(null, "somehash", "@cf/baai/bge-m3");
    expect(result).toBe(true);
  });

  it("should return true if seed hash changed", () => {
    const existing = {
      seed_hash: "oldhash",
      embedding_model: "@cf/baai/bge-m3",
    };
    const result = axisNeedsUpdate(existing, "newhash", "@cf/baai/bge-m3");
    expect(result).toBe(true);
  });

  it("should return true if embedding model changed", () => {
    const existing = {
      seed_hash: "somehash",
      embedding_model: "@cf/baai/bge-m3",
    };
    const result = axisNeedsUpdate(existing, "somehash", "@cf/baai/bge-large-en-v1.5");
    expect(result).toBe(true);
  });

  it("should return false if nothing changed", () => {
    const existing = {
      seed_hash: "samehash",
      embedding_model: "@cf/baai/bge-m3",
    };
    const result = axisNeedsUpdate(existing, "samehash", "@cf/baai/bge-m3");
    expect(result).toBe(false);
  });

  it("should return false for all stable fields", () => {
    const axis_id = "tech";
    const seed_hash = "abc123def456";
    const model = "@cf/baai/bge-m3";

    const existing = {
      seed_hash,
      embedding_model: model,
    };

    expect(axisNeedsUpdate(existing, seed_hash, model)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("should compute SHA-256 hash as hex string", async () => {
    const hash = await sha256Hex("hello world");

    // Known SHA-256 of "hello world"
    const expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    expect(hash).toBe(expected);
  });

  it("should produce different hashes for different inputs", async () => {
    const hash1 = await sha256Hex("test1");
    const hash2 = await sha256Hex("test2");

    expect(hash1).not.toBe(hash2);
  });

  it("should produce consistent hashes for same input", async () => {
    const input = "consistent input";
    const hash1 = await sha256Hex(input);
    const hash2 = await sha256Hex(input);

    expect(hash1).toBe(hash2);
  });

  it("should handle empty string", async () => {
    const hash = await sha256Hex("");

    // Known SHA-256 of empty string
    const expected = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(hash).toBe(expected);
  });

  it("should produce lowercase hex output", async () => {
    const hash = await sha256Hex("test");

    expect(hash).toMatch(/^[a-f0-9]+$/);
    // Verify no uppercase letters
    expect(hash).toEqual(hash.toLowerCase());
  });
});
