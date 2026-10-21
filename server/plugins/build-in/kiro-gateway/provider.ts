import type { PluginContext } from "cursor-byok:plugin";
import type { ProviderInvokeInput, ProviderOutput, ProviderResult, ProviderSupport } from "cursor-byok:provider";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { gatewayUrl, loadGateway, redactKey } from "./config.ts";
import { gatewayModels, reasoningEfforts } from "./models.ts";

/**
 * Kiro rejects serialized payloads above roughly 615 KB. Recognizing the
 * resulting message lets us return an actionable hint instead of raw upstream text.
 */
const PAYLOAD_MARKERS: readonly string[] = [
  "improperly formed request",
  "payload too large",
  "request too large",
];

/**
 * Turn an oversized-payload failure into guidance the user can act on.
 *
 * Args:
 *   body: Response body or stream error text.
 *
 * Returns:
 *   An actionable message, or null when the failure is unrelated to payload size.
 */
export function payloadHint(body: string): string | null {
  const value = body.toLowerCase();
  if (!PAYLOAD_MARKERS.some((marker) => value.includes(marker))) return null;
  return "Kiro rejected the request payload, usually because the conversation and " +
    "tool definitions exceed its size limit. Start a new chat, or enable " +
    "AUTO_TRIM_PAYLOAD in the Kiro Gateway tray settings.";
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  let gateway;
  try {
    gateway = await loadGateway(context);
  } catch (error) {
    return { status: "request-error", message: error instanceof Error ? error.message : String(error) };
  }
  // Forward only an effort the model advertises; Kiro rejects unknown values.
  const efforts = reasoningEfforts(input.model);
  const reasoning = input.request.reasoning;
  const effort = reasoning.effort !== null && efforts.includes(reasoning.effort) ? reasoning.effort : null;
  try {
    await streamOpenAiChat(
      {
        url: gatewayUrl(gateway, "/chat/completions"),
        model: input.model.id,
        request: {
          ...input.request,
          reasoning: { enabled: reasoning.enabled, effort },
          // The gateway maps latency tiers itself.
          latency: "standard",
        },
        headers: { authorization: `Bearer ${gateway.apiKey}` },
      },
      output,
      context,
    );
    return { status: "completed" };
  } catch (error) {
    const body = error instanceof HttpError ? error.body : "";
    const message = redactKey(error instanceof Error ? error.message : String(error), gateway);
    return { status: "request-error", message: payloadHint(body) ?? message };
  }
}

export const gatewayProvider: ProviderSupport = {
  id: "kiro",
  displayName: "Kiro",
  description: {
    "en-US": "Kiro (Amazon Q Developer) models through the local Kiro Gateway tray app.",
    "zh-CN": "通过本机 Kiro Gateway 托盘应用使用 Kiro（Amazon Q Developer）模型。",
  },
  providerType: "openai",
  models: gatewayModels,
  invoke,
};
