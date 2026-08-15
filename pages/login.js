import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { createClient } from '../lib/supabaseClient';

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();

  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });
  const [isPending, setIsPending] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState('');

  useEffect(() => {
    if (router.query.status === 'pending') {
      setIsPending(true);
    }
    checkSession();
  }, [router.query]);

  async function checkSession() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserEmail(user.email || '');
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_approved')
        .eq('id', user.id)
        .single();

      if (profile && profile.is_approved === true) {
        window.location.href = '/';
      } else {
        setIsPending(true);
      }
    }
  }

  async function handleAuth(e) {
    e.preventDefault();
    setMessage({ text: '', type: '' });

    if (!email || !password) {
      setMessage({ text: '이메일과 비밀번호를 모두 입력해주세요.', type: 'error' });
      return;
    }

    if (mode === 'signup') {
      if (password !== passwordConfirm) {
        setMessage({ text: '비밀번호와 비밀번호 확인이 일치하지 않습니다.', type: 'error' });
        return;
      }
      if (password.length < 6) {
        setMessage({ text: '비밀번호는 최소 6자리 이상이어야 합니다.', type: 'error' });
        return;
      }

      setLoading(true);
      setMessage({ text: '가입 신청 중입니다...', type: 'info' });

      try {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });

        if (error) {
          setMessage({ text: error.message || '가입 처리 중 오류가 발생했습니다.', type: 'error' });
          setLoading(false);
          return;
        }

        setCurrentUserEmail(email);
        setIsPending(true);
      } catch (err) {
        setMessage({ text: '네트워크 통신 중 오류가 발생했습니다.', type: 'error' });
      } finally {
        setLoading(false);
      }
    } else {
      setLoading(true);
      setMessage({ text: '로그인 확인 중...', type: 'info' });

      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) {
          setMessage({ text: '이메일 또는 비밀번호가 일치하지 않습니다.', type: 'error' });
          setLoading(false);
          return;
        }

        const user = data.user;
        setCurrentUserEmail(user.email || '');

        const { data: profile } = await supabase
          .from('profiles')
          .select('is_approved')
          .eq('id', user.id)
          .single();

        if (profile && profile.is_approved === true) {
          setMessage({ text: '로그인 성공! 메인 도구로 이동 중...', type: 'info' });
          // 쿠키가 브라우저에 안전하게 저장될 수 있도록 250ms 대기 후 이동
          setTimeout(() => {
            window.location.replace('/');
          }, 250);
          return;
        } else {
          setIsPending(true);
        }
      } catch (err) {
        setMessage({ text: '로그인 처리 중 오류가 발생했습니다.', type: 'error' });
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleCheckApproval() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setIsPending(false);
      setLoading(false);
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_approved')
      .eq('id', user.id)
      .single();

    setLoading(false);
    if (profile && profile.is_approved === true) {
      window.location.replace('/');
    } else {
      alert('아직 관리자 승인 대기 중입니다.\n관리자 승인 후 다시 확인해 주세요.');
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setIsPending(false);
    setEmail('');
    setPassword('');
    setPasswordConfirm('');
    setMessage({ text: '로그아웃 되었습니다.', type: 'info' });
    router.replace('/login');
  }

  return (
    <>
      <Head>
        <title>로그인 - 화물 업무 도구</title>
      </Head>
      <div className="auth-overlay">
        {!isPending ? (
          <div className="auth-card">
            <div className="auth-header">
              <h1>🚢 화물 업무 도구</h1>
              <p>팀원 전용 보안 포털</p>
            </div>

            <div className="auth-tabs">
              <button
                type="button"
                className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
                onClick={() => {
                  setMode('login');
                  setMessage({ text: '', type: '' });
                }}
              >
                로그인
              </button>
              <button
                type="button"
                className={`auth-tab ${mode === 'signup' ? 'active' : ''}`}
                onClick={() => {
                  setMode('signup');
                  setMessage({ text: '', type: '' });
                }}
              >
                회원가입
              </button>
            </div>

            <form onSubmit={handleAuth}>
              <div className="auth-form-group">
                <label>이메일 주소</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  required
                />
              </div>

              <div className="auth-form-group">
                <label>비밀번호</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="6자리 이상 비밀번호"
                  required
                />
              </div>

              {mode === 'signup' && (
                <div className="auth-form-group">
                  <label>비밀번호 확인</label>
                  <input
                    type="password"
                    value={passwordConfirm}
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                    placeholder="비밀번호 다시 입력"
                    required
                  />
                </div>
              )}

              <button type="submit" className="auth-btn" disabled={loading}>
                {loading
                  ? '처리 중...'
                  : mode === 'signup'
                  ? '회원가입 신청'
                  : '로그인'}
              </button>
            </form>

            {message.text && (
              <div className={`auth-msg ${message.type}`}>
                {message.text}
              </div>
            )}
          </div>
        ) : (
          <div className="auth-card">
            <div className="auth-header">
              <h1>⏳ 가입 승인 대기</h1>
              <p>관리자 승인 후 시스템 이용이 가능합니다.</p>
            </div>
            <div className="pending-box">
              <div className="pending-icon">🔐</div>
              <div style={{ fontSize: '13px', color: '#64748b' }}>신청 계정:</div>
              <div className="pending-email">{currentUserEmail || email}</div>
              <p className="pending-desc">
                회원가입 요청이 관리자에게 전달되었습니다.<br />
                관리자 승인 완료 후 아래 <strong>[승인 상태 확인]</strong>을 누르시면 바로 도구를 사용하실 수 있습니다.
              </p>
              <button
                type="button"
                className="auth-btn"
                onClick={handleCheckApproval}
                disabled={loading}
                style={{ marginBottom: '8px' }}
              >
                {loading ? '확인 중...' : '🔄 승인 상태 확인'}
              </button>
              <button
                type="button"
                className="auth-logout-btn"
                onClick={handleLogout}
              >
                다른 계정으로 로그인 (로그아웃)
              </button>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .auth-overlay {
          min-height: 100vh;
          width: 100vw;
          background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          box-sizing: border-box;
          font-family: 'Pretendard', sans-serif;
        }
        .auth-card {
          background: #ffffff;
          border-radius: 16px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
          width: 100%;
          max-width: 420px;
          padding: 36px 32px;
          box-sizing: border-box;
          animation: fadeIn 0.3s ease-out;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .auth-header {
          text-align: center;
          margin-bottom: 24px;
        }
        .auth-header h1 {
          margin: 0 0 8px 0;
          font-size: 24px;
          color: #1e293b;
          font-weight: 700;
        }
        .auth-header p {
          margin: 0;
          font-size: 14px;
          color: #64748b;
        }
        .auth-tabs {
          display: flex;
          background: #f1f5f9;
          border-radius: 8px;
          padding: 4px;
          margin-bottom: 20px;
        }
        .auth-tab {
          flex: 1;
          text-align: center;
          padding: 8px;
          font-size: 14px;
          font-weight: 600;
          color: #64748b;
          border-radius: 6px;
          cursor: pointer;
          border: none;
          background: transparent;
          transition: all 0.2s;
        }
        .auth-tab.active {
          background: #ffffff;
          color: #3949ab;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
        }
        .auth-form-group {
          margin-bottom: 16px;
        }
        .auth-form-group label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: #334155;
          margin-bottom: 6px;
        }
        .auth-form-group input {
          width: 100%;
          padding: 12px 14px;
          border: 1.5px solid #cbd5e1;
          border-radius: 8px;
          font-size: 14px;
          box-sizing: border-box;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .auth-form-group input:focus {
          border-color: #3949ab;
          box-shadow: 0 0 0 3px rgba(57, 73, 171, 0.15);
          outline: none;
        }
        .auth-btn {
          width: 100%;
          padding: 13px;
          background-color: #3949ab;
          color: #ffffff;
          border: none;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: background-color 0.2s, transform 0.1s;
          margin-top: 8px;
        }
        .auth-btn:hover {
          background-color: #303f9f;
        }
        .auth-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .auth-msg {
          margin-top: 14px;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 13px;
          line-height: 1.4;
        }
        .auth-msg.error {
          background: #fef2f2;
          border: 1px solid #fecaca;
          color: #dc2626;
        }
        .auth-msg.success {
          background: #f0fdf4;
          border: 1px solid #bbf7d0;
          color: #16a34a;
        }
        .auth-msg.info {
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          color: #2563eb;
        }
        .pending-box {
          text-align: center;
          padding: 10px 0;
        }
        .pending-icon {
          font-size: 48px;
          margin-bottom: 12px;
          display: inline-block;
          animation: pulse 2s infinite ease-in-out;
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        .pending-email {
          font-weight: 600;
          color: #3949ab;
          background: #eef2ff;
          padding: 4px 10px;
          border-radius: 6px;
          display: inline-block;
          margin: 8px 0 16px 0;
          font-size: 14px;
        }
        .pending-desc {
          font-size: 13px;
          color: #64748b;
          line-height: 1.6;
          margin-bottom: 20px;
        }
        .auth-logout-btn {
          width: 100%;
          padding: 10px;
          font-size: 13px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          background: #f8fafc;
          color: #475569;
          cursor: pointer;
          transition: all 0.2s;
          margin-top: 4px;
        }
        .auth-logout-btn:hover {
          background: #fee2e2;
          color: #dc2626;
          border-color: #fca5a5;
        }
      `}</style>
    </>
  );
}
