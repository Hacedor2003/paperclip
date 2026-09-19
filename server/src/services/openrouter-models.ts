import type { AdapterModel } from "@paperclipai/adapter-utils";

let cached: { until: number; models: AdapterModel[] } | undefined;
let pending: Promise<AdapterModel[]> | undefined;

interface OpenRouterCatalogEntry {
  id?: unknown;
  name?: unknown;
  pricing?: unknown;
}

/**
 * OpenRouter quotes per-token prices as decimal strings ("0", "0.0000008").
 * A model is free only when both directions cost nothing: a zero prompt price
 * with a priced completion still bills the run.
 *
 * Returns undefined rather than false when the catalog omits or malforms
 * pricing, so an unknown cost is never displayed as "Free". `:free` is
 * OpenRouter's own naming convention for the zero-cost variant of a model and
 * is honored as a fallback when pricing is missing entirely.
 */
function isFreeModel(entry: OpenRouterCatalogEntry, id: string): boolean | undefined {
  const pricing = entry.pricing;
  if (!pricing || typeof pricing !== "object") {
    return id.endsWith(":free") ? true : undefined;
  }
  const { prompt, completion } = pricing as { prompt?: unknown; completion?: unknown };
  const prices = [prompt, completion].map((value) =>
    typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN,
  );
  if (prices.some((price) => !Number.isFinite(price))) {
    return id.endsWith(":free") ? true : undefined;
  }
  return prices.every((price) => price === 0);
}

/** OpenRouter's public catalog does not require access to anyone's credentials. */
export async function listOpenRouterModels(refresh = false): Promise<AdapterModel[]> {
  if (!refresh && cached && cached.until > Date.now()) return cached.models;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Could not load OpenRouter models. Retry or enter a model ID manually.");
    const body = await response.json() as { data?: OpenRouterCatalogEntry[] };
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
    const models = body.data.flatMap((model) => {
      if (typeof model.id !== "string" || !model.id.includes("/")) return [];
      const free = isFreeModel(model, model.id);
      return [{
        id: `openrouter/${model.id}`,
        label: typeof model.name === "string" ? model.name : model.id,
        // Omit the key entirely when the cost is unknown, so the wire payload
        // distinguishes "not free" from "could not tell".
        ...(free === undefined ? {} : { free }),
      }];
    }).sort((a, b) => a.label.localeCompare(b.label));
    cached = { until: Date.now() + 60_000, models };
    return models;
  })();
  try { return await pending; } finally { pending = undefined; }
}
