# SearXNG MCP Server

[English](README.md) | [中文](README.zh-CN.md)

> Forked from [tisDDM/searxng-mcp](https://github.com/tisDDM/searxng-mcp) (MIT).

零配置 SearXNG 搜索 MCP 服务器。不设 `SEARXNG_URL` 时，自动从 [searx.space](https://searx.space) 拉取健康公共实例并随机选用。

## 与原版区别

| | 原版 | 此 Fork |
|---|---|---|
| 实例来源 | `instances.yml`（静态列表，无健康数据） | `searx.space/data/instances.json`（实时健康指标） |
| 过滤条件 | 仅排除 hidden/onion | `network_type=normal` + `http 200` + `uptime 100%` + `response <1s` + `search success 100%` |
| 可选实例数 | ~71（含不可用） | ~28（已过滤为健康） |

## 安装

```bash
git clone <your-fork-url>
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
| `SEARXNG_URL` | 否 | 自动从 searx.space 获取 | 指定自托管实例 |
| `USE_RANDOM_INSTANCE` | 否 | `true` | 设为 `false` 时必须提供 `SEARXNG_URL` |
| `SEARXNG_USERNAME` | 否 | — | 自托管实例的 Basic Auth |
| `SEARXNG_PASSWORD` | 否 | — | 自托管实例的 Basic Auth |

## 调参须知

- **公共实例可能返回 429**：每个实例有各自限流策略，遇到 429 时重启 MCP 会话即可换一个实例
- **响应速度波动**：不同实例地理位置和服务器配置不同，首次搜索可能略慢
- **健康过滤可调整**：修改 `src/index.ts` 中 `getRandomSearXNGInstance()` 的过滤条件（如降低 uptime 阈值以增加候选实例）
- **自托管推荐**：如果需要稳定搜索，建议自托管 SearXNG 实例并设置 `SEARXNG_URL`

## 工具

### `searxngsearch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | — | 搜索词 |
| `language` | string | `en` | 语言代码 |
| `time_range` | string | — | `day` / `week` / `month` / `year` |
| `categories` | string[] | — | `general`, `images`, `news` 等 |
| `engines` | string[] | — | 指定搜索引擎 |
| `safesearch` | 0/1/2 | `1` | 安全搜索等级 |
| `max_results` | 1-50 | `10` | 返回结果数 |

## License

MIT — 原始版权归 [tisDDM](https://github.com/tisDDM)，修改部分见上方区别。
