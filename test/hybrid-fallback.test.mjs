import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('configured instance failure falls back to ranked public instance', async () => {
  const selfHosted = await createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('self-hosted unavailable');
  });

  const publicInstance = await createServer((req, res) => {
    if (!req.url?.startsWith('/search')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
  <body>
    <div id="urls">
      <div id="result_count"><small>Number of results: 1</small></div>
      <article class="result">
        <a class="url_header" href="https://example.com/hybrid">https://example.com/hybrid</a>
        <h3><a href="https://example.com/hybrid">Hybrid fallback result</a></h3>
        <p class="content">Returned by the ranked public fallback instance.</p>
        <div class="engines"><span>google</span></div>
      </article>
    </div>
  </body>
</html>`);
  });

  const instancesList = await createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      instances: {
        [publicInstance.url]: {
          network_type: 'normal',
          engines: { google: { error_rate: 0 }, brave: { error_rate: 0 } },
          uptime: { uptimeMonth: 100 },
          timing: { search: { all: { median: 0.1 } } },
        },
      },
    }));
  });

  const child = spawn(process.execPath, ['build/index.js'], {
    env: {
      ...process.env,
      SEARXNG_URL: selfHosted.url,
      SEARXNG_INSTANCES_LIST_URL: `${instancesList.url}/data/instances.json`,
      SEARXNG_ALLOW_INSECURE_PUBLIC_INSTANCES_FOR_TESTS: 'true',
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
        clientInfo: { name: 'hybrid-fallback-test', version: '0.0.0' },
      },
    });
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'searxngsearch',
        arguments: { query: 'hybrid fallback', max_results: 1 },
      },
    });

    await waitFor(() => stdout.includes('"id":2'), 3_000, () => ({ stdout, stderr }));

    assert.match(stdout, /Hybrid fallback result/);
    assert.match(stderr, /Configured instance failed/);
    assert.match(stderr, /Search succeeded via/);
    assert.ok(stderr.indexOf(selfHosted.url) < stderr.indexOf(publicInstance.url), stderr);
  } finally {
    child.kill();
    await Promise.all([selfHosted.close(), publicInstance.close(), instancesList.close()]);
  }
});

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function createServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function waitFor(predicate, timeoutMs, debug) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for condition: ${JSON.stringify(debug(), null, 2)}`);
}
