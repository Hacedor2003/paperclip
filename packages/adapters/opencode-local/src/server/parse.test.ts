import { describe, expect, it } from "vitest";
import {
  isOpenCodeFreeTierQuotaError,
  isOpenCodeRateLimitError,
  isOpenCodeUnknownSessionError,
  openCodeRetryAfterSeconds,
  parseOpenCodeJsonl,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("provider throttles", () => {
  const empty = { stdout: "", stderr: "" };

  it("recognizes a throttle however the provider phrases it", () => {
    for (const stderr of [
      "Error: 429 Too Many Requests",
      "rate limit exceeded for this model",
      "provider returned error: rate_limit_error",
      "Service Unavailable (503)",
      "The server is overloaded, try again later",
      "request was throttled",
    ]) {
      expect(isOpenCodeRateLimitError({ ...empty, stderr })).toBe(true);
    }
  });

  it("does not mistake an ordinary failure for a throttle", () => {
    for (const stderr of [
      "TypeError: cannot read properties of undefined",
      "fatal: not a git repository",
      "model not found: vendor/nope",
      "",
    ]) {
      expect(isOpenCodeRateLimitError({ ...empty, stderr })).toBe(false);
    }
  });

  it("separates an exhausted free allowance from a burst limit", () => {
    const daily = {
      ...empty,
      stderr: "Rate limit exceeded: free-models-per-day. Add credits to continue.",
    };
    expect(isOpenCodeRateLimitError(daily)).toBe(true);
    expect(isOpenCodeFreeTierQuotaError(daily)).toBe(true);

    const burst = { ...empty, stderr: "429 Too Many Requests" };
    expect(isOpenCodeRateLimitError(burst)).toBe(true);
    expect(isOpenCodeFreeTierQuotaError(burst)).toBe(false);
  });

  it("reads a retry hint when the provider gives one, and clamps an absurd wait", () => {
    expect(openCodeRetryAfterSeconds({ ...empty, stderr: 'retry-after: 30' })).toBe(30);
    expect(openCodeRetryAfterSeconds({ ...empty, stderr: "try again in 12 seconds" })).toBe(12);
    expect(openCodeRetryAfterSeconds({ ...empty, stderr: "retry-after: 999999" })).toBe(3600);
    expect(openCodeRetryAfterSeconds({ ...empty, stderr: "retry-after: -5" })).toBeUndefined();
    expect(openCodeRetryAfterSeconds({ ...empty, stderr: "429 Too Many Requests" })).toBeUndefined();
  });

  it("reads the error message too, not just the streams", () => {
    expect(
      isOpenCodeRateLimitError({ ...empty, errorMessage: "Provider error: quota exceeded" }),
    ).toBe(true);
  });
});
