# Instance Selection and Runtime State Design

## Goal

The MCP server should use public SearXNG instances in ranked order, try the next eligible instance when one fails, and remember per-instance runtime state across restarts. Static ranking remains based on searx.space data. Runtime state decides whether an instance is temporarily skipped, not whether it is removed from the ranked list.

## Current Problem

`src/index.ts` currently selects one random instance from the top 10 at startup. Search requests keep using that one URL until the process restarts. The in-memory failure tracker records only status codes, deletes state when cooldown expires, and cannot survive restart. If the chosen instance fails, the tool call fails without trying another ranked instance.

## Ranking Boundaries

The existing ranking is preserved:

1. Exclude only non-clearnet instances: `network_type !== "normal"`.
2. Sort by speed bucket: `round(log(value) / log(0.5))`, descending.
3. Sort by core engine vector: Google, Brave, Bing, DuckDuckGo, lexicographic.
4. Sort by monthly uptime bucket, descending.
5. Sort by total engine count, descending.

No weighted score is introduced. Runtime failure state is a skip gate layered on top of ranking, not another ranking dimension.

## Runtime State Model

Each public instance URL has an optional in-memory state record:

```ts
interface InstanceRuntimeState {
  url: string;
  consecutiveFailures: Partial<Record<SearchErrorClass, number>>;
  lastErrorClass?: SearchErrorClass;
  lastStatusCode?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  observedLatencyMs?: number;
  totalRequests: number;
  totalFailures: number;
  permanentSkip?: boolean;
}
```

Cooldown expiry does not reset this state. A URL becomes eligible when the computed skip deadline has passed, but its failure counters remain. Only a valid successful search response resets error counters.

## Error Classes

```ts
type SearchErrorClass =
  | "transient"
  | "rate_limit"
  | "server"
  | "network"
  | "permanent"
  | "unknown";
```

Classification rules:

- `429` => `rate_limit`.
- `302` redirect to `/` or another non-search landing path => `permanent` for JSON API use.
- `403` => `unknown`. HTML scraping does not request `format=json`, so a 403 is an unexpected server response.
- `500..599` => `server`.
- Axios network codes such as `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED` => `network`.
- Valid HTTP 2xx with malformed or non-SearXNG JSON => `transient`.
- Anything else => `unknown`.

A successful SearXNG JSON response does not need non-empty results. `number_of_results: 0` with `results: []` can be legitimate. Success means HTTP 2xx and a recognizable SearXNG response shape such as a string `query` and array `results`.

## Skip Time Calculation

Skip time is computed from in-memory failure counters:

| Class | Base | Multiplier | Cap |
|---|---:|---:|---:|
| `transient` | 5s | 1.0 | 1m |
| `network` | 10s | 1.0 | 5m |
| `server` | 30s | 1.5 | 30m |
| `rate_limit` | 60s | 2.0 | 24h |
| `permanent` | forever | — | forever |
| `unknown` | 30s | 1.5 | 30m |

`skipMs = min(baseMs * multiplier ** max(failures - 1, 0), capMs)`.

`skipUntil = lastFailureAt + skipMs`. When `now >= skipUntil`, the instance is eligible again, but the counters remain. If it fails again, the counter increments and the next skip grows. If it succeeds, counters are reset.

## Selection Flow

For automatic public-instance mode:

1. Start the MCP stdio server without fetching public instances, so client initialization is not blocked by network discovery.
2. After stdio connection succeeds, start a background public-instance warmup that fetches and ranks all clearnet instances from searx.space.
3. Store that warmup as a shared initialization promise so a first search can await the same in-flight work instead of fetching twice.
4. If the warmup fails, clear the shared promise so a later search can retry discovery.
5. Prune in-memory state entries that are not present in the current public instance list after discovery succeeds.
6. On each tool call, iterate the ranked list from top to bottom.
7. Skip instances whose `computeSkipUntil(state, now)` is still in the future.
8. Try each eligible instance until the first valid successful response.
9. Record latency and success state for the winning instance.
10. Record error state for each failed instance.
11. Stop after at most 30 seconds total. No hard attempt count limit.

The MCP server scrapes SearXNG HTML search results pages instead of requiring `format=json` support. This avoids the `format_disabled` class entirely since most public instances disable `format=json` but serve regular HTML.

If `SEARXNG_URL` is explicitly set, the user-selected self-hosted instance is tried first. A valid SearXNG results page from that instance is returned as-is, including zero-result pages. If that request fails with a network/server/rate-limit/invalid-response error and `USE_RANDOM_INSTANCE` is still enabled, the server falls back to the ranked public-instance list. Set `USE_RANDOM_INSTANCE=false` to make the custom URL mandatory and disable public fallback.

## Persistence

Runtime state is kept purely in-memory within each MCP process. Each Chat session spawns its own MCP process, so state is naturally per-session with zero cross-session contamination. When a session ends and the MCP process exits, state is discarded.

This replaces the previous file-based persistence (`env-paths` + `instance-state.json`) which introduced cross-process race conditions, stale file cleanup complexity, and unnecessary disk I/O for data that only needs to live within a single session lifetime.

## Mutable Metrics

`observedLatencyMs` is an EWMA updated after successful requests:

```ts
next = old === undefined ? latencyMs : 0.3 * latencyMs + 0.7 * old;
```

This is stored for diagnostics and future tuning. It does not change the static ranking order in this implementation.

## Implementation Plan

1. Extract ranking into `src/ranking.ts` and reuse it from `src/index.ts`.
2. Add `src/instance-state.ts` with pure classification, skip calculation, success/failure state update, and pruning helpers.
3. Add `test/instance-state.test.mjs` using `node:test` against the built JS output.
4. Add a `test` script that builds first and runs `node --test`.
5. Refactor `src/index.ts` to connect stdio first, warm ranked instances in the background, and await/retry the shared discovery promise from search.
6. Update README tuning notes after behavior changes.

`scripts/ranking-report.cjs` intentionally keeps a small CommonJS copy of the ranking logic because the report script runs directly from source without a prior TypeScript build. Keep it synchronized with `src/ranking.ts` when ranking rules change.

## Verification

- Unit tests cover skip calculation, cooldown expiry not resetting counters, success reset, error classification, EWMA update, and pruning.
- `npm test` must pass.
- `npm run build` must pass.
- Generated MCP server must start and list tools before public-instance discovery can block client initialization, then perform a search through a minimal smoke test.
