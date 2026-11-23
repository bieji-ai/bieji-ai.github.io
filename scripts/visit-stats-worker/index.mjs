const SITE_ORIGIN = 'https://bieji-ai.github.io';
const MAX_PAGE_LENGTH = 300;
const encoder = new TextEncoder();

export function chinaDay(time = Date.now()) {
  // Asia/Shanghai has a fixed UTC+08 offset and does not observe DST.
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function normalizePage(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      path.length > MAX_PAGE_LENGTH || /[?#\\\u0000-\u001f]/.test(path)) return null;
  const canonical = path.replace(/\/{2,}/g, '/').replace(/\/index\.html$/i, '/');
  return canonical || '/';
}

async function hmacFingerprint(message, key) {
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function countVisit(env, ip, day) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.VISITOR_HMAC_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']
  );
  const [dailyHash, historicalHash] = await Promise.all([
    hmacFingerprint('daily-ip-v1|' + day + '|' + ip, key),
    hmacFingerprint('historical-ip-v1|' + ip, key)
  ]);
  // Database uniqueness constraints make refreshes and concurrent requests idempotent.
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO daily_uniques (day, scope, page, visitor_hash) VALUES (?, ?, ?, ?)')
      .bind(day, 'site', '', dailyHash),
    env.DB.prepare('INSERT OR IGNORE INTO historical_uniques (visitor_hash, first_seen_day) VALUES (?, ?)')
      .bind(historicalHash, day)
  ]);
  const [daily, historical] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM daily_uniques WHERE day = ? AND scope = ? AND page = ?')
      .bind(day, 'site', '').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM historical_uniques').first()
  ]);
  return {date: day, site_daily_uv: Number(daily.n), site_total_uv: Number(historical.n)};
}

function corsHeaders(origin) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin'
  };
  if (origin === SITE_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = SITE_ORIGIN;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {status, headers: corsHeaders(origin)});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ok: true}, 200, origin);
    }
    if (url.pathname !== '/api/visit') return json({error: 'not_found'}, 404, origin);
    if (origin !== SITE_ORIGIN) return json({error: 'forbidden_origin'}, 403, origin);
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: corsHeaders(origin)});
    }
    if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405, origin);
    if (!env.DB || !env.VISITOR_HMAC_SECRET || env.VISITOR_HMAC_SECRET.length < 32) {
      return json({error: 'not_configured'}, 503, origin);
    }
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return json({error: 'missing_ip'}, 503, origin);
    const raw = await request.text();
    if (raw.length > 1024) return json({error: 'too_large'}, 413, origin);
    let payload;
    try { payload = JSON.parse(raw); } catch { return json({error: 'invalid_json'}, 400, origin); }
    // Accept the old frontend's page argument but never save or count per-page visits.
    if (!normalizePage(payload?.path)) return json({error: 'invalid_page'}, 400, origin);
    try {
      return json(await countVisit(env, ip, chinaDay()), 200, origin);
    } catch {
      // Never fabricate a zero when storage fails, and never log the raw IP.
      return json({error: 'storage_unavailable'}, 503, origin);
    }
  },
  async scheduled(event, env) {
    // Daily identifiers are short-lived. Historical HMACs are deliberately
    // retained to implement all-time uniqueness until the owner resets the counter.
    const cutoff = chinaDay(event.scheduledTime - 3 * 86400000);
    await env.DB.prepare('DELETE FROM daily_uniques WHERE day < ?').bind(cutoff).run();
  }
};
