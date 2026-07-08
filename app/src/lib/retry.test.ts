import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry } from "./retry";

describe("fetchWithRetry", () => {
  it("returns successful response immediately", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    const mockSleep = vi.fn();

    const response = await fetchWithRetry("https://example.com", undefined, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("returns 4xx response immediately without retry", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const mockSleep = vi.fn();

    const response = await fetchWithRetry("https://example.com", undefined, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    expect(response.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("retries on network exception and throws last exception", async () => {
    const error = new Error("Network error");
    const mockFetch = vi.fn().mockRejectedValue(error);
    const mockSleep = vi.fn();

    await expect(
      fetchWithRetry("https://example.com", undefined, {
        fetch: mockFetch,
        sleep: mockSleep,
      }),
    ).rejects.toThrow("Network error");

    // 4 attempts (initial + 3 retries), 3 backoff sleeps.
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockSleep).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenNthCalledWith(1, 1000);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 2000);
    expect(mockSleep).toHaveBeenNthCalledWith(3, 4000);
  });

  it("retries on 5xx and returns last response", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));

    const mockSleep = vi.fn();

    const response = await fetchWithRetry("https://example.com", undefined, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    expect(response.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockSleep).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenNthCalledWith(1, 1000);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 2000);
    expect(mockSleep).toHaveBeenNthCalledWith(3, 4000);
  });

  it("retries 5xx then succeeds on third attempt", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));

    const mockSleep = vi.fn();

    const response = await fetchWithRetry("https://example.com", undefined, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff: 1s → 2s → 4s", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const mockSleep = vi.fn();

    await expect(
      fetchWithRetry("https://example.com", undefined, {
        fetch: mockFetch,
        sleep: mockSleep,
      }),
    ).rejects.toThrow();

    expect(mockSleep).toHaveBeenNthCalledWith(1, 1000);
    expect(mockSleep).toHaveBeenNthCalledWith(2, 2000);
    expect(mockSleep).toHaveBeenNthCalledWith(3, 4000);
  });

  it("mixes network exception with 5xx response", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));

    const mockSleep = vi.fn();

    const response = await fetchWithRetry("https://example.com", undefined, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    expect(response.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("passes init and url to fetch correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    const mockSleep = vi.fn();

    const init = { method: "POST", body: "test" };
    await fetchWithRetry("https://example.com/api", init, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    expect(mockFetch).toHaveBeenCalledWith("https://example.com/api", init);
  });
});
