// 로컬 테스트 서버: Next.js(/dash 정적 파일, /api/auth/token, 화물도구 본문) + Supabase PostgREST(/rest/v1/rpc/*) 흉내.
// 사용: node serve.mjs [포트]   (먼저 setup.mjs 로 pgdata/ 를 만든다) → http://localhost:5179/dash/index.html , /tool
//   DASH_DB=pgex  : export.mjs 가 만든 수입+수출 DB 사용,  DASH_ADMIN=1 : 관리자로 로그인한 것처럼 (수출 데이터 올리기)
import { PGlite } from '@electric-sql/pglite';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = process.env.DASH_ROOT || path.resolve(HERE, '../..'); // 저장소 루트 (DASH_ROOT: 예전 화면 코드와 비교할 때)
const dir = path.join(HERE, process.env.DASH_DB || 'pgdata');
const PORT = Number(process.argv[2] || 5179);
const db = new PGlite(dir);
const CLAIMS = process.env.DASH_ADMIN
  ? { sub: '33333333-3333-3333-3333-333333333333', email: 'junhong2579@gmail.com', role: 'authenticated' }
  : { sub: '11111111-1111-1111-1111-111111111111', email: 'ok@test', role: 'authenticated' };

// PostgREST 의 표 upsert 흉내 (POST /rest/v1/export_records?on_conflict=bl_no). 권한은 DB 정책이 검사
async function upsertTable(table, rows) {
  if (!['export_records', 'freight_records'].includes(table)) { const e = new Error('table not found'); e.code = 'PGRST205'; e.status = 404; throw e; }
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(CLAIMS)]);
    await tx.exec('set local role authenticated');
    const cols = Object.keys(rows[0] || {}).filter((c) => /^[a-z0-9_]+$/.test(c));
    for (const r of rows) {
      await tx.query(`insert into public.${table} (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')})
        on conflict (bl_no) do update set ${cols.filter((c) => c !== 'bl_no').map((c) => `${c} = excluded.${c}`).join(', ')}`, cols.map((c) => r[c]));
    }
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp' };
let rpcLog = [];
// 로컬 시험 DB 에는 Supabase 의 freight_records 쓰기 정책이 없으므로 관리자 쓰기만 흉내 낸다 (데이터 올리기 · 수입)
await db.exec(`grant select, insert, update on public.freight_records to authenticated;
  drop policy if exists t_admin_rw on public.freight_records;
  create policy t_admin_rw on public.freight_records for all to authenticated
    using (coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false)) with check (coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false));`);

// 운임 필터 [운임 종류] 함수 (supabase/freight_filter_types.sql). 대시보드 변환 함수(dash_date 등)가 있는 DB 에서만
try { await db.exec(fs.readFileSync(path.join(TOOL, 'supabase/freight_filter_types.sql'), 'utf8')); } catch (e) { console.warn('freight_filter_types.sql 적용 안 됨:', e.message); }

// 화물 도구 운임 필터 [전체 기록] 흉내: GET /rest/v1/freight_records?select=*&<칸>=ilike.<패턴>&order=bl_no.desc&limit=500
async function selectFreight(params) {
  const where = [], args = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k) || !/^[a-z_]+$/.test(k)) continue;
    const m = /^ilike\.(.*)$/s.exec(v);
    if (!m) continue;
    args.push(m[1].replace(/\*/g, '%'));
    where.push(`${k}::text ilike $${args.length}`);
  }
  const ord = /^([a-z_]+)\.(asc|desc)$/.exec(params.get('order') || '');
  const lim = Math.min(Number(params.get('limit')) || 1000, 1000);
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(CLAIMS)]);
    await tx.exec('set local role authenticated');
    const r = await tx.query(`select * from public.freight_records ${where.length ? 'where ' + where.join(' and ') : ''}
      ${ord ? `order by ${ord[1]} ${ord[2]}` : ''} limit ${lim}`, args);
    return r.rows;
  });
}

async function rpc(fn, args) {
  if (!/^(dash_[a-z_]+|freight_filter_[a-z_]+)$/.test(fn)) { const e = new Error('Could not find the function'); e.code = 'PGRST202'; e.status = 404; throw e; }
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
    if (req.method === 'GET' && url.pathname === '/rest/v1/freight_records') {
      try { return send(200, await selectFreight(url.searchParams)); } catch (e) { return send(400, { message: e.message, code: e.code }); }
    }
    if (req.method === 'POST' && url.pathname.startsWith('/rest/v1/') && !url.pathname.startsWith('/rest/v1/rpc/')) {
      let body = ''; for await (const c of req) body += c;
      try {
        await upsertTable(url.pathname.slice('/rest/v1/'.length), JSON.parse(body));
        return send(201, '');
      } catch (e) {
        const rls = /row-level security|permission denied/.test(e.message);
        return send(e.status || (rls ? 403 : 400), { message: e.message, code: e.code || (rls ? '42501' : undefined) });
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
