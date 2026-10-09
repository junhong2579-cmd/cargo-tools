import { createServerClient } from '@supabase/ssr';

// 대시보드(/dash/index.html)가 Supabase RPC 를 부를 때 쓸 접근 토큰을 내려줍니다.
// 쿠키 세션 기준이며, 만료된 토큰은 여기서 갱신됩니다. 대시보드는 토큰을 저장하지 않고
// 만료 응답을 받으면 이 API 를 다시 호출합니다(브라우저 쪽에서 refresh token 을 쓰지 않음).
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

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
    // 3시간 비활동 검사 (refresh.js 와 동일)
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const lastActiveCookie = req.cookies?.cargo_last_active;
    if (lastActiveCookie) {
      const lastActiveTime = parseInt(lastActiveCookie, 10);
      if (!isNaN(lastActiveTime) && (Date.now() - lastActiveTime > THREE_HOURS_MS)) {
        return res.status(401).json({ ok: false, error: 'Session timeout (3 hours inactive)' });
      }
    }

    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
      return res.status(401).json({ ok: false, error: 'Session expired or invalid' });
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      return res.status(401).json({ ok: false, error: 'Session expired or invalid' });
    }

    // 데이터 조회 권한(승인 여부)은 Supabase 쪽 dash_can_read() 가 검사합니다.
    return res.status(200).json({
      ok: true,
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      accessToken: session.access_token,
      expiresAt: session.expires_at,
      email: user.email,
    });
  } catch (err) {
    console.error('Dashboard token error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}
