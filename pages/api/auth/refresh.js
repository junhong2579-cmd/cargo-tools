import { createServerClient } from '@supabase/ssr';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const setCookieHeaders = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return req.cookies
            ? Object.entries(req.cookies).map(([name, value]) => ({ name, value }))
            : [];
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            let cookieStr = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax`;
            if (options?.maxAge) {
              cookieStr += `; Max-Age=${options.maxAge}`;
            }
            setCookieHeaders.push(cookieStr);
          });
          if (setCookieHeaders.length > 0) {
            res.setHeader('Set-Cookie', setCookieHeaders);
          }
        },
      },
    }
  );

  try {
    // 3시간 비활동 검사
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const lastActiveCookie = req.cookies?.cargo_last_active;
    if (lastActiveCookie) {
      const lastActiveTime = parseInt(lastActiveCookie, 10);
      if (!isNaN(lastActiveTime) && (Date.now() - lastActiveTime > THREE_HOURS_MS)) {
        return res.status(401).json({ ok: false, error: 'Session timeout (3 hours inactive)' });
      }
    }

    // 세션 조회 및 토큰 자동 갱신 트리거
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return res.status(401).json({ ok: false, error: 'Session expired or invalid' });
    }

    return res.status(200).json({
      ok: true,
      email: user.email,
      refreshedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Session refresh error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}
