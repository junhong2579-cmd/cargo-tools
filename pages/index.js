import fs from 'fs';
import path from 'path';
import { createServerClient } from '@supabase/ssr';

export async function getServerSideProps(context) {
  const { req, res } = context;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return req.cookies ? Object.entries(req.cookies).map(([name, value]) => ({ name, value })) : [];
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax`);
          });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // 1. 미로그인 시 로그인 페이지로 즉시 리다이렉트
  if (!user) {
    return {
      redirect: {
        destination: '/login',
        permanent: false,
      },
    };
  }

  // 2. 승인 여부 확인
  const isManager = user.email && user.email.toLowerCase() === 'junhong2579@gmail.com';
  let isApproved = isManager;

  if (!isApproved) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_approved')
      .eq('id', user.id)
      .single();

    if (profile && profile.is_approved === true) {
      isApproved = true;
    }
  }

  if (!isApproved) {
    return {
      redirect: {
        destination: '/login?status=pending',
        permanent: false,
      },
    };
  }

  // 3. 승인된 사용자에게만 서버 비공개 파일(cargo-tool.html)을 직접 응답 전송!
  try {
    const filePath = path.join(process.cwd(), 'private', 'cargo-tool.html');
    let htmlContent = fs.readFileSync(filePath, 'utf8');
    htmlContent = htmlContent.replace('__USER_EMAIL__', user.email || '팀원');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.write(htmlContent);
    res.end();
  } catch (err) {
    console.error('Error reading cargo-tool.html:', err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }

  return { props: {} };
}

export default function IndexPage() {
  // 서버에서 직접 HTML 스트림을 응답하므로 클라이언트 컴포넌트는 비어있음
  return null;
}
