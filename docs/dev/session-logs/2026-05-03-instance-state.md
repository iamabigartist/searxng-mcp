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
