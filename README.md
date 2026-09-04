# @0x1f/pi-smart-proxy

A small [Pi](https://pi.dev) extension that routes Undici traffic by target domain through direct connections, HTTP(S) proxies, or SOCKS5 proxies.

SOCKS5 target names are resolved by the proxy. Both `socks5://` and the familiar `socks5h://` spelling are accepted.

## Structure

```text
extensions/smart-proxy/index.ts  # Pi extension
examples/smart-proxy.json        # Safe example configuration
tests/smart-proxy.test.ts        # Focused tests
index.ts                          # Local auto-discovery compatibility loader
```

## Install

Requires Node.js 22.19 or newer. Install the tagged Git repository:

```bash
pi install git:github.com/0x1f/pi-smart-proxy@v0.1.1
```

## Configure

Create `~/.pi/smart-proxy.json` from `examples/smart-proxy.json`, adjust the proxy addresses, and protect credentials if present:

```bash
chmod 600 ~/.pi/smart-proxy.json
```

```json
{
  "default": "direct",
  "proxies": {
    "socks": "socks5h://127.0.0.1:7890",
    "http": "http://127.0.0.1:7890"
  },
  "rules": [
    {
      "via": "socks",
      "domains": [
        ".openai.com",
        ".chatgpt.com",
        ".x.ai",
        ".grok.com"
      ]
    }
  ]
}
```

Rules are checked in order:

- `example.com` matches only that host.
- `*.example.com` matches subdomains, but not the apex.
- `.example.com` matches the apex and all subdomains.

Proxy URLs may use `http:`, `https:`, `socks:`, `socks5:`, or `socks5h:`. HTTP and SOCKS5 username/password authentication use standard URL credentials:

```json
{
  "proxies": {
    "socks": "socks5h://username:password@127.0.0.1:7890",
    "http": "http://username:password@127.0.0.1:7890"
  }
}
```

Percent-encode reserved characters in credentials, such as `@` as `%40`. `/proxy-status` always redacts credentials.

Restart Pi or run `/reload`, then use:

```text
/proxy-edit
/proxy-status
/proxy-reload
/proxy-test api.x.ai
```

`/proxy-edit` opens the current JSON in Pi's multiline editor, validates it before an atomic `0600` save, and reloads it immediately. Canceling leaves the file unchanged.

## Notes

- Status and route-test results highlight state, routes, matched rules, and HTTP results using the active Pi theme.
- The extension restores the previous global Undici dispatcher when Pi unloads it.
- An explicit `proxy` argument or global proxy setting in `pi-web-access` uses its curl transport and therefore bypasses this dispatcher.
- Undici currently marks `Socks5ProxyAgent` experimental.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

## License

MIT
