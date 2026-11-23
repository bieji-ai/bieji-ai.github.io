(() => {
  'use strict';
  if (window.__siteVisitStatsStarted) return;
  window.__siteVisitStatsStarted = true;

  const API_URL = 'https://straight-visit-stats.bieji-ai-straight-2026.workers.dev/api/visit';
  const keys = ['site_daily_uv', 'site_total_uv'];
  let totals = null;
  let status = '统计加载中';

  function paint() {
    for (const key of keys) {
      for (const node of document.querySelectorAll('[data-visit-stat="' + key + '"]')) {
        const value = totals && totals[key];
        node.textContent = Number.isSafeInteger(value) && value >= 0 ?
          value.toLocaleString('zh-CN') : '—';
      }
    }
    for (const node of document.querySelectorAll('[data-visit-status]')) node.textContent = status;
  }

  function mountGameStats() {
    for (const host of document.querySelectorAll('.intro-card, #overlay .intro-bottom')) {
      if (host.querySelector('.visit-stats')) continue;
      const box = document.createElement('aside');
      box.className = 'visit-stats visit-stats-game';
      box.setAttribute('aria-label', '全站 IP 访客统计');
      box.innerHTML = '<span>今日全站访客 <strong data-visit-stat="site_daily_uv">—</strong> IP</span>' +
        '<span>历史全站访客 <strong data-visit-stat="site_total_uv">—</strong> IP</span>' +
        '<span class="visit-stats-status" data-visit-status role="status"></span>';
      host.append(box);
    }
  }

  async function start() {
    const isGame = document.currentScript?.hasAttribute('data-game-stats') ||
      document.querySelector('script[data-game-stats]');
    if (isGame) {
      mountGameStats();
      const observer = new MutationObserver(records => {
        if (records.some(record => [...record.addedNodes].some(node =>
          node.nodeType === 1 && !node.closest?.('.visit-stats')))) {
          mountGameStats();
          paint();
        }
      });
      observer.observe(document.body, {childList: true, subtree: true});
    }

    if (!['http:', 'https:'].includes(location.protocol) ||
        /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      status = '本地预览不计数';
      paint();
      return;
    }
    if (!API_URL) {
      status = '访客统计待启用';
      paint();
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    paint();
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        headers: {'Content-Type': 'application/json'},
        // Keep path for compatibility with the previously deployed Worker.
        // The new Worker does not store or aggregate per-page visits.
        body: JSON.stringify({path: location.pathname}),
        signal: controller.signal,
        referrerPolicy: 'no-referrer'
      });
      if (!response.ok) throw new Error('counter_unavailable');
      const data = await response.json();
      if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
          !Number.isSafeInteger(data.site_daily_uv) || data.site_daily_uv < 0) {
        throw new Error('counter_malformed');
      }
      totals = {site_daily_uv: data.site_daily_uv};
      if (Number.isSafeInteger(data.site_total_uv) && data.site_total_uv >= 0) {
        totals.site_total_uv = data.site_total_uv;
        status = '';
      } else {
        // The old deployed Worker returns daily stats only.
        // Preserve the verified daily value instead of inventing a historical count.
        status = '历史统计待启用';
      }
    } catch {
      status = '统计暂不可用';
    } finally {
      clearTimeout(timer);
      paint();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
