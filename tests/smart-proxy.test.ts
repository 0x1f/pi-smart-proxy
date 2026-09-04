import assert from "node:assert/strict";
import test from "node:test";
import { getGlobalDispatcher } from "undici";
import smartProxy, {
  RoutingDispatcher,
  httpStatusColor,
  matchesDomain,
  parseConfig,
} from "../extensions/smart-proxy/index.ts";

test("domain rules keep exact, wildcard, and suffix semantics distinct", () => {
  assert.equal(matchesDomain("example.com", "example.com"), true);
  assert.equal(matchesDomain("api.example.com", "example.com"), false);
  assert.equal(matchesDomain("example.com", "*.example.com"), false);
  assert.equal(matchesDomain("API.Example.Com.", "*.example.com"), true);
  assert.equal(matchesDomain("example.com", ".example.com"), true);
  assert.equal(matchesDomain("deep.api.example.com", ".example.com"), true);
  assert.equal(matchesDomain("1.1.1.1", "1.1.1.1"), true);
  assert.equal(matchesDomain("[2001:0db8::1]", "2001:db8::1"), true);
  assert.throws(() => matchesDomain("1.1.1.1", "*.1.1.1.1"), /must be exact/);
});

test("HTTP statuses use semantic colors", () => {
  assert.deepEqual(
    [199, 200, 299, 300, 399, 400, 599].map(httpStatusColor),
    ["error", "success", "success", "warning", "warning", "error", "error"],
  );
});

test("config is strict and normalizes socks5h to proxy-side DNS SOCKS5", () => {
  const config = parseConfig({
    default: "direct",
    proxies: {
      socks: "socks5h://alice:p%40ss@127.0.0.1:7890",
      http: "http://bob:secret@127.0.0.1:7890",
    },
    rules: [{ via: "socks", domains: [".example.com"] }],
  });

  assert.equal(config.proxies.socks, "socks5://alice:p%40ss@127.0.0.1:7890");
  assert.equal(config.proxies.http, "http://bob:secret@127.0.0.1:7890/");
  assert.throws(
    () => parseConfig({ default: "direct", proxies: {}, rules: [{ via: "direct", domains: ["Google"] }] }),
    /must be a domain name/,
  );
});

test("config validates and normalizes IPv4 and IPv6 CIDRs", () => {
  const config = parseConfig({
    default: "direct",
    proxies: {},
    rules: [{ via: "direct", cidrs: ["10.0.0.0/8", "2001:0db8::/32"] }],
  });

  assert.deepEqual(config.rules[0], {
    via: "direct",
    domains: [],
    cidrs: ["10.0.0.0/8", "2001:db8::/32"],
  });
  assert.throws(
    () => parseConfig({ default: "direct", proxies: {}, rules: [{ via: "direct", cidrs: ["10.0.0.0/33"] }] }),
    /prefix must be between 0 and 32/,
  );
  assert.throws(
    () => parseConfig({ default: "direct", proxies: {}, rules: [{ via: "direct", cidrs: ["2001:db8::/129"] }] }),
    /prefix must be between 0 and 128/,
  );
  assert.throws(
    () => parseConfig({ default: "direct", proxies: {}, rules: [{ via: "direct", cidrs: ["example.com/24"] }] }),
    /must start with an IPv4 or IPv6 address/,
  );
  assert.throws(
    () =>
      parseConfig({
        default: "direct",
        proxies: {},
        rules: [{ via: "direct", cidrs: ["2001:0db8::/32", "2001:db8::/32"] }],
      }),
    /duplicate CIDR rule/,
  );
});

test("routing picks the first matching domain or CIDR and otherwise uses the default", async () => {
  const dispatcher = new RoutingDispatcher(parseConfig({
    default: "direct",
    proxies: { socks: "socks5://127.0.0.1:7890" },
    rules: [
      { via: "direct", domains: ["api.example.com", "2001:db8::42"] },
      { via: "socks", domains: [".example.com"], cidrs: ["10.0.0.0/8", "2001:db8::/32"] },
    ],
  }));

  assert.deepEqual(dispatcher.routeFor("api.example.com"), { via: "direct", pattern: "api.example.com" });
  assert.deepEqual(dispatcher.routeFor("www.example.com"), { via: "socks", pattern: ".example.com" });
  assert.deepEqual(dispatcher.routeFor("10.23.4.5"), { via: "socks", pattern: "10.0.0.0/8" });
  assert.deepEqual(dispatcher.routeFor("[2001:db8::42]"), { via: "direct", pattern: "2001:db8::42" });
  assert.deepEqual(dispatcher.routeFor("2001:db8::7"), { via: "socks", pattern: "2001:db8::/32" });
  assert.deepEqual(dispatcher.routeFor("example.net"), { via: "direct" });
  await dispatcher.close();
});

test("extension starts quietly and restores the global dispatcher", async () => {
  const events = new Map<string, (event: unknown, ctx: any) => unknown>();
  const commands = new Map<string, unknown>();
  const notifications: string[] = [];
  const statuses: string[] = [];
  let editorOpened = false;
  smartProxy({
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      events.set(name, handler);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
  } as never);

  const ctx = {
    ui: {
      theme: {
        fg(color: string, text: string) {
          return `<${color}>${text}</${color}>`;
        },
      },
      notify(message: string) {
        notifications.push(message);
      },
      async editor(_title: string, prefill: string) {
        editorOpened = true;
        assert.match(prefill, /"default"/);
        return undefined;
      },
      setStatus(_id: string, text: string | undefined) {
        if (text) statuses.push(text);
      },
    },
  };
  const before = getGlobalDispatcher();
  await events.get("session_start")!({}, ctx);
  assert.notEqual(getGlobalDispatcher(), before);
  assert.match(statuses[0]!, /^<accent>proxy:/);
  assert.deepEqual(notifications, []);
  assert.deepEqual([...commands.keys()], ["proxy-reload", "proxy-edit", "proxy-status", "proxy-test"]);

  const edit = commands.get("proxy-edit") as { handler(args: string, context: unknown): Promise<void> };
  await edit.handler("", ctx);
  assert.equal(editorOpened, true);

  const status = commands.get("proxy-status") as { handler(args: string, context: unknown): Promise<void> };
  await status.handler("", ctx);
  assert.match(notifications[notifications.length - 1]!, /^<accent>smart-proxy active\n/);

  await events.get("session_shutdown")!({}, ctx);
  assert.equal(getGlobalDispatcher(), before);
});
