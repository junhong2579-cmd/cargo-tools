/* Supabase RPC 호출 (supabase/dashboard.sql 의 dash_* 함수).
   접근 토큰은 /api/auth/token(로그인 쿠키 기준)에서 받아 메모리에만 두고, 만료되면 다시 받는다.
   브라우저에서 refresh token 을 쓰지 않으므로 화물 업무 도구 본 화면의 로그인 세션과 충돌하지 않는다. */
(() => {
  'use strict';

  let auth = null; // { url, anonKey, accessToken, expiresAt }
  let pending = null;

  function getAuth(force = false) {
    const fresh = auth && (!auth.expiresAt || auth.expiresAt * 1000 - Date.now() > 60 * 1000);
    if (fresh && !force) return Promise.resolve(auth);
    if (!pending) {
      pending = fetch('/api/auth/token', { credentials: 'same-origin', cache: 'no-store' })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body.ok) {
            const err = new Error('로그인이 만료되었습니다. 화물 업무 도구에서 다시 로그인한 뒤 새로고침해 주세요.');
            err.auth = true;
            throw err;
          }
          auth = body;
          return body;
        })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  async function rpc(fn, args = {}, retried = false) {
    const a = await getAuth();
    const res = await fetch(`${a.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: a.anonKey, Authorization: `Bearer ${a.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (res.status === 401 && !retried) { // 토큰 만료 → 새 토큰으로 한 번 더
      await getAuth(true);
      return rpc(fn, args, true);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const missing = res.status === 404 || body?.code === 'PGRST202';
      const err = new Error(missing
        ? 'Supabase에 대시보드 함수가 없습니다. supabase/dashboard.sql 을 SQL Editor에서 실행해 주세요.'
        : body?.message || `${res.status} ${res.statusText}`);
      err.code = body?.code;
      err.auth = res.status === 401 || res.status === 403 || body?.code === '42501';
      throw err;
    }
    return body;
  }

  // 화물 업무 도구의 3시간 비활동 로그아웃 기준(cargo_last_active)에 대시보드 사용 시간도 포함한다.
  let lastPing = 0;
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, () => {
    const now = Date.now();
    if (now - lastPing < 30 * 1000) return;
    lastPing = now;
    try {
      localStorage.setItem('cargo_last_active', String(now));
      document.cookie = `cargo_last_active=${now}; path=/; max-age=86400; SameSite=Lax`;
    } catch { /* 저장소를 못 쓰면 무시 */ }
  }, { passive: true, capture: true }));

  window.DashApi = {
    meta: () => rpc('dash_meta'),
    options: () => rpc('dash_options'),
    summary: (f) => rpc('dash_summary', { f }),
    totals: (f) => rpc('dash_totals', { f }),
    detail: (f, opt) => rpc('dash_detail', { f, opt }),
  };
})();
