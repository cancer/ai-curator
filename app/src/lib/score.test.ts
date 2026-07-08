import { describe, it, expect } from "vitest";
import {
  cosine,
  freshness,
  sourceTrust,
  interestScore,
  score,
  type AxisVector,
} from "./score";

describe("cosine", () => {
  it("returns 1 for identical direction vectors", () => {
    expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("computes a known value", () => {
    // dot = 1*1 + 2*1 = 3; |a| = sqrt(5); |b| = sqrt(2); cos = 3/(sqrt(5)*sqrt(2))
    expect(cosine([1, 2], [1, 1])).toBeCloseTo(3 / (Math.sqrt(5) * Math.sqrt(2)), 10);
  });

  it("returns 0 when the first vector is the zero vector", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when the second vector is the zero vector", () => {
    expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0);
  });
});

describe("freshness", () => {
  it("returns 1.0 when the article was published now (0 elapsed days)", () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    expect(freshness("2026-07-08T00:00:00.000Z", now, 7)).toBeCloseTo(1, 10);
  });

  it("returns 0.5 at exactly one half-life of elapsed time", () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    // half-life 7 days -> published 7 days earlier
    expect(freshness("2026-07-01T00:00:00.000Z", now, 7)).toBeCloseTo(0.5, 10);
  });

  it("returns 0.25 after two half-lives", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    expect(freshness("2026-07-01T00:00:00.000Z", now, 7)).toBeCloseTo(0.25, 10);
  });
});

describe("sourceTrust", () => {
  const trust = { github: 1.0, fowler: 0.9, medium: 0.6, hn: 0.4 };

  it("extracts the prefix before ':' for medium author sources", () => {
    expect(sourceTrust("medium:@alice", trust)).toBe(0.6);
  });

  it("extracts the prefix for github sources", () => {
    expect(sourceTrust("github:owner/repo", trust)).toBe(1.0);
  });

  it("uses the whole string when there is no ':' (hn, fowler)", () => {
    expect(sourceTrust("hn", trust)).toBe(0.4);
    expect(sourceTrust("fowler", trust)).toBe(0.9);
  });

  it("returns 0 for an unknown source kind", () => {
    expect(sourceTrust("unknown:x", trust)).toBe(0);
  });
});

describe("interestScore", () => {
  const axes: AxisVector[] = [
    { axisId: "web-fw", vector: [1, 0, 0], model: "m1" },
    { axisId: "ai", vector: [0, 1, 0], model: "m1" },
  ];

  it("returns the max cosine over axes and records the winning axis id", () => {
    const result = interestScore([0, 1, 0], "m1", axes);
    expect(result.interest).toBeCloseTo(1, 10);
    expect(result.hitAxis).toBe("ai");
  });

  it("only compares vectors whose embedding model matches the article model", () => {
    const mixed: AxisVector[] = [
      { axisId: "web-fw", vector: [1, 0, 0], model: "other-model" },
      { axisId: "ai", vector: [0, 1, 0], model: "m1" },
    ];
    // article aligned with web-fw but that axis has a mismatching model -> ignored.
    const result = interestScore([1, 0, 0], "m1", mixed);
    expect(result.hitAxis).toBe("ai");
    expect(result.interest).toBeCloseTo(0, 10);
  });

  it("returns interest 0 and null hitAxis when no axis shares the model", () => {
    const result = interestScore([1, 0, 0], "m1", [
      { axisId: "web-fw", vector: [1, 0, 0], model: "other" },
    ]);
    expect(result.interest).toBe(0);
    expect(result.hitAxis).toBeNull();
  });

  it("returns interest 0 and null hitAxis when there are no axes", () => {
    const result = interestScore([1, 0, 0], "m1", []);
    expect(result.interest).toBe(0);
    expect(result.hitAxis).toBeNull();
  });
});

describe("score", () => {
  const weights = { interest: 0.6, freshness: 0.3, sourceTrust: 0.1 };

  it("combines the components using the configured weights", () => {
    const value = score(
      { interest: 1.0, freshness: 0.5, sourceTrust: 0.4 },
      weights,
    );
    expect(value).toBeCloseTo(0.6 * 1.0 + 0.3 * 0.5 + 0.1 * 0.4, 10);
  });

  it("is 0 when all components are 0", () => {
    expect(score({ interest: 0, freshness: 0, sourceTrust: 0 }, weights)).toBe(0);
  });
});
