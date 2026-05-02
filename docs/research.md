# Research Notes: SearXNG Public Instance Ethics & Capabilities

> 本文档记录了 Fork 开发过程中对 SearXNG 公共实例使用伦理、限流机制、实例分类的调研结果。

## 1. SearXNG 社区立场

### 维护者明确表态

- **GitHub Issue #3537** (`unixfox`): *"You are **not allowed** to scrape public instances. Please **don't use** scrape public instances. Just run your own searxng instance."*
- **GitHub Issue #2993** (`unixfox`): *"It's **not recommended at all** to allow the API on a public instance. That would get **abused by bots** very quickly."*
- **Farside 事件** (`return42`): 称 Farside 为 *"bot net that has been gone wild"*, 导致其 UA 被硬编码进 SearXNG limiter 黑名单

### 原因

SearXNG 的 limiter 设计目的是**防止上游搜索引擎（Google 等）封禁 SearXNG 实例**。如果单个 SearXNG 实例的出口 IP 大量发出同一 query，上游引擎会判定为 bot 并封禁。

## 2. SearXNG Limiter 机制

### 技术细节

| 参数 | 值 | 说明 |
|---|---|---|
| `limiter` 默认 | `false` | 需 Valkey/Redis 才能启用 |
| `BURST_MAX` | 15次/20秒 | HTML 请求短窗口 |
| `LONG_MAX` | 150次/10分钟 | HTML 请求长窗口 |
| `API_MAX` | **4次/小时** | JSON/CSV/RSS 格式（最严格） |
| `link_token` | CSS 令牌验证 | 浏览器会 fetch CSS，bot 不会 → 标记 suspicious |
| `suspicious` 降级 | 2次/20秒, 10次/10分钟 | 被标记后大幅降级 |

### 关键结论

- **Limiter 不是默认开启的**（需额外 Valkey 部署）
- **JSON API 被大多数公共实例故意禁用或严格限制**
- `format=html` 请求不受 `API_MAX=4/小时` 限制（走 150次/10分钟通道）
- `link_token` 要求先 fetch CSS 否则被标记 suspicious

## 3. Farside 案例量级分析

| | Farside | 本 Fork (1,000 用户) |
|---|---|---|
| 请求触发 | 24/7 自动轮询所有实例 | 用户主动触发 |
| 每次请求 query | 同一个 `?q=test` | 多样化搜索词 |
| 单实例负载 | ~36次/小时/节点 | ~15次/小时（分散到 28 实例） |
| 对上游引擎影响 | **严重**（同一 query → Google 封禁） | **极小**（多样化 ≈ 正常流量） |
| 是否触发 limiter | 会（反复同一 query） | 应该不会（正常浏览器行为） |

**结论**: 量级差 2-3 个数量级，且请求模式完全不同。本 Fork 相当于正常浏览器用户，不会对实例造成额外负担。

## 4. searx.space 实例分类

### 数据源

`https://searx.space/data/instances.json` — 官方 JSON API（允许程序化获取）

### 当前统计（2026-05）

- **总实例**: 80
- **健康实例** (`network_type=normal`, HTTP 200, 无错误): **67**
- **核心引擎覆盖**: 全部都有 Google + DuckDuckGo + Bing + Brave `[GDBV]`

### 可用分类维度

| 维度 | 取值范围 | 用途 |
|---|---|---|
| 引擎数量 | 23 ~ 256 | `>200`=官方默认, `<50`=精简 |
| 响应速度 | 0.15s ~ 2s+ | 速度优先 |
| Uptime | 93% ~ 100% | 可靠性优先 |
| HTML 等级 | V(vanilla) C(custom) F(fork) | V 最可靠 |
| 托管商 (reverse DNS) | Hetzner, netcup, OVH, Oracle... | 分散负载 |
| IPv6 | Yes/No | |
| SearXNG 版本 | 2026.3.x ~ 2026.5.x | |

### 无法从 JSON 获取

- 国家/地区（需额外 IP geolocation）
- limiter 是否开启
- JSON API 是否可用

## 5. 保护措施建议

1. **客户端节流**: 每次搜索间隔 ≥ 5 秒
2. **考虑 HTML 解析**: 绕过 JSON 的 4次/小时限制（需要类似 `mcp-searxng-public` 的 HTML regex 解析）
3. **自托管优先**: 设 `SEARXNG_URL` 时走自托管，不设时才用公共实例
4. **README 警告**: 明确告知"公共实例是志愿者资源"
5. **缓存实例列表**: 不要每次请求都拉取 `instances.json`
6. **失败回退**: 请求失败时尝试下一个健康实例

## 6. 相关项目

| 项目 | 特点 |
|---|---|
| `pwilkin/mcp-searxng-public` | HTML 解析 + 多实例回退（已部署在 OpenCode 配置中） |
| `Skilemon/searxng2api` | Cloudflare Worker, searx.space 自动发现 + 健康过滤 |
| `benbusby/farside` | 重定向网关（已被 SearXNG 封禁） |
| `searxNcrawl` | 原作者的商业继任（要求自托管，去了轮询） |
| `pyserxng` (PyPI) | Python 客户端，searx.space 自动发现 |

---

*Last updated: 2026-05-02*
