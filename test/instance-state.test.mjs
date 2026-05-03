import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifySearchError,
  computeSkipUntil,
  createRuntimeState,
  isValidSearXNGResponse,
  pruneRuntimeState,
  recordFailure,
  recordSuccess,
} from '../build/instance-state.js';

test('rate limit backoff persists after cooldown expires until success', () => {
  let state = createRuntimeState('https://example.test');
  state = recordFailure(state, { errorClass: 'rate_limit', statusCode: 429, now: 1_000 });

  assert.equal(state.consecutiveFailures.rate_limit, 1);
  assert.equal(computeSkipUntil(state, 1_000), 61_000);
  assert.equal(computeSkipUntil(state, 61_001), undefined);
  assert.equal(state.consecutiveFailures.rate_limit, 1);

  state = recordFailure(state, { errorClass: 'rate_limit', statusCode: 429, now: 62_000 });

  assert.equal(state.consecutiveFailures.rate_limit, 2);
  assert.equal(computeSkipUntil(state, 62_000), 182_000);
});

test('success resets failures and updates latency EWMA', () => {
  let state = createRuntimeState('https://example.test');
  state = recordFailure(state, { errorClass: 'server', statusCode: 503, now: 1_000 });
  state = recordSuccess(state, { latencyMs: 100, now: 2_000 });

  assert.deepEqual(state.consecutiveFailures, {});
  assert.equal(state.lastErrorClass, undefined);
  assert.equal(state.observedLatencyMs, 100);

  state = recordSuccess(state, { latencyMs: 200, now: 3_000 });
  assert.equal(state.observedLatencyMs, 130);
});

test('classifies SearXNG-specific error responses', () => {
  assert.equal(classifySearchError({ response: { status: 429 } }), 'rate_limit');
  assert.equal(classifySearchError({ response: { status: 302, headers: { location: '/' } } }), 'permanent');
  assert.equal(classifySearchError({ response: { status: 403 } }), 'format_disabled');
  assert.equal(classifySearchError({ response: { status: 503 } }), 'server');
  assert.equal(classifySearchError({ code: 'ENOTFOUND' }), 'network');
  assert.equal(classifySearchError({ code: 'ESEARXNG_INVALID_RESPONSE' }), 'transient');
  assert.equal(classifySearchError(new Error('plain failure')), 'unknown');
});

test('permanent failures skip forever until a later success resets state', () => {
  let state = createRuntimeState('https://example.test');
  state = recordFailure(state, { errorClass: 'permanent', statusCode: 302, now: 1_000 });

  assert.equal(computeSkipUntil(state, 1_000), Number.POSITIVE_INFINITY);

  state = recordSuccess(state, { latencyMs: 100, now: 2_000 });

  assert.equal(state.permanentSkip, false);
  assert.equal(computeSkipUntil(state, 2_000), undefined);
});

test('accepts zero-result SearXNG response as valid success', () => {
  assert.equal(isValidSearXNGResponse({ query: 'zzzz', results: [], number_of_results: 0 }), true);
  assert.equal(isValidSearXNGResponse('<html>not json</html>'), false);
  assert.equal(isValidSearXNGResponse({ results: [] }), false);
});

test('prunes state entries absent from current ranked public instances', () => {
  const state = {
    'https://keep.test': createRuntimeState('https://keep.test'),
    'https://drop.test': createRuntimeState('https://drop.test'),
  };

  const pruned = pruneRuntimeState(state, new Set(['https://keep.test']));

  assert.deepEqual(Object.keys(pruned), ['https://keep.test']);
});
