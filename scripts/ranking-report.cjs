#!/usr/bin/env node
/**
 * Generate an HTML ranking report of all SearXNG instances.
 * Usage: node scripts/ranking-report.cjs [output-file]
 * Default output: ./ranking.html
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ENGINE_PRIORITY = ["google", "brave", "bing", "duckduckgo"];

function engineOk(engines, name) {
  const ei = engines[name];
  if (!ei) return false;
  return typeof ei !== "object" || (ei.error_rate ?? 0) === 0;
}

function engineVector(engines) {
  return ENGINE_PRIORITY.map(e => engineOk(engines, e));
}

function compareEngineVectors(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] ? -1 : 1;
  }
  return 0;
}

function logHalfBucket(v) {
  return Math.round(Math.log(v) / Math.log(0.5));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

async function main() {
  const data = await fetchJSON('https://searx.space/data/instances.json');
  const instances = data.instances || {};

  const allInstances = [];

  for (const [url, inst] of Object.entries(instances)) {
    if (inst.network_type !== "normal") continue;
    if (inst.http?.status_code !== 200) continue;

    const engines = inst.engines || {};
    const vec = engineVector(engines);
    const um = inst.uptime?.uptimeMonth ?? 0;
    const uy = inst.uptime?.uptimeYear ?? 0;
    const speed = inst.timing?.search?.all?.median ?? 999;

    // Health checks (search_fail is soft — shows in status but doesn't disqualify)
    const checks = {
      httpError: inst.http?.error != null,
      uptimeDay: inst.uptime?.uptimeDay !== 100,
      initialSlow: (inst.timing?.initial?.all?.value ?? 999) >= 1,
      initFail: inst.timing?.initial?.success_percentage !== 100,
      noEngine: !vec[0] && !vec[1],
    };

    const softWarnings = {
      searchFail: inst.timing?.search?.success_percentage !== 100,
    };

    const failedReasons = Object.entries(checks)
      .filter(([, v]) => v)
      .map(([k]) => {
        if (k === 'httpError') return 'http-error';
        if (k === 'uptimeDay') return `uptimeDay ${inst.uptime?.uptimeDay ?? 0}`;
        if (k === 'initialSlow') return 'slow-initial';
        if (k === 'initFail') return 'init-fail';
        if (k === 'noEngine') return 'no-G-no-B';
        return k;
      });
    
    // Soft warnings: show in status but don't disqualify
    const warnings = Object.entries(softWarnings)
      .filter(([, v]) => v)
      .map(([k]) => {
        if (k === 'searchFail') return 'search-fail';
        return k;
      });
    
    const healthy = failedReasons.length === 0;  // hard checks only

    allInstances.push({
      url,
      speedBucket: logHalfBucket(speed),
      engineVec: vec,
      uptimeBucket: Math.round(um),
      totalEngines: Object.keys(engines).length,
      speed,
      uptimeMonth: um,
      uptimeYear: uy,
      htmlGrade: inst.html?.grade || '?',
      healthy,
      status: healthy ? (warnings.length > 0 ? '⚠ ' + warnings.join(', ') : '✓') : failedReasons.join(', ') + (warnings.length ? ' + ' + warnings.join(', ') : ''),
    });
  }

  const healthyList = allInstances.filter(r => r.healthy);
  const unhealthyList = allInstances.filter(r => !r.healthy);

  const sortFn = (a, b) => {
    if (b.speedBucket !== a.speedBucket) return b.speedBucket - a.speedBucket;
    const ec = compareEngineVectors(a.engineVec, b.engineVec);
    if (ec !== 0) return ec;
    if (b.uptimeBucket !== a.uptimeBucket) return b.uptimeBucket - a.uptimeBucket;
    return b.totalEngines - a.totalEngines;
  };

  healthyList.sort(sortFn);
  unhealthyList.sort(sortFn);

  const engineLabel = (v) => ENGINE_PRIORITY.map((e, i) =>
    `<span class="${v[i] ? 'ok' : 'fail'}">${e[0].toUpperCase()}</span>`
  ).join('');

  // Max URL length for capping instance column width
  const allUrls = [...healthyList, ...unhealthyList];
  const maxUrlChars = Math.max(...allUrls.map(r => r.url.replace('https://','').length));
  const urlMaxW = Math.min(maxUrlChars * 8 + 40, 520);

  function renderRows(list, startIdx) {
    return list.map((r, i) => `
    <tr class="${i < 10 && r.healthy ? 'top10' : ''} ${r.healthy ? '' : 'unhealthy'}">
      <td>${startIdx + i + 1}</td>
      <td class="url"><a href="${r.url}" target="_blank">${r.url.replace('https://','')}</a></td>
      <td>${r.speed.toFixed(3)}s <span class="bucket">[${r.speedBucket}]</span></td>
      <td class="engines">${engineLabel(r.engineVec)}</td>
      <td>${r.uptimeMonth.toFixed(1)} <span class="bucket">[${r.uptimeBucket}]</span></td>
      <td>${r.totalEngines}</td>
      <td>${r.uptimeYear.toFixed(1)}</td>
      <td>${r.htmlGrade}</td>
      <td class="status">${r.status}</td>
    </tr>`).join('\n');
  }

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const outPath = process.argv[2] || path.join(__dirname, '..', 'ranking.html');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SearXNG Instance Ranking — ${ts}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 20px; background: #f5f5f5; }
  h1 { color: #333; }
  .meta { color: #666; margin-bottom: 20px; }
  table { table-layout: fixed; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #333; color: white; padding: 8px 10px; font-size: 13px; position: sticky; top: 0; text-align: left; }
  td { padding: 6px 10px; border-bottom: 1px solid #eee; font-size: 13px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
   th:first-child { width: 40px; }
   th:nth-child(2) { width: ${urlMaxW}px; }
   th:nth-child(3) { width: 140px; }
   th:nth-child(4) { width: 60px; }
   th:nth-child(5) { width: 120px; }
   th:nth-child(6) { width: 60px; }
   th:nth-child(7) { width: 100px; }
   th:nth-child(8) { width: 60px; }
   th:nth-child(9) { width: 120px; }
   tr.top10 { background: #e8f5e9; }
   tr.unhealthy { background: #fff3e0; }
  tr:hover { background: #fff3e0; }
  .url a { color: #1976d2; text-decoration: none; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .engines { letter-spacing: 2px; white-space: nowrap; }
  .ok { color: #2e7d32; font-weight: bold; }
  .fail { color: #ccc; }
   .bucket { color: #999; font-size: 11px; }
   .status { color: #e65100; font-size: 11px; }
   h2 { margin: 20px 0 10px; color: #333; }
</style>
</head>
<body>
<h1>SearXNG Instance Ranking</h1>
<div class="meta">
  Generated: ${ts} UTC &nbsp;|&nbsp;
  ${healthyList.length} healthy + ${unhealthyList.length} unhealthy (${allInstances.length} total normal instances)
</div>
<div class="legend">
  <span class="ok">G</span>=Google <span class="ok">B</span>=Brave <span class="ok">B</span>=Bing <span class="ok">D</span>=DuckDuckGo &nbsp;|&nbsp;
  <span class="bucket">[N]</span> = bucket for comparison
</div>
<h2>Healthy (${healthyList.length})</h2>
<table>
<thead>
<tr>
  <th>#</th><th>Instance</th><th>Speed [log₀.₅]</th><th>Core</th><th>Uptime Monthly</th><th>Total</th><th>Uptime Yearly</th><th>Grade</th><th>Status</th>
</tr>
</thead>
<tbody>
${renderRows(healthyList, 0)}
</tbody>
</table>

<h2>Unhealthy (${unhealthyList.length})</h2>
<table>
<thead>
<tr>
  <th>#</th><th>Instance</th><th>Speed [log₀.₅]</th><th>Core</th><th>Uptime Monthly</th><th>Total</th><th>Uptime Yearly</th><th>Grade</th><th>Status</th>
</tr>
</thead>
<tbody>
${renderRows(unhealthyList, healthyList.length)}
</tbody>
</table>
</body>
</html>`;

  fs.writeFileSync(outPath, html, 'utf-8');
  console.error(`Wrote ${allInstances.length} instances (${healthyList.length} healthy) to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
