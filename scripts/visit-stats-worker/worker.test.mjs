import test from 'node:test';
import assert from 'node:assert/strict';
import counter, {chinaDay, normalizePage, countVisit} from './index.mjs';

const ORIGIN = 'https://bieji-ai.github.io';
const secret = 'test_only_secret_1234567890_long_enough';

function fakeDb() {
  const daily = new Set();
  const historical = new Set();
  return {
    daily, historical,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO daily_uniques')) daily.add(JSON.stringify(args));
              else if (sql.startsWith('INSERT OR IGNORE INTO historical_uniques')) historical.add(args[0]); // primary key is the stable hash, not the first-seen date
              else if (sql.startsWith('DELETE FROM daily_uniques')) {
                for (const item of daily) if (JSON.parse(item)[0] < args[0]) daily.delete(item);
              } else throw new Error('unexpected SQL: ' + sql);
              return {success:true};
            },
            async first() {
              if (sql.includes('FROM historical_uniques')) return {n: historical.size};
              if (sql.includes('FROM daily_uniques')) {
                const [day, scope, page] = args;
                return {n: [...daily].filter(item => {
                  const values = JSON.parse(item);
                  return values[0] === day && values[1] === scope && values[2] === page;
                }).length};
              }
              throw new Error('unexpected SQL: ' + sql);
            }
          };
        },
        async first() {
          if (sql.includes('FROM historical_uniques')) return {n: historical.size};
          throw new Error('unexpected SQL');
        }
      };
    },
    async batch(statements) {
      for (const s of statements) await s.run();
      return statements.map(() => ({success:true}));
    }
  };
}

function request(path, ip = '203.0.113.1', origin = ORIGIN) {
  return new Request('https://counter.example.workers.dev/api/visit', {
    method:'POST',
    headers:{'Origin':origin,'CF-Connecting-IP':ip,'Content-Type':'application/json'},
    body:JSON.stringify({path})
  });
}

async function visit(env, path, ip, origin) {
  const response = await counter.fetch(request(path, ip, origin), env);
  return {status:response.status,body:await response.json(),response};
}

test('uses Beijing calendar boundary and validates old frontend page input',()=>{
  assert.equal(chinaDay(Date.parse('2026-11-23T15:59:59Z')),'2026-11-23');
  assert.equal(chinaDay(Date.parse('2026-11-23T16:00:00Z')),'2026-11-24');
  assert.equal(normalizePage('/a/index.html'),'/a/');
  assert.equal(normalizePage('/a//b'),'/a/b');
  for(const bad of ['https://evil.test/','//evil.test/','/a?x=1','', '/'.repeat(350)])
    assert.equal(normalizePage(bad),null);
});

test('same IP repeated and cross-page visits do not change either counter',async()=>{
  const env={DB:fakeDb(),VISITOR_HMAC_SECRET:secret};
  const a=await visit(env,'/first/','203.0.113.3');
  assert.deepEqual([a.status,a.body.site_daily_uv,a.body.site_total_uv],[200,1,1]);
  const again=await visit(env,'/first/','203.0.113.3');
  assert.deepEqual([again.body.site_daily_uv,again.body.site_total_uv],[1,1]);
  const otherPage=await visit(env,'/second/','203.0.113.3');
  assert.deepEqual([otherPage.body.site_daily_uv,otherPage.body.site_total_uv],[1,1]);
  const b=await visit(env,'/first/','203.0.113.4');
  assert.deepEqual([b.body.site_daily_uv,b.body.site_total_uv],[2,2]);
  assert.equal(env.DB.daily.size,2);
  assert.equal(env.DB.historical.size,2);
  for(const record of [...env.DB.daily,...env.DB.historical])
    assert.doesNotMatch(record,/203\.0\.113\./);
  assert.equal(b.response.headers.get('Cache-Control'),'no-store');
  assert.equal(b.response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
});

test('historical IP remains unique across days, while daily count resets',async()=>{
  const env={DB:fakeDb(),VISITOR_HMAC_SECRET:secret};
  const first=await countVisit(env,'203.0.113.3','2026-11-23');
  const next=await countVisit(env,'203.0.113.3','2026-11-24');
  assert.deepEqual([first.site_daily_uv,first.site_total_uv],[1,1]);
  assert.deepEqual([next.site_daily_uv,next.site_total_uv],[1,1]);
  const another=await countVisit(env,'203.0.113.4','2026-11-24');
  assert.deepEqual([another.site_daily_uv,another.site_total_uv],[2,2]);
  const future=await countVisit(env,'203.0.113.3','2026-11-25');
  assert.deepEqual([future.site_daily_uv,future.site_total_uv],[1,2]);
  assert.equal(env.DB.daily.size,4);
  assert.equal(env.DB.historical.size,2);
});

test('unauthorized, missing secret and invalid path never write records',async()=>{
  const db=fakeDb();
  const env={DB:db,VISITOR_HMAC_SECRET:secret};
  assert.equal((await visit(env,'/','203.0.113.3','https://evil.example')).status,403);
  assert.equal((await visit({DB:db},'/')).status,503);
  assert.equal((await visit(env,'/a?invalid=1')).status,400);
  assert.equal(db.daily.size,0);
  assert.equal(db.historical.size,0);
});

test('cleanup removes only old daily hashes, never historical hashes',async()=>{
  const db=fakeDb();
  const env={DB:db,VISITOR_HMAC_SECRET:secret};
  await countVisit(env,'203.0.113.2','2026-11-01');
  await countVisit(env,'203.0.113.3','2026-11-22');
  await counter.scheduled({scheduledTime:Date.parse('2026-11-23T20:00:00Z')},env);
  assert.equal(db.daily.size,1);
  assert.equal(db.historical.size,2);
});
