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

Each public instance URL has an optional persisted state record:

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

Skip time is computed from persistent failure counters:

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

1. Fetch and rank all clearnet instances from searx.space.
2. Prune persisted state entries that are not present in the current public instance list.
3. On each tool call, iterate the ranked list from top to bottom.
4. Skip instances whose `computeSkipUntil(state, now)` is still in the future.
5. Try each eligible instance until the first valid successful response.
6. Record latency and success state for the winning instance.
7. Record error state for each failed instance.
8. Persist state after every update.
9. Stop after at most 30 seconds total. No hard attempt count limit.

The MCP server scrapes SearXNG HTML search results pages instead of requiring `format=json` support. This avoids the `format_disabled` class entirely since most public instances disable `format=json` but serve regular HTML.

If `SEARXNG_URL` is explicitly set, the user-selected self-hosted instance is used directly. Public-instance state pruning and fallback do not apply to that custom URL.

## Persistence

Use a small JSON file under the OS data directory:

- Path resolution: `env-paths("searxng-mcp", { suffix: "" }).data`.
- File name: `instance-state.json`.
- Write pattern: atomic temp file in the same directory, then rename.
- On startup: missing file means empty state. Invalid JSON is ignored with a warning and replaced on next write.
- On write: keep the file bounded by pruning entries absent from the current searx.space list.

## Mutable Metrics

`observedLatencyMs` is an EWMA updated after successful requests:

```ts
next = old === undefined ? latencyMs : 0.3 * latencyMs + 0.7 * old;
```

This is stored for diagnostics and future tuning. It does not change the static ranking order in this implementation.

## Implementation Plan

1. Extract ranking into `src/ranking.ts` and reuse it from `src/index.ts`.
2. Add `src/instance-state.ts` with pure classification, skip calculation, success/failure state update, pruning, and JSON persistence helpers.
3. Add `test/instance-state.test.mjs` using `node:test` against the built JS output.
4. Add a `test` script that builds first and runs `node --test`.
5. Refactor `src/index.ts` to use ranked fallback per request rather than a startup-only random pick.
6. Update README tuning notes after behavior changes.

`scripts/ranking-report.cjs` intentionally keeps a small CommonJS copy of the ranking logic because the report script runs directly from source without a prior TypeScript build. Keep it synchronized with `src/ranking.ts` when ranking rules change.

## Verification

- Unit tests cover skip calculation, cooldown expiry not resetting counters, success reset, error classification, EWMA update, and pruning.
- `npm test` must pass.
- `npm run build` must pass.
- Generated MCP server must start and list tools through a minimal smoke test.
