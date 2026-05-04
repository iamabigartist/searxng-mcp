# SearXNG MCP Server

[English](README.md) | [中文](README.zh-CN.md)

> Forked from [tisDDM/searxng-mcp](https://github.com/tisDDM/searxng-mcp) (MIT).

零配置 SearXNG 搜索 MCP 服务器。不设 `SEARXNG_URL` 时，自动从 [searx.space](https://searx.space) 拉取公共实例排行，并按排行从前往后尝试，直到第一个实例搜索成功。

## 与原版区别

| | 原版 | 此 Fork |
|---|---|---|
| 实例来源 | `instances.yml`（静态列表，无健康数据） | `searx.space/data/instances.json`（实时健康指标） |
| 过滤条件 | 仅排除 hidden/onion | 仅排除非 `network_type=normal`（Tor/onion 等） |
| 实例选择 | 随机实例 | 排行优先 + 失败跳过 + 内存状态 |

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

- **⚠️ 公共实例是志愿者资源**：不设 `SEARXNG_URL` 时会自动使用公共 SearXNG 实例。这些实例由社区志愿者维护，请勿高频请求。**高频或商业用途请自托管** SearXNG 实例并设置 `SEARXNG_URL`。详见 [调研文档](docs/research.md)
- The tool scrapes SearXNG HTML search result pages rather than requiring JSON API support (which most public instances disable).
- **公共实例可能返回 429**：每个实例有各自限流策略。插件会记录 429、网络错误、服务器错误等状态，并在冷却时间内跳过对应实例。
- **响应速度波动**：不同实例地理位置和服务器配置不同，首次搜索可能略慢
- **实例排行可视化**：运行 `npm run ranking` 生成 `ranking.html`，查看当前 searx.space 数据下的完整排行。
- **运行状态**：自动模式在 MCP 进程内存中维护实例失败与延迟状态，session 结束即丢弃。冷却结束不会清空失败计数，只有成功搜索会重置该实例的错误状态。

## 工具

### `searxngsearch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | — | 搜索词 (required) |
| `language` | string | `en` | 语言代码 |
| `time_range` | string | — | `day` / `week` / `month` / `year` |
| `categories` | string[] | — | `general`, `images`, `news` 等 |
| `engines` | string[] | — | 指定搜索引擎 |
| `safesearch` | 0/1/2 | `1` | 安全搜索等级 |
| `max_results` | 1-50 | `10` | 返回结果数 |
| `pageno` | 1-∞ | `1` | Page number |

## License

MIT — 原始版权归 [tisDDM](https://github.com/tisDDM)，修改部分见上方区别。
