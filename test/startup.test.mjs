import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

test('server initializes before background public-instance warmup', async () => {
  const child = spawn(process.execPath, ['build/index.js'], {
    env: {
      ...process.env,
      SEARXNG_URL: '',
      USE_RANDOM_INSTANCE: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '0.0.0' },
      },
    });
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    await waitFor(() => stdout.includes('"id":2'), 1_000, () => ({ stdout, stderr }));

    assert.match(stdout, /"searxngsearch"/);
    await waitFor(() => stderr.includes('Fetching instances from searx.space'), 3_000, () => ({ stdout, stderr }));

    assert.ok(
      stderr.indexOf('SearXNG MCP server running on stdio') < stderr.indexOf('Fetching instances from searx.space'),
      stderr,
    );
  } finally {
    child.kill();
  }
});

async function waitFor(predicate, timeoutMs, debug) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for condition: ${JSON.stringify(debug(), null, 2)}`);
}
