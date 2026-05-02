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

function log5Bucket(v) {
  return Math.round(Math.log(v) / Math.log(5));
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

  const ranked = [];

  for (const [url, inst] of Object.entries(instances)) {
    if (inst.network_type !== "normal") continue;
    if (inst.http?.status_code !== 200) continue;
    if (inst.http?.error != null) continue;
    if (inst.uptime?.uptimeDay !== 100) continue;
    if ((inst.timing?.initial?.all?.value ?? 999) >= 1) continue;
    if (inst.timing?.initial?.success_percentage !== 100) continue;
    if (inst.timing?.search?.success_percentage !== 100) continue;

    const engines = inst.engines || {};
    const vec = engineVector(engines);
    if (!vec[0] && !vec[1]) continue;

    const um = inst.uptime?.uptimeMonth ?? 0;
    const uy = inst.uptime?.uptimeYear ?? 0;
    if (um < 90 || uy < 90) continue;

    const speed = inst.timing?.search?.all?.median ?? 999;
    const load = inst.timing?.search?.load?.median ?? null;

    ranked.push({
      url,
      speedBucket: log5Bucket(speed),
      engineVec: vec,
      loadBucket: load != null ? Math.round(load * 10) : null,
      uptimeBucket: Math.round(um),
      totalEngines: Object.keys(engines).length,
      speed,
      load,
      uptimeMonth: um,
      uptimeYear: uy,
      htmlGrade: inst.html?.grade || '?',
    });
  }

  ranked.sort((a, b) => {
    if (a.speedBucket !== b.speedBucket) return a.speedBucket - b.speedBucket;
    const ec = compareEngineVectors(a.engineVec, b.engineVec);
    if (ec !== 0) return ec;
    const la = a.loadBucket ?? 999, lb = b.loadBucket ?? 999;
    if (la !== lb) return la - lb;
    if (b.uptimeBucket !== a.uptimeBucket) return b.uptimeBucket - a.uptimeBucket;
    return b.totalEngines - a.totalEngines;
  });

  const engineLabel = (v) => ENGINE_PRIORITY.map((e, i) =>
    `<span class="${v[i] ? 'ok' : 'fail'}">${e[0].toUpperCase()}</span>`
  ).join('');

  // Compute max visible lengths from actual data
  const urlLen = Math.max(...ranked.map(r => r.url.replace('https://','').length));
  const instanceW = Math.min(urlLen * 8 + 40, 500); // ~8px per char, cap at 500px
  const numW = 130; // "0.447s [-1]" fits in 130px
  const coreW = 56;  // "GBBD" with letter-spacing fits in 56px
  const shortW = 80; // "100.0%" or "256" fits in 80px

  const rows = ranked.map((r, i) => `
    <tr class="${i < 10 ? 'top10' : ''}">
      <td>${i + 1}</td>
      <td class="url"><a href="${r.url}" target="_blank">${r.url.replace('https://','')}</a></td>
      <td>${r.speed.toFixed(3)}s <span class="bucket">[${r.speedBucket}]</span></td>
      <td class="engines">${engineLabel(r.engineVec)}</td>
      <td>${r.load != null ? r.load.toFixed(3) + 's <span class=\"bucket\">[' + r.loadBucket + ']</span>' : '-'}</td>
      <td>${r.uptimeMonth.toFixed(1)}% <span class="bucket">[${r.uptimeBucket}]</span></td>
      <td>${r.totalEngines}</td>
      <td>${r.uptimeYear.toFixed(1)}%</td>
      <td>${r.htmlGrade}</td>
    </tr>`).join('\n');

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const outPath = process.argv[2] || path.join(__dirname, '..', 'ranking.html');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SearXNG Instance Ranking — ${ts}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 20px; background: #f5f5f5; }
  h1 { color: #333; }
  .meta { color: #666; margin-bottom: 20px; }
  table { border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #333; color: white; padding: 8px 10px; font-size: 13px; position: sticky; top: 0; white-space: nowrap; }
  td { padding: 6px 10px; border-bottom: 1px solid #eee; font-size: 13px; }
  tr.top10 { background: #e8f5e9; }
  tr:hover { background: #fff3e0; }
  .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .url a { color: #1976d2; text-decoration: none; }
  .engines { letter-spacing: 2px; white-space: nowrap; }
  .ok { color: #2e7d32; font-weight: bold; }
  .fail { color: #ccc; }
  .bucket { color: #999; font-size: 11px; }
  .legend { margin: 10px 0; font-size: 13px; color: #666; }
</style>
</head>
<body>
<h1>SearXNG Instance Ranking</h1>
<div class="meta">
  Generated: ${ts} UTC &nbsp;|&nbsp;
  ${ranked.length} healthy instances (from ${Object.keys(instances).length} total) &nbsp;|&nbsp;
  Top 10 highlighted
</div>
<div class="legend">
  Columns ordered by sort priority ①→⑤. <span class="bucket">[N]</span> = bucket for comparison.
  &nbsp;|&nbsp; <span class="ok">G</span>=Google <span class="ok">B</span>=Brave <span class="ok">B</span>=Bing <span class="ok">D</span>=DuckDuckGo
</div>
<table>
<colgroup>
  <col style="width:40px">
  <col style="width:${instanceW}px; max-width:500px">
  <col style="width:${numW}px">
  <col style="width:${coreW}px">
  <col style="width:${numW}px">
  <col style="width:${numW}px">
  <col style="width:${shortW}px">
  <col style="width:${shortW}px">
  <col style="width:${shortW}px">
</colgroup>
<thead>
<tr>
  <th>#</th><th>Instance</th><th>Speed [log₅]</th><th>Core</th><th>Load [×10]</th><th>Uptime [%]</th><th>Total</th><th>Yr Uptime</th><th>Grade</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;

  fs.writeFileSync(outPath, html, 'utf-8');
  console.error(`Wrote ${ranked.length} instances to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
