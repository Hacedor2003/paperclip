import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("lists and caches public OpenRouter models without sending credentials", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet" }, { id: 42 },
  ] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenRouterModels } = await import("./openrouter-models.js");
  expect(await listOpenRouterModels()).toEqual([{ id: "openrouter/anthropic/claude-sonnet-4.5", label: "Claude Sonnet" }]);
  await listOpenRouterModels();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", { signal: expect.any(AbortSignal) });
  await listOpenRouterModels(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("allows retry after a public catalog failure", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenRouterModels } = await import("./openrouter-models.js");
  await expect(listOpenRouterModels()).rejects.toThrow("Retry or enter a model ID manually");
  await expect(listOpenRouterModels()).resolves.toEqual([]);
});

// A free model is the point of the flag: it is what makes an unpaid trial of
// Paperclip possible, so the catalog has to say which ones cost nothing.
it("marks a model free only when both prompt and completion cost nothing", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
    { id: "vendor/free-model:free", name: "A Free", pricing: { prompt: "0", completion: "0" } },
    { id: "vendor/b-paid", name: "B Paid", pricing: { prompt: "0.0000008", completion: "0.000002" } },
    // Free prompt, priced completion: the run still bills, so not free.
    { id: "vendor/c-half", name: "C Half", pricing: { prompt: "0", completion: "0.000002" } },
  ] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenRouterModels } = await import("./openrouter-models.js");

  expect(await listOpenRouterModels()).toEqual([
    { id: "openrouter/vendor/free-model:free", label: "A Free", free: true },
    { id: "openrouter/vendor/b-paid", label: "B Paid", free: false },
    { id: "openrouter/vendor/c-half", label: "C Half", free: false },
  ]);
});

it("leaves cost unknown rather than claiming a model is free", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
    { id: "vendor/a-no-pricing", name: "A No Pricing" },
    { id: "vendor/b-bad-pricing", name: "B Bad Pricing", pricing: { prompt: "abc", completion: "0" } },
    // Pricing is missing, but OpenRouter's own `:free` naming still tells us.
    { id: "vendor/c-suffix:free", name: "C Suffix" },
  ] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenRouterModels } = await import("./openrouter-models.js");

  const models = await listOpenRouterModels();
  expect(models[0]).toEqual({ id: "openrouter/vendor/a-no-pricing", label: "A No Pricing" });
  expect(models[0]).not.toHaveProperty("free");
  expect(models[1]).not.toHaveProperty("free");
  expect(models[2]).toEqual({ id: "openrouter/vendor/c-suffix:free", label: "C Suffix", free: true });
});
