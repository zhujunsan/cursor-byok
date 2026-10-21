import type { NetworkRequestInit, NetworkResponse, PluginContext } from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import { CONFIG_PATHS, loadGateway, parseGateway, readTomlValue, redactKey } from "./config.ts";
import { gatewayModels, humanizeModelId, parseGatewayModels } from "./models.ts";
import { gatewayProvider, payloadHint } from "./provider.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

async function assertRejects(task: () => Promise<unknown>, fragment: string): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(fragment), `expected "${fragment}" in "${message}"`);
    return;
  }
  throw new Error("expected rejection");
}

const SECRET = "tray-secret-key-123";
const TRAY_CONFIG = `[gateway]
profile_arn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/EXAMPLE"
proxy_api_key = "${SECRET}"
port = 64005 # default

[cloudflare]
hostname = "example.trycloudflare.com"
`;

type Files = Record<string, string>;
type FetchHandler = (url: string, init?: NetworkRequestInit) => NetworkResponse;

function context(files: Files, fetch?: FetchHandler, lines?: string[]): PluginContext {
  return {
    file: { read: (path) => Promise.resolve(files[path] ?? null) },
    network: {
      fetch: (url, init) => {
        if (!fetch) throw new Error("fetch was not expected");
        return Promise.resolve(fetch(url, init));
      },
      stream: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          lines: (async function* () {
            for (const line of lines ?? []) yield line;
          })(),
        }),
    },
    signal: new AbortController().signal,
  };
}

const TRAY_FILES: Files = { [CONFIG_PATHS[0]]: TRAY_CONFIG };

Deno.test("readTomlValue reads only the requested table and strips comments", () => {
  assertEquals(readTomlValue(TRAY_CONFIG, "gateway", "port"), "64005");
  assertEquals(readTomlValue(TRAY_CONFIG, "gateway", "proxy_api_key"), SECRET);
  assertEquals(readTomlValue(TRAY_CONFIG, "cloudflare", "port"), null);
  assertEquals(readTomlValue(TRAY_CONFIG, "gateway", "prox"), null);
  assertEquals(readTomlValue('[gateway]\nproxy_api_key = ""\n', "gateway", "proxy_api_key"), null);
});

Deno.test("parseGateway targets the loopback port from the tray config", () => {
  assertEquals(parseGateway(TRAY_CONFIG), { baseUrl: "http://127.0.0.1:64005/v1", apiKey: SECRET });
});

Deno.test("parseGateway rejects a missing key or an invalid port", () => {
  let failures = 0;
  for (const content of ["[gateway]\nport = 64005\n", `[gateway]\nproxy_api_key = "k"\nport = 0\n`, `[gateway]\nproxy_api_key = "k"\n`]) {
    try {
      parseGateway(content);
    } catch {
      failures += 1;
    }
  }
  assertEquals(failures, 3);
});

Deno.test("loadGateway tries each platform path and reports a missing tray", async () => {
  const linux = { [CONFIG_PATHS[1]]: TRAY_CONFIG };
  assertEquals((await loadGateway(context(linux))).baseUrl, "http://127.0.0.1:64005/v1");
  await assertRejects(() => loadGateway(context({})), "tray config not found");
});

Deno.test("redactKey hides the API key", () => {
  const gateway = parseGateway(TRAY_CONFIG);
  assertEquals(redactKey(`bad ${SECRET}`, gateway), "bad [redacted]");
});

Deno.test("humanizeModelId keeps acronyms uppercase", () => {
  assertEquals(humanizeModelId("minimax-m2.5"), "Minimax M2.5");
  assertEquals(humanizeModelId("gpt-5.6-luna"), "GPT 5.6 Luna");
  assertEquals(humanizeModelId("--"), "--");
});

Deno.test("parseGatewayModels filters hidden and duplicate entries and reads efforts", () => {
  const models = parseGatewayModels({
    models: [
      { slug: "auto", display_name: "auto", visibility: "list", supported_reasoning_levels: [] },
      {
        slug: "claude-sonnet-4.5",
        display_name: "Claude Sonnet 4.5",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, "low"],
        max_output_tokens: 8192,
        context_window: 200000,
      },
      { slug: "auto" },
      { slug: "secret", visibility: "hidden" },
      { slug: "offline", supported_in_api: false },
    ],
  });
  assertEquals(models.map((model) => model.id), ["auto", "claude-sonnet-4.5"]);
  assertEquals(models[0].displayName, "Auto");
  assertEquals(models[1].displayName, "Claude Sonnet 4.5");
  assertEquals(models[1].maxOutputTokens, 8192);
  assertEquals((models[1].privateData as { reasoningEfforts: string[] }).reasoningEfforts, ["low", "high"]);
});

Deno.test("parseGatewayModels falls back to the OpenAI data array", () => {
  assertEquals(parseGatewayModels({ data: [{ id: "glm-5" }] }).map((model) => model.displayName), ["GLM 5"]);
  try {
    parseGatewayModels({});
    throw new Error("expected failure");
  } catch (error) {
    assert((error as Error).message.includes("model list"));
  }
});

Deno.test("gatewayModels.list discovers the gateway with no resource", async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const models = await gatewayModels.list(
    { resource: null },
    context(TRAY_FILES, (url, init) => {
      requests.push({ url, authorization: init?.headers?.authorization });
      return { status: 200, headers: {}, body: JSON.stringify({ models: [{ slug: "auto" }] }) };
    }),
  );
  assertEquals(models.map((model) => model.id), ["auto"]);
  assertEquals(requests, [{ url: "http://127.0.0.1:64005/v1/models", authorization: `Bearer ${SECRET}` }]);
});

Deno.test("gatewayModels.list reports an auth failure without leaking the key", async () => {
  await assertRejects(
    () =>
      gatewayModels.list(
        { resource: null },
        context(TRAY_FILES, () => ({ status: 401, headers: {}, body: `bad key ${SECRET}` })),
      ),
    "HTTP 401",
  );
  try {
    await gatewayModels.list(
      { resource: null },
      context(TRAY_FILES, () => ({ status: 401, headers: {}, body: `bad key ${SECRET}` })),
    );
  } catch (error) {
    assert(!(error as Error).message.includes(SECRET), "key leaked");
  }
});

Deno.test("payloadHint fires only for payload-size failures", () => {
  assert(payloadHint("Improperly formed request") !== null);
  assertEquals(payloadHint("rate limited"), null);
});

const REQUEST: LlmRequest = {
  instructions: "",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  reasoning: { enabled: true, effort: "ultra" },
  latency: "fast",
  maxOutputTokens: null,
  cacheKey: null,
};

Deno.test("invoke streams text from the gateway and drops unsupported efforts", async () => {
  const events: ModelEvent[] = [];
  const result = await gatewayProvider.invoke(
    {
      model: { id: "auto", displayName: "Auto", privateData: { reasoningEfforts: ["low"] } },
      resource: null,
      request: REQUEST,
    },
    { emit: (event) => events.push(event) },
    context(TRAY_FILES, undefined, [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]),
  );
  assertEquals(result.status, "completed");
  assert(events.some((event) => event.type === "text-delta" && event.text === "ok"));
});

Deno.test("invoke reports a missing tray as a request error", async () => {
  const result = await gatewayProvider.invoke(
    { model: { id: "auto", displayName: "Auto" }, resource: null, request: REQUEST },
    { emit: () => {} },
    context({}),
  );
  assert(result.status === "request-error" && result.message.includes("tray config not found"));
});
