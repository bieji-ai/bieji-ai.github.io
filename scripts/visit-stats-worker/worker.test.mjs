import test from 'node:test';
import assert from 'node:assert/strict';
import counter, {chinaDay, normalizePage} from './index.mjs';

const ORIGIN = 'https://bieji-ai.github.io';
const secret = 'test_only_secret_1234567890_long_enough';

function fakeDb() {
  const data = new Set();
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.startsWith('INSERT')) data.add(JSON.stringify(args));
              if (sql.startsWith('DELETE')) {
                for (const record of data) {
                  if (JSON.parse(record)[0] < args[0]) data.delete(record);
                }
              }
              return {success: true};
            },
            async first() {
              const [date, scope, page] = args;
              return {n: [...data].filter(record => {
                const [recordDate, recordScope, recordPage] = JSON.parse(record);
                return recordDate === date && recordScope === scope && recordPage === page;
              }).length};
            },
          };
        }
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({success: true}));
    },
    data
  };
}

function request(path, ip = '203.0.113.1', origin = ORIGIN) {
  return new Request('https://counter.example.workers.dev/api/visit', {
    method: 'POST',
    headers: {'Origin': origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json'},
    body: JSON.stringify({path})
  });
}

async function visit(env, path, ip, origin) {
  const response = await counter.fetch(request(path, ip, origin), env);
  return {status: response.status, body: await response.json(), response};
}

test('uses fixed Beijing calendar-day boundary', () => {
  assert.equal(chinaDay(Date.parse('2026-11-23T15:59:59Z')), '2026-11-23');
  assert.equal(chinaDay(Date.parse('2026-11-23T16:00:00Z')), '2026-11-24');
});

test('normalizes paths, rejects arbitrary URLs or query variations', () => {
  assert.equal(normalizePage('/a/index.html'), '/a/');
  assert.equal(normalizePage('/ai-medical/'), '/ai-medical/');
  assert.equal(normalizePage('/a//b'), '/a/b');
  for (const bad of ['https://evil.test/', '//evil.test/', '/a?x=1', '/a#x', '', '/'.repeat(350)]) {
    assert.equal(normalizePage(bad), null);
  }
});

test('same IP on one page counts once, across pages only page count increases', async () => {
  const env = {DB: fakeDb(), VISITOR_HMAC_SECRET: secret};
  const a = await visit(env, '/first/', '203.0.113.3');
  assert.deepEqual([a.status,a.body.page_daily_uv,a.body.site_daily_uv], [200,1,1]);
  const again = await visit(env, '/first/', '203.0.113.3');
  assert.deepEqual([again.body.page_daily_uv,again.body.site_daily_uv], [1,1]);
  const secondPage = await visit(env, '/second/', '203.0.113.3');
  assert.deepEqual([secondPage.body.page_daily_uv,secondPage.body.site_daily_uv], [1,1]);
  const b = await visit(env, '/first/', '203.0.113.4');
  assert.deepEqual([b.body.page_daily_uv,b.body.site_daily_uv], [2,2]);
  assert.equal(env.DB.data.size, 5);
  for (const record of env.DB.data) {
    assert.doesNotMatch(record, /203\.0\.113\./);
  }
  assert.equal(b.response.headers.get('Cache-Control'), 'no-store');
  assert.equal(b.response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('unapproved origin and unconfigured backend are not counted', async () => {
  const db = fakeDb();
  const env = {DB:db,VISITOR_HMAC_SECRET:secret};
  assert.equal((await visit(env, '/', '203.0.113.3', 'https://evil.example')).status,403);
  assert.equal(db.data.size, 0);
  assert.equal((await visit({DB:db}, '/')).status,503);
  assert.equal((await visit(env, '/a?fake=1')).status,400);
});

test('clean-up removes expired daily fingerprints', async () => {
  const db = fakeDb();
  db.data.add(JSON.stringify(['2026-11-01','site','','oldhash']));
  db.data.add(JSON.stringify(['2026-11-22','site','','recenthash']));
  await counter.scheduled({scheduledTime: Date.parse('2026-11-23T20:00:00Z')}, {DB:db});
  assert.equal(db.data.size, 1);
});
