# SearXNG MCP Server

> Fork 自 [tisDDM/searxng-mcp](https://github.com/tisDDM/searxng-mcp) (MIT) | [English](README.md)

零配置 SearXNG 搜索 MCP 服务器。不设 `SEARXNG_URL` 时，自动从 [searx.space](https://searx.space) 拉取健康公共实例并随机选用。

## 与原版区别

| | 原版 | 此 Fork |
|---|---|---|
| 实例来源 | `instances.yml`（静态列表，无健康数据） | `searx.space/data/instances.json`（实时健康指标） |
| 过滤条件 | 仅排除 hidden/onion | `network_type=normal` + `http 200` + `uptime 100%` + `响应 <1s` + `搜索成功率 100%` |
| 可选实例数 | ~71（含不可用） | ~28（已过滤为健康） |

## 安装

```bash
git clone <你的 fork 地址>
cd searxng-mcp
npm install && npm run build
```

## MCP 配置

### OpenCode

```jsonc
{
  "mcp": {
    "searxng": {
      "type": "local",
      "command": ["node", "/path/to/searxng-mcp/build/index.js"]
    }
  }
}
```

### Claude Desktop / VS Code

```json
{
  "mcpServers": {
    "searxng": {
      "command": "node",
      "args": ["/path/to/searxng-mcp/build/index.js"]
    }
  }
}
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SEARXNG_URL` | 否 | 自动从 searx.space 获取 | 指定自托管实例地址 |
| `USE_RANDOM_INSTANCE` | 否 | `true` | 设为 `false` 时须提供 `SEARXNG_URL` |
| `SEARXNG_USERNAME` | 否 | — | 自托管实例 Basic Auth 用户名 |
| `SEARXNG_PASSWORD` | 否 | — | 自托管实例 Basic Auth 密码 |

## 调参须知

- **公共实例可能返回 429**：各实例有独立限流策略，遇到 429 时重启 MCP 会话即可换实例
- **响应速度波动**：不同实例地理位置和服务器配置不同，首次搜索可能稍慢
- **健康过滤阈值可按需调整**：修改 `src/index.ts` 中 `getRandomSearXNGInstance()` 的过滤条件（如降低 uptime 阈值可增加候选实例数；放宽 response time 限制可纳入更多地区实例）
- **追求稳定建议自托管**：部署自己的 SearXNG 实例并设 `SEARXNG_URL`，完全避免公共实例的不确定性

## 工具

### `searxngsearch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | — | 搜索词（必填） |
| `language` | string | `en` | 语言代码，如 `zh`、`ja` |
| `time_range` | string | — | `day` / `week` / `month` / `year` |
| `categories` | string[] | — | `general`、`images`、`news` 等 |
| `engines` | string[] | — | 指定使用的搜索引擎 |
| `safesearch` | 0/1/2 | `1` | 0=关闭 1=中等 2=严格 |
| `max_results` | 1-50 | `10` | 最大返回结果数 |

## License

MIT — 原始版权归 [tisDDM](https://github.com/tisDDM)，修改部分见上方区别。
