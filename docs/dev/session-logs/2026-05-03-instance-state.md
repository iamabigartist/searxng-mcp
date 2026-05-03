# 2026-05-03 Instance State Phase Log

## Scope

Implemented and verified the public SearXNG instance selection/runtime-state phase.

## Decisions

- Automatic mode uses the searx.space ranking order directly: try ranked instances from top to bottom until the first valid SearXNG JSON response succeeds.
- Static ranking remains independent from runtime state. Runtime state only decides whether an instance is skipped.
- The only hard filter remains `network_type !== "normal"`.
- Error state persists across MCP process restarts. Cooldown expiry makes an instance eligible again but does not reset counters.
- Only a valid successful SearXNG response resets an instance's error state.
- `observedLatencyMs` is recorded as an EWMA for diagnostics/future tuning, not used for ranking.
- `scripts/ranking-report.cjs` intentionally keeps a CommonJS copy of ranking logic because it runs directly from source without a TypeScript build. Keep it synchronized with `src/ranking.ts` when ranking rules change.

## Implemented

- Added `src/ranking.ts` for shared static ranking logic.
- Added `src/instance-state.ts` for error classification, backoff, persistent runtime state, pruning, and atomic JSON writes.
- Refactored `src/index.ts` from startup-only random top-10 selection to per-request ranked fallback.
- Added `test/instance-state.test.mjs` using `node:test`.
- Added `env-paths` and removed unused `yaml`.
- Updated `README.md` and `README.zh-CN.md` to describe ranking fallback and persisted state.
- Added `docs/dev/instance-selection-state.md` as the design record.

## Review Fixes Applied

- Removed dead `formatResults` code.
- Removed unused `yaml` dependency.
- Removed the unimplemented `noJsonFormat` state field and aligned the design doc with the current JSON path.
- Classified invalid SearXNG response shape as `transient` using `ESEARXNG_INVALID_RESPONSE`.
- Added permanent-skip reset test coverage.
- Added documentation note for the CommonJS ranking report duplication.

## Verification

- `npm test -- --test-reporter=spec`: 6/6 tests passed; includes `tsc` build.
- `npm run ranking`: generated `ranking.html` with 71 instances.
- MCP newline-JSON `tools/list` smoke: passed.
- MCP newline-JSON real `tools/call` search smoke: passed for query `SearXNG`.
- `grep` confirmed no `as any`, `@ts-ignore`, or `@ts-expect-error` in changed source files.
- `lsp_diagnostics` could not run because `typescript-language-server` is not installed in this environment; `tsc` passed.

## Open Follow-ups

- If HTML parsing support is added later, revisit `format_disabled` instances rather than treating them as JSON-path failures.
- If ranking rules change, update both `src/ranking.ts` and `scripts/ranking-report.cjs` together.

## 2026-05-03 Loaded MCP Session QA

### User

> 不用管上述的opencode无法正常启动问题了, 已经解决了.
> 现在回到你的主任务: 目前searxng auto插件已经加载到了当前session, 自行测试是否正确, 并迭代和修改.

### Agent Actions

- Exercised the loaded `searxng-auto_searxngsearch` MCP tool with live searches from the current OpenCode session.
- Observed an initial all-fallback-failed result where the top 5 ranked public instances returned `permanent`, `format_disabled`, or `rate_limit` classifications.
- Confirmed subsequent live calls succeeded after persisted runtime state skipped failed instances and reached a working public instance.
- Probed searx.space ranked instances and confirmed the first 20 public JSON API calls could all fail with 429/403/500 despite healthy searx.space metadata.
- Increased the fallback attempt budget from 5 to 15 while preserving the existing 30-second elapsed-time cap, and added a timeout to direct `SEARXNG_URL` mode.
- Updated `.env.example` to document zero-config fallback and `USE_RANDOM_INSTANCE`.

## 2026-05-03 Remove Attempt Cap

### User

> 最大fallback次数默认100%应该就可以了吧, 感觉没必要限制重选次数?

### Agent Actions

- Removed `MAX_FALLBACK_ATTEMPTS` constant entirely. Fallback now iterates ranked instances until 30-second time cap, without a hard count limit.

## 2026-05-03 Switch to HTML Scraping

### User

> 那seaxng-public难道用的也是json API吗? 那意思是seaxng中难道也只有这几个能用么? 你不能够使用html方式么

### Agent Actions

- Added `cheerio` dependency for HTML parsing.
- Created `src/html-scrape.ts` module that extracts structured results from SearXNG HTML search result pages using cheerio selectors.
- Changed search flow from `format=json` to regular HTML scraping in both direct (`SEARXNG_URL`) and public-instance fallback paths.
- Removed `format_disabled` error class — `403` now classified as `unknown`.
- Rebuilt and verified: 6/6 tests pass, MCP smoke confirmed HTML scraping works on instances that previously returned 403/302 for JSON API.
- Dramatically increased the usable public instance pool from ~2-3 to most of the 71 ranked instances.
