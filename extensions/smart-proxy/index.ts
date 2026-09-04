import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import {
  Agent,
  Dispatcher,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

const DIRECT = "direct";
const STATUS_ID = "smart-proxy";
const TEST_TIMEOUT_MS = 10_000;

export const CONFIG_PATH = join(homedir(), ".pi", "smart-proxy.json");

export type SmartProxyConfig = {
  default: string;
  proxies: Record<string, string>;
  rules: Array<{ via: string; domains: string[] }>;
};

type Pattern = {
  source: string;
  base: string;
  mode: "exact" | "suffix" | "subdomains";
};

type Decision = {
  via: string;
  pattern?: string;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown key: ${unknown[0]}`);
}

function compilePattern(value: string): Pattern {
  const input = value.trim().toLowerCase();
  let mode: Pattern["mode"] = "exact";
  let base = input;

  if (input.startsWith("*.")) {
    mode = "subdomains";
    base = input.slice(2);
  } else if (input.startsWith(".")) {
    mode = "suffix";
    base = input.slice(1);
  }

  base = base.replace(/\.$/, "");
  if (!base.includes(".") || base.includes("*")) throw new Error("must be a domain name");

  const ascii = domainToASCII(base);
  if (!ascii) throw new Error("must be a valid domain name");

  try {
    const parsed = new URL(`http://${ascii}`);
    if (parsed.hostname.toLowerCase().replace(/\.$/, "") !== ascii) {
      throw new Error();
    }
  } catch {
    throw new Error("must be a valid domain name");
  }

  const prefix = mode === "subdomains" ? "*." : mode === "suffix" ? "." : "";
  return { source: `${prefix}${ascii}`, base: ascii, mode };
}

function normalizeHostname(hostname: string): string {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return domainToASCII(value) || value;
}

function matchesCompiled(hostname: string, pattern: Pattern): boolean {
  if (pattern.mode === "exact") return hostname === pattern.base;
  if (hostname === pattern.base) return pattern.mode === "suffix";
  return hostname.endsWith(`.${pattern.base}`);
}

export function matchesDomain(hostname: string, rule: string): boolean {
  return matchesCompiled(normalizeHostname(hostname), compilePattern(rule));
}

function normalizeProxyUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a proxy URL`);

  const input = value.trim().replace(/^socks5h:/i, "socks5:");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} must be a valid proxy URL`);
  }

  if (!["http:", "https:", "socks:", "socks5:"].includes(url.protocol)) {
    throw new Error(`${label} must use http, https, socks, or socks5`);
  }
  if (!url.hostname) throw new Error(`${label} must include a host`);
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(`${label} must not include a path, query, or fragment`);
  }

  return url.toString();
}

export function parseConfig(value: unknown): SmartProxyConfig {
  const raw = asRecord(value, "config");
  onlyKeys(raw, ["default", "proxies", "rules"], "config");

  const proxyInput = asRecord(raw.proxies ?? {}, "proxies");
  const proxies: Record<string, string> = {};
  for (const [name, proxyUrl] of Object.entries(proxyInput)) {
    if (!/^[a-z][a-z0-9_-]*$/i.test(name) || name === DIRECT) {
      throw new Error(`invalid proxy name: ${name}`);
    }
    proxies[name] = normalizeProxyUrl(proxyUrl, `proxies.${name}`);
  }

  const routes = new Set([DIRECT, ...Object.keys(proxies)]);
  const defaultRoute = raw.default ?? DIRECT;
  if (typeof defaultRoute !== "string" || !routes.has(defaultRoute)) {
    throw new Error("default must name direct or a configured proxy");
  }

  const ruleInput = raw.rules ?? [];
  if (!Array.isArray(ruleInput)) throw new Error("rules must be an array");

  const seen = new Set<string>();
  const rules = ruleInput.map((item, ruleIndex) => {
    const rule = asRecord(item, `rules[${ruleIndex}]`);
    onlyKeys(rule, ["via", "domains"], `rules[${ruleIndex}]`);
    if (typeof rule.via !== "string" || !routes.has(rule.via)) {
      throw new Error(`rules[${ruleIndex}].via names an unknown route`);
    }
    if (!Array.isArray(rule.domains) || rule.domains.length === 0) {
      throw new Error(`rules[${ruleIndex}].domains must be a non-empty array`);
    }

    const domains = rule.domains.map((domain, domainIndex) => {
      if (typeof domain !== "string") {
        throw new Error(`rules[${ruleIndex}].domains[${domainIndex}] must be a string`);
      }
      let pattern: Pattern;
      try {
        pattern = compilePattern(domain);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`rules[${ruleIndex}].domains[${domainIndex}] ${message}`);
      }
      if (seen.has(pattern.source)) throw new Error(`duplicate domain rule: ${pattern.source}`);
      seen.add(pattern.source);
      return pattern.source;
    });

    return { via: rule.via, domains };
  });

  return { default: defaultRoute, proxies, rules };
}

function readConfig(): SmartProxyConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    throw new Error(`cannot read valid JSON from ${CONFIG_PATH}`);
  }
  return parseConfig(value);
}

function createProxyDispatcher(proxyUrl: string): Dispatcher {
  const url = new URL(proxyUrl);
  return url.protocol === "socks:" || url.protocol === "socks5:"
    ? new Socks5ProxyAgent(url)
    : new ProxyAgent(url.toString());
}

export class RoutingDispatcher extends Dispatcher {
  readonly config: SmartProxyConfig;
  readonly #dispatchers = new Map<string, Dispatcher>();
  readonly #rules: Array<{ via: string; patterns: Pattern[] }>;

  constructor(config: SmartProxyConfig) {
    super();
    this.config = config;
    this.#dispatchers.set(DIRECT, new Agent());
    for (const [name, proxyUrl] of Object.entries(config.proxies)) {
      this.#dispatchers.set(name, createProxyDispatcher(proxyUrl));
    }
    this.#rules = config.rules.map((rule) => ({
      via: rule.via,
      patterns: rule.domains.map(compilePattern),
    }));
  }

  routeFor(hostname: string): Decision {
    const host = normalizeHostname(hostname);
    for (const rule of this.#rules) {
      const pattern = rule.patterns.find((candidate) => matchesCompiled(host, candidate));
      if (pattern) return { via: rule.via, pattern: pattern.source };
    }
    return { via: this.config.default };
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const via = options.origin
      ? this.routeFor(new URL(options.origin).hostname).via
      : this.config.default;
    return this.#dispatchers.get(via)!.dispatch(options, handler);
  }

  close(): Promise<void>;
  close(callback: () => void): void;
  close(callback?: () => void): Promise<void> | void {
    const work = Promise.all([...new Set(this.#dispatchers.values())].map((item) => item.close())).then(() => {});
    if (!callback) return work;
    void work.then(callback, callback);
  }

  destroy(): Promise<void>;
  destroy(error: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(error: Error | null, callback: () => void): void;
  destroy(errorOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const error = typeof errorOrCallback === "function" ? undefined : errorOrCallback ?? undefined;
    const done = typeof errorOrCallback === "function" ? errorOrCallback : callback;
    const work = Promise.all(
      [...new Set(this.#dispatchers.values())].map((item) => error ? item.destroy(error) : item.destroy()),
    ).then(() => {});
    if (!done) return work;
    void work.then(done, done);
  }
}

function redactProxyUrl(value: string): string {
  const url = new URL(value);
  const auth = url.username || url.password ? "***@" : "";
  return `${url.protocol}//${auth}${url.host}`;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

function testUrl(input: string): URL {
  const value = input.trim();
  if (!value) throw new Error("usage: /proxy-test <hostname-or-url>");
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("proxy-test supports only HTTP(S) targets");
  }
  return url;
}

export default function smartProxy(pi: ExtensionAPI): void {
  let active: RoutingDispatcher | undefined;
  let previous: Dispatcher | undefined;

  const install = (): RoutingDispatcher => {
    const next = new RoutingDispatcher(readConfig());
    const current = getGlobalDispatcher();
    try {
      setGlobalDispatcher(next);
    } catch (error) {
      void next.close();
      throw error;
    }

    previous ??= current;
    const old = active;
    active = next;
    if (old) void old.close().catch(() => {});
    return next;
  };

  const setStatus = (ctx: Pick<ExtensionContext, "ui">, dispatcher: RoutingDispatcher): void => {
    const count = dispatcher.config.rules.reduce((total, rule) => total + rule.domains.length, 0);
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `proxy: ${count} domains`));
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      const dispatcher = install();
      setStatus(ctx, dispatcher);
      ctx.ui.notify(
        ctx.ui.theme.fg("success", `smart-proxy enabled (${dispatcher.config.default} by default)`),
        "info",
      );
    } catch (error) {
      ctx.ui.setStatus(STATUS_ID, "proxy: config error");
      ctx.ui.notify(`smart-proxy failed: ${errorText(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const dispatcher = active;
    active = undefined;
    ctx.ui.setStatus(STATUS_ID, undefined);
    if (!dispatcher) return;

    try {
      if (previous && getGlobalDispatcher() === dispatcher) setGlobalDispatcher(previous);
    } finally {
      await dispatcher.close().catch(() => {});
      previous = undefined;
    }
  });

  pi.registerCommand("proxy-reload", {
    description: "Reload smart proxy configuration",
    handler: async (_args, ctx) => {
      try {
        const dispatcher = install();
        setStatus(ctx, dispatcher);
        ctx.ui.notify(ctx.ui.theme.fg("success", "smart-proxy configuration reloaded"), "info");
      } catch (error) {
        ctx.ui.notify(`smart-proxy reload failed: ${errorText(error)}`, "error");
      }
    },
  });

  pi.registerCommand("proxy-status", {
    description: "Show smart proxy routes",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify(`smart-proxy is inactive; check ${CONFIG_PATH}`, "warning");
        return;
      }
      const routes = Object.entries(active.config.proxies)
        .map(([name, value]) => `${name}=${redactProxyUrl(value)}`)
        .join(", ");
      const domains = active.config.rules.reduce((total, rule) => total + rule.domains.length, 0);
      const owner = getGlobalDispatcher() === active ? "active" : "overridden";
      const message = `smart-proxy ${owner}\ndefault=${active.config.default}\nroutes=${routes || "direct only"}\nrules=${domains}\nconfig=${CONFIG_PATH}`;
      ctx.ui.notify(owner === "active" ? ctx.ui.theme.fg("accent", message) : message, owner === "active" ? "info" : "warning");
    },
  });

  pi.registerCommand("proxy-test", {
    description: "Test the route and connectivity for a hostname or URL",
    handler: async (args, ctx) => {
      if (!active) {
        ctx.ui.notify("smart-proxy is inactive", "error");
        return;
      }

      try {
        const url = testUrl(args);
        const decision = active.routeFor(url.hostname);
        const response = await undiciFetch(url, {
          method: "HEAD",
          redirect: "manual",
          dispatcher: active,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        await response.body?.cancel();
        const matched = decision.pattern ? `, rule ${decision.pattern}` : ", default";
        ctx.ui.notify(
          ctx.ui.theme.fg("accent", `${url.hostname} → ${decision.via}${matched}: HTTP ${response.status}`),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`proxy test failed: ${errorText(error)}`, "error");
      }
    },
  });
}
