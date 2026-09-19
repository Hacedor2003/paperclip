import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

// OpenCode routes to whatever provider the model id names, so a rate limit can
// arrive as an HTTP status, as a provider's prose, or as OpenRouter's own
// free-tier quota wording. The claude adapter has carried an equivalent for
// paid Anthropic limits since the start; OpenRouter's free models make it
// load-bearing here, because their per-minute and per-day caps are low enough
// that an ordinary agent loop hits them.
const OPENCODE_RATE_LIMIT_RE =
  /(?:rate[-\s]?limit(?:ed|s)?|rate_limit_error|too\s+many\s+requests|\b429\b|quota\s+exceeded|insufficient_quota|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|temporarily\s+unavailable|throttl(?:ed|ing)|try\s+again\s+later)/i;

// OpenRouter reports an exhausted free allowance separately from a burst limit:
// the burst one clears in seconds, this one can mean "come back tomorrow".
const OPENCODE_FREE_TIER_QUOTA_RE =
  /(?:free[-\s]?models?[-\s]?per[-\s]?day|free[-\s]?tier\s+(?:limit|quota)|daily\s+(?:limit|quota)\s+(?:reached|exceeded)|add\s+(?:\d+\s+)?credits)/i;

function rateLimitHaystack(stdout: string, stderr: string, errorMessage?: string | null): string {
  return [stdout, stderr, errorMessage ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * A provider-side throttle or exhausted quota, as opposed to a bug in the run.
 * The caller reports it as a retryable family so the orchestrator waits instead
 * of burning the task on an error the next attempt would not hit.
 */
export function isOpenCodeRateLimitError(input: {
  stdout: string;
  stderr: string;
  errorMessage?: string | null;
}): boolean {
  return OPENCODE_RATE_LIMIT_RE.test(
    rateLimitHaystack(input.stdout, input.stderr, input.errorMessage),
  );
}

/**
 * True when the throttle is an exhausted free allowance rather than a burst
 * limit. Both are retryable, but this one is `provider_quota`: the wait is
 * hours, not seconds, and the operator may need to switch model or add credit.
 */
export function isOpenCodeFreeTierQuotaError(input: {
  stdout: string;
  stderr: string;
  errorMessage?: string | null;
}): boolean {
  const haystack = rateLimitHaystack(input.stdout, input.stderr, input.errorMessage);
  return OPENCODE_FREE_TIER_QUOTA_RE.test(haystack);
}

/**
 * Seconds a provider asked the caller to wait, from a `Retry-After` header or
 * the `retry after N seconds` prose providers echo into the error body.
 * Undefined when nothing usable is present — the caller then applies its own
 * backoff rather than inventing a deadline.
 */
export function openCodeRetryAfterSeconds(input: {
  stdout: string;
  stderr: string;
  errorMessage?: string | null;
}): number | undefined {
  const haystack = rateLimitHaystack(input.stdout, input.stderr, input.errorMessage);
  const match =
    /retry[-\s]?after[":\s]+(\d+(?:\.\d+)?)/i.exec(haystack) ??
    /(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds?)/i.exec(haystack);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  // A provider that asks for an implausible wait is clamped: a day-long sleep
  // inside one run is never the right answer.
  return Math.min(seconds, 3600);
}
