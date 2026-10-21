import type { PluginContext } from "cursor-byok:plugin";

/**
 * Tray `config.toml` locations per platform. They must match
 * `permissions.read` in plugin.json exactly: the host refuses any other path.
 */
export const CONFIG_PATHS: readonly string[] = [
  "~/Library/Application Support/KiroGatewayTray/config.toml",
  "~/.config/KiroGatewayTray/config.toml",
  "~/AppData/Local/KiroGatewayTray/KiroGatewayTray/config.toml",
];

export const TRAY_NOT_FOUND_MESSAGE = "Kiro Gateway tray config not found. Install and start the Kiro Gateway tray app first.";

/** Local gateway endpoint recovered from the tray configuration. */
export type Gateway = {
  /** OpenAI-compatible root, e.g. `http://127.0.0.1:64005/v1`. */
  baseUrl: string;
  /** The gateway's PROXY_API_KEY. */
  apiKey: string;
};

/**
 * Read one string or integer value from a TOML table.
 *
 * The tray writes a small flat file, so a line scanner is enough and avoids
 * bundling a TOML parser into the sandbox. Basic (`"…"`) and literal (`'…'`)
 * strings and bare values are recognized; inline comments are ignored.
 *
 * Args:
 *   content: Full text of the configuration file.
 *   table: Table name to search within, e.g. "gateway".
 *   key: Key to read inside that table.
 *
 * Returns:
 *   The value text, or null when the table or key is absent or empty.
 */
export function readTomlValue(content: string, table: string, key: string): string | null {
  let inTable = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inTable = line.replace(/^\[+/, "").replace(/\]+.*$/, "").trim() === table;
      continue;
    }
    if (!inTable) continue;
    const separator = line.indexOf("=");
    if (separator === -1 || line.slice(0, separator).trim() !== key) continue;
    const raw = line.slice(separator + 1).trim();
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    const literal = /^'([^']*)'/.exec(raw);
    const value = basic ? basic[1].replace(/\\(["\\])/g, "$1") : literal ? literal[1] : raw.replace(/\s*#.*$/, "");
    return value.trim() || null;
  }
  return null;
}

/**
 * Derive the local gateway endpoint from tray config text.
 *
 * Args:
 *   content: Full text of the tray `config.toml`.
 *
 * Returns:
 *   Loopback base URL and API key.
 *
 * Raises:
 *   Error: When the API key or port is missing or invalid.
 */
export function parseGateway(content: string): Gateway {
  const apiKey = readTomlValue(content, "gateway", "proxy_api_key");
  if (!apiKey) throw new Error("Kiro Gateway tray config has no [gateway] proxy_api_key.");
  const port = Number(readTomlValue(content, "gateway", "port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Kiro Gateway tray config has no valid [gateway] port.");
  }
  return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey };
}

/**
 * Locate and parse the tray configuration on this machine.
 *
 * Args:
 *   context: Host services for this call.
 *
 * Returns:
 *   The gateway endpoint read fresh from disk, so tray restarts that change
 *   the port or key are picked up without any plugin-side state.
 *
 * Raises:
 *   Error: When no tray config exists or it is unusable.
 */
export async function loadGateway(context: PluginContext): Promise<Gateway> {
  for (const path of CONFIG_PATHS) {
    const content = await context.file.read(path);
    if (content !== null) return parseGateway(content);
  }
  throw new Error(TRAY_NOT_FOUND_MESSAGE);
}

/**
 * Join a path onto the gateway root.
 *
 * Args:
 *   gateway: Local gateway endpoint.
 *   path: Path below the `/v1` root, e.g. `/models`.
 *
 * Returns:
 *   Absolute URL.
 */
export function gatewayUrl(gateway: Gateway, path: string): string {
  return `${gateway.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Remove the API key from text that may be shown in the UI or logs.
 *
 * Args:
 *   value: Text that may include the key.
 *   gateway: Endpoint whose key must not appear.
 *
 * Returns:
 *   The text with the key replaced.
 */
export function redactKey(value: string, gateway: Gateway): string {
  return gateway.apiKey.length < 8 ? value : value.split(gateway.apiKey).join("[redacted]");
}
