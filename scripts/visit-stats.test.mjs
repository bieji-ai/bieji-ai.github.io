import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {withGameVisitStats} from './game-visit-stats.mjs';

const source = readFileSync(new URL('../assets/js/visit-stats.js', import.meta.url), 'utf8');

function fixture({endpoint = '', hostname = 'bieji-ai.github.io', pathname = '/ai-medical/'} = {}, reply = {
  date: '2026-11-23', page_daily_uv: 1, site_daily_uv: 3
}) {
  const boxes = Object.fromEntries(['page_daily_uv', 'site_daily_uv'].map(key =>
    [key, [{textContent: '—'}, {textContent: '—'}]]));
  const status = {textContent: ''};
  const requests = [];
  const timers = [];
  const timersCleared = [];
  const document = {
    readyState: 'complete',
    currentScript: null,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '[data-visit-status]') return [status];
      const match = selector.match(/data-visit-stat="([^"]+)"/);
      return match ? boxes[match[1]] || [] : [];
    },
  };
  const window = {};
  const fetch = async (url, options) => {
    requests.push({url, options});
    if (reply instanceof Error) throw reply;
    return {ok: true, json: async () => reply};
  };
  const script = source.replace("const API_URL = '';", "const API_URL = " + JSON.stringify(endpoint) + ';');
  const context = vm.createContext({
    document, window,
    location: {protocol: 'https:', hostname, pathname},
    fetch, AbortController, setTimeout: cb => (timers.push(cb), timers.length),
    clearTimeout: id => timersCleared.push(id),
    Math, Number
  });
  const run = () => vm.runInContext(script, context);
  run();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {boxes, status, requests, timers, timersCleared, run, flush};
}

test('without a deployed backend, do not call Busuanzi or show invented counts', async () => {
  const f = fixture();
  await f.flush();
  assert.equal(f.requests.length, 0);
  assert.equal(f.status.textContent, '按日 IP 统计待启用');
  assert.equal(f.boxes.page_daily_uv[0].textContent, '—');
  assert.doesNotMatch(source, /busuanzi\.ibruce\.info/);
});

test('one request updates repeated daily-IP displays; duplicate startup does not re-count', async () => {
  const f = fixture({endpoint: 'https://sample.workers.dev/api/visit'});
  await f.flush();
  f.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), {path: '/ai-medical/'});
  assert.equal(f.boxes.page_daily_uv[0].textContent, '1');
  assert.equal(f.boxes.site_daily_uv[1].textContent, '3');
  assert.equal(f.status.textContent, '');
  assert.deepEqual(f.timersCleared, [1]);
});

test('valid zeros display as zero; malformed response and failures do not display fake numbers', async () => {
  const ok = fixture({endpoint: 'https://sample.workers.dev/api/visit'},
    {date:'2026-11-23',page_daily_uv:0,site_daily_uv:0});
  await ok.flush();
  assert.equal(ok.boxes.page_daily_uv[0].textContent, '0');
  for (const reply of [
    {date: '2026-11-23', page_daily_uv: '12', site_daily_uv: 2},
    new Error('offline')
  ]) {
    const f = fixture({endpoint: 'https://sample.workers.dev/api/visit'}, reply);
    await f.flush();
    assert.equal(f.status.textContent, '统计暂不可用');
    assert.equal(f.boxes.site_daily_uv[0].textContent, '—');
  }
});

test('localhost never produces a real visit', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    const f = fixture({hostname, endpoint: 'https://sample.workers.dev/api/visit'});
    await f.flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.status.textContent, '本地预览不计数');
  }
});

test('game sync preserves the one-time stats integration', () => {
  const html = '<!doctype html><html><head></head><body>game</body></html>';
  for (const prefix of ['../../', '../../../']) {
    const injected = withGameVisitStats(html, prefix);
    assert.equal(withGameVisitStats(injected, prefix), injected);
    assert.ok(injected.includes('href="' + prefix + 'assets/css/visit-stats.css"'));
    assert.ok(injected.includes('src="' + prefix + 'assets/js/visit-stats.js"'));
    assert.equal((injected.match(/data-game-stats/g) || []).length, 1);
  }
});
