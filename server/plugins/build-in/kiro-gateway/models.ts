import type { JsonValue } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import { gatewayUrl, loadGateway, redactKey } from "./config.ts";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/** Segments rendered as acronyms; plain capitalization would show "Gpt". */
const ACRONYM_SEGMENTS: Record<string, string> = { gpt: "GPT", glm: "GLM" };

function capitalizeSegment(segment: string): string {
  return ACRONYM_SEGMENTS[segment.toLowerCase()] ?? segment.charAt(0).toUpperCase() + segment.slice(1);
}

/**
 * Turn a model id into a readable label, e.g. "minimax-m2.5" -> "Minimax M2.5".
 *
 * The gateway reports `display_name` identical to the slug, so without this the
 * model list would show raw ids.
 *
 * Args:
 *   id: Model identifier as served by the gateway.
 *
 * Returns:
 *   Display label, or the original id when it has no usable segments.
 */
export function humanizeModelId(id: string): string {
  const segments = id.split(/[-_\s]+/).filter((segment) => segment.length > 0);
  return segments.length === 0 ? id : segments.map(capitalizeSegment).join(" ");
}

/**
 * Collect the reasoning efforts a gateway model accepts.
 *
 * Args:
 *   model: One entry from the gateway's model list.
 *
 * Returns:
 *   Deduplicated effort identifiers in upstream order; empty when the model
 *   has no reasoning control.
 */
export function parseReasoningEfforts(model: Record<string, unknown>): string[] {
  const source = model.supported_reasoning_levels;
  if (!Array.isArray(source)) return [];
  const values = source.flatMap((item) => {
    const value = typeof item === "string" ? text(item) : text(object(item)?.effort);
    return value ? [value] : [];
  });
  return [...new Set(values)];
}

/**
 * Parse the gateway's `/v1/models` response into host model definitions.
 *
 * Prefers the gateway's `models` array (context windows, reasoning levels) and
 * falls back to the OpenAI-shaped `data` array. Models flagged unavailable or
 * hidden are skipped.
 *
 * Args:
 *   body: Decoded JSON body from `/v1/models`.
 *
 * Returns:
 *   Model definitions, each carrying its reasoning efforts in privateData.
 *
 * Raises:
 *   Error: When neither model array is present.
 */
export function parseGatewayModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = Array.isArray(root?.models) ? root.models : Array.isArray(root?.data) ? root.data : null;
  if (!source) throw new Error("Kiro Gateway model discovery response does not contain a model list");
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const raw of source) {
    const model = object(raw);
    if (!model) continue;
    if (model.supported_in_api === false) continue;
    if (text(model.visibility)?.toLowerCase() === "hidden") continue;
    const id = text(model.slug ?? model.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const description = text(model.description);
    const maxOutputTokens = positiveInteger(model.max_output_tokens);
    const upstreamName = text(model.display_name);
    models.push({
      id,
      displayName: upstreamName && upstreamName !== id ? upstreamName : humanizeModelId(id),
      ...(description ? { description } : {}),
      ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
      capabilities: { images: true },
      privateData: {
        reasoningEfforts: parseReasoningEfforts(model),
        contextWindow: positiveInteger(model.context_window),
      },
    });
  }
  return models;
}

/**
 * Read the reasoning efforts recorded for a model at discovery time.
 *
 * Args:
 *   model: Model snapshot handed back by the host on each call.
 *
 * Returns:
 *   Effort identifiers the model accepts; empty when it has no reasoning control.
 */
export function reasoningEfforts(model: ModelSnapshot): string[] {
  const efforts = object(model.privateData)?.reasoningEfforts;
  return Array.isArray(efforts) ? efforts.filter((item) => typeof item === "string") : [];
}

export const gatewayModels: ModelSupport = {
  list: async (_input, context): Promise<ModelDefinition[]> => {
    const gateway = await loadGateway(context);
    let response;
    try {
      response = await context.network.fetch(gatewayUrl(gateway, "/models"), {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${gateway.apiKey}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        redactKey(`Kiro Gateway is not reachable at ${gateway.baseUrl}. Start the tray app. ${message}`, gateway),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        redactKey(`Kiro Gateway model discovery failed (HTTP ${response.status}): ${response.body}`, gateway),
      );
    }
    let body: JsonValue;
    try {
      body = JSON.parse(response.body) as JsonValue;
    } catch {
      throw new Error("Kiro Gateway model discovery returned invalid JSON");
    }
    const models = parseGatewayModels(body);
    if (models.length === 0) throw new Error("Kiro Gateway model discovery returned no callable models");
    return models;
  },
};
