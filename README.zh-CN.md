# @0x1f/pi-smart-proxy

[English](README.md) | **简体中文**

一个轻量的 [Pi](https://pi.dev) 扩展，可根据目标域名、IP 地址或 CIDR，将 Undici 流量分别通过直连、HTTP(S) 代理或 SOCKS5 代理转发。

SOCKS5 目标域名由代理端解析。支持 `socks5://`，也兼容常见的 `socks5h://` 写法。

## 项目结构

```text
extensions/smart-proxy/index.ts  # Pi 扩展
examples/smart-proxy.json        # 安全的配置示例
tests/smart-proxy.test.ts        # 核心测试
index.ts                          # 本地自动发现兼容加载器
```

## 安装

需要 Node.js 22.19 或更高版本。安装指定标签的 Git 仓库：

```bash
pi install git:github.com/0x1f/pi-smart-proxy@v0.2.0
```

## 配置

参考 `examples/smart-proxy.json` 创建 `~/.pi/smart-proxy.json`，按需修改代理地址；如果配置中含有凭据，请限制文件权限：

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
      ],
      "cidrs": [
        "192.0.2.0/24",
        "2001:db8::/32"
      ]
    }
  ]
}
```

规则按顺序匹配，每条规则可包含 `domains`、`cidrs`，或同时包含两者：

- `example.com`：仅匹配该主机。
- `*.example.com`：匹配子域名，但不匹配根域名。
- `.example.com`：匹配根域名及其全部子域名。
- `1.1.1.1` 和 `2001:db8::1`：精确匹配 IPv4 和 IPv6 目标。
- `10.0.0.0/8` 和 `2001:db8::/32`：匹配对应网段内的字面量目标 IP。

CIDR 规则仅匹配字面量 IP，不会在本地解析域名，因此能够保留 SOCKS5 代理端 DNS 解析并避免 DNS 泄漏。

代理 URL 支持 `http:`、`https:`、`socks:`、`socks5:` 和 `socks5h:`。HTTP 与 SOCKS5 的用户名/密码认证使用标准 URL 凭据格式：

```json
{
  "proxies": {
    "socks": "socks5h://username:password@127.0.0.1:7890",
    "http": "http://username:password@127.0.0.1:7890"
  }
}
```

凭据中的保留字符必须进行百分号编码，例如将 `@` 写为 `%40`。`/proxy-status` 始终会隐藏凭据。

重启 Pi 或执行 `/reload`，然后可以使用：

```text
/proxy-edit
/proxy-status
/proxy-reload
/proxy-test api.x.ai
```

`/proxy-edit` 会在 Pi 的多行编辑器中打开当前 JSON；保存前会先进行校验，再以 `0600` 权限原子写入，并立即重新加载。取消编辑不会修改原文件。

## 注意事项

- 启动成功时不会弹出通知；状态栏会显示运行状态，配置失败时仍会提示。
- 状态与路由测试结果使用当前 Pi 主题：HTTP 2xx 显示为绿色，3xx 为黄色，4xx/5xx 为红色。
- Pi 卸载扩展时，会恢复此前的全局 Undici dispatcher。
- `pi-web-access` 中显式传入的 `proxy` 参数或全局代理配置会使用其 curl 传输，因此会绕过此 dispatcher。
- Undici 目前仍将 `Socks5ProxyAgent` 标记为实验性功能。

## 开发

```bash
npm install
npm test
npm pack --dry-run
```

## 许可证

MIT
