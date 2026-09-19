import { describe, expect, it } from "vitest";
import { sanitizeInheritedHostEnv } from "./server-utils.js";

// An adapter spawns an agent CLI whose prompt is assembled from issue bodies,
// chat messages and webhook payloads that come from outside the trust
// boundary. Whatever survives this projection is readable by that agent, so
// the server's own credentials must not.
describe("sanitizeInheritedHostEnv", () => {
  it("drops the server's own credentials", () => {
    const projected = sanitizeInheritedHostEnv({
      DATABASE_URL: "postgres://paperclip:hunter2@localhost:5432/paperclip",
      BETTER_AUTH_SECRET: "auth-secret",
      PAPERCLIP_SECRETS_MASTER_KEY: "master-key",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "signing-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
    });

    expect(projected).toEqual({});
  });

  it("drops deployment-specific secret names the explicit set cannot enumerate", () => {
    const projected = sanitizeInheritedHostEnv({
      PAPERCLIP_CUSTOM_WEBHOOK_SECRET: "nope",
      PAPERCLIP_ROTATED_SIGNING_KEY: "nope",
      PAPERCLIP_TENANT_PRIVATE_KEY: "nope",
      BETTER_AUTH_COOKIE_SECRET: "nope",
      PATH: "/usr/bin",
    });

    expect(projected).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps what an agent actually needs, including provider API keys", () => {
    const projected = sanitizeInheritedHostEnv({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy.internal:3128",
      ANTHROPIC_API_KEY: "sk-ant-example",
      OPENAI_API_KEY: "sk-openai-example",
      GITHUB_TOKEN: "ghp_example",
    });

    expect(projected.PATH).toBe("/usr/bin");
    expect(projected.HOME).toBe("/home/agent");
    expect(projected.LANG).toBe("en_US.UTF-8");
    expect(projected.HTTPS_PROXY).toBe("http://proxy.internal:3128");
    expect(projected.ANTHROPIC_API_KEY).toBe("sk-ant-example");
    expect(projected.OPENAI_API_KEY).toBe("sk-openai-example");
    expect(projected.GITHUB_TOKEN).toBe("ghp_example");
  });

  it("lets an operator re-admit a specific key, and never leaks the opt-in list itself", () => {
    const projected = sanitizeInheritedHostEnv({
      PAPERCLIP_AGENT_ENV_PASSTHROUGH: "AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-session",
      DATABASE_URL: "postgres://paperclip:hunter2@localhost:5432/paperclip",
    });

    expect(projected.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
    expect(projected.AWS_SESSION_TOKEN).toBe("aws-session");
    // Not named in the opt-in list, so still stripped.
    expect(projected.DATABASE_URL).toBeUndefined();
    expect(projected.PAPERCLIP_AGENT_ENV_PASSTHROUGH).toBeUndefined();
  });

  it("reads the opt-in list only from the host env it is projecting", () => {
    // A config/prompt-supplied value is merged over this projection by the
    // caller, after the fact — it cannot retroactively widen what was stripped.
    const projected = sanitizeInheritedHostEnv({
      DATABASE_URL: "postgres://paperclip:hunter2@localhost:5432/paperclip",
    });

    expect(projected.DATABASE_URL).toBeUndefined();
  });
});
