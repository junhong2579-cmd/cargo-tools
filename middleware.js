import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

export async function middleware(request) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoginPage = request.nextUrl.pathname.startsWith('/login');
  const isApi = request.nextUrl.pathname.startsWith('/api');

  if (isApi) {
    return response;
  }

  // 1. 미로그인 상태 -> 무조건 /login으로 리다이렉트
  if (!user) {
    if (!isLoginPage) {
      const loginUrl = new URL('/login', request.url);
      return NextResponse.redirect(loginUrl);
    }
    return response;
  }

  // 2. 로그인된 사용자 -> profiles 승인 상태 조회
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_approved')
    .eq('id', user.id)
    .single();

  const isApproved = profile && profile.is_approved === true;

  // 3. 미승인 유저 -> /login?status=pending 으로 리다이렉트
  if (!isApproved) {
    if (!isLoginPage || request.nextUrl.searchParams.get('status') !== 'pending') {
      const pendingUrl = new URL('/login?status=pending', request.url);
      return NextResponse.redirect(pendingUrl);
    }
    return response;
  }

  // 4. 승인된 유저가 로그인 페이지에 접속했을 때 -> 메인 도구(/)로 이동
  if (isApproved && isLoginPage && request.nextUrl.searchParams.get('status') !== 'pending') {
    const homeUrl = new URL('/', request.url);
    return NextResponse.redirect(homeUrl);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
