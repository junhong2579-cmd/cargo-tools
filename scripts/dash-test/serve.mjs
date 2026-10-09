// 로컬 테스트 서버: Next.js(/dash 정적 파일, /api/auth/token, 화물도구 본문) + Supabase PostgREST(/rest/v1/rpc/*) 흉내.
// 사용: node serve.mjs [포트]   (먼저 setup.mjs 로 pgdata/ 를 만든다) → http://localhost:5179/dash/index.html , /tool
import { PGlite } from '@electric-sql/pglite';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../..'); // 저장소 루트
const dir = path.join(HERE, 'pgdata');
const PORT = Number(process.argv[2] || 5179);
const db = new PGlite(dir);
const CLAIMS = { sub: '11111111-1111-1111-1111-111111111111', email: 'ok@test', role: 'authenticated' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp' };
let rpcLog = [];

async function rpc(fn, args) {
  if (!/^dash_[a-z]+$/.test(fn)) { const e = new Error('Could not find the function'); e.code = 'PGRST202'; e.status = 404; throw e; }
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(CLAIMS)]);
    await tx.exec('set local role authenticated');
    const names = Object.keys(args);
    const r = await tx.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::jsonb`).join(', ')}) as v`, names.map((n) => JSON.stringify(args[n])));
    return r.rows[0].v;
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  try {
    if (req.method === 'OPTIONS') return send(204, '');
    if (url.pathname === '/api/auth/token') {
      return send(200, { ok: true, url: `http://localhost:${PORT}`, anonKey: 'anon', accessToken: 'test-token', expiresAt: Math.floor(Date.now() / 1000) + 3600, email: CLAIMS.email });
    }
    if (url.pathname === '/__rpclog') { const l = rpcLog; rpcLog = []; return send(200, l); }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      let body = ''; for await (const c of req) body += c;
      const fn = url.pathname.slice('/rest/v1/rpc/'.length);
      const t0 = Date.now();
      try {
        const v = await rpc(fn, body ? JSON.parse(body) : {});
        rpcLog.push({ fn, ms: Date.now() - t0, bytes: JSON.stringify(v).length });
        return send(200, v);
      } catch (e) {
        return send(e.status || (e.code === '42501' ? 403 : 400), { message: e.message, code: e.code });
      }
    }
    if (url.pathname === '/' || url.pathname === '/tool') { // 화물 도구 본문 (서버 주입 흉내)
      const html = fs.readFileSync(TOOL + '/private/cargo-tool.html', 'utf8').replace('__USER_EMAIL__', 'junhong2579@gmail.com').replace('__SERVER_SESSION_TOKENS__', 'null');
      return send(200, html, TYPES['.html']);
    }
    const file = path.join(TOOL, 'public', decodeURIComponent(url.pathname));
    if (file.startsWith(path.join(TOOL, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    }
    send(404, { message: 'not found' });
  } catch (e) {
    send(500, { message: e.message });
  }
}).listen(PORT, () => console.log(`listening http://localhost:${PORT} (db ${dir})`));
