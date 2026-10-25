// 운임 필터 [운임 종류] 검증 (실제 Supabase 를 건드리지 않음, 메모리 DB)
// 사용: node freight_types.mjs ["<수입엑셀 또는 폴더>" ...]   (없으면 ../../평택데이터 와 그 2025 폴더의 수입 엑셀 전체)
//   1) 서버 freight_type_key 와 화면 freightTypeKey(cargo-tool.html) 가 모든 B/L 을 똑같이 묶는지
//   2) freight_filter_types 결과 = 검색된 B/L 을 모두 받아 화면 기준으로 합친 결과 (운임 종류 수 · 건수 · 처음/최근 입항일 · 대표 B/L · 순서 = 건수 많은 순)
//   3) freight_filter_type_bls 의 B/L 목록 = 그 운임 종류의 B/L 전체
//   4) 권한(RLS · anon 차단) · 잘못된 검색 칸 거부 · 500종류 제한 · 되돌리기
import { PGlite } from '@electric-sql/pglite';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../..');
const read = (f) => fs.readFileSync(path.join(TOOL, 'supabase', f), 'utf8');
let fails = 0;
const check = (name, ok, info = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };

// ── 엑셀 → freight_records (대시보드 [데이터 올리기] 수입 = 화물 도구 [클라우드 동기화] 와 같은 변환) ──
const ctx = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(fs.readFileSync(path.join(TOOL, 'public/dash/upload.js'), 'utf8'), ctx);
const { toFreightItems, toFreightRecords } = ctx.window.DashUpload;
const args = process.argv.slice(2);
const roots = args.length ? args : [path.join(TOOL, '평택데이터'), path.join(TOOL, '평택데이터', '2025')];
const files = roots.flatMap((p) => (fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter((f) => f.endsWith('.xlsx') && !f.includes('수출') && !f.startsWith('ITEM_') && !f.includes('ACT')).map((f) => path.join(p, f))
  : [p]));
let recs = [];
for (const f of files) {
  const wb = XLSX.read(fs.readFileSync(f), { type: 'buffer' });
  recs = recs.concat(toFreightRecords(toFreightItems(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' })), 'test'));
}
recs = [...new Map(recs.filter((r) => !/\dW\d{4}$/.test(r.bl_no)).map((r) => [r.bl_no, r])).values()];
console.log(`엑셀 ${files.length}개 → 수입 B/L ${recs.length}건`);

// ── 메모리 DB: Supabase 흉내 (setup.mjs 와 같은 역할 · 권한) ──
const db = new PGlite();
const cols = Object.keys(recs[0]).filter((c) => c !== 'updated_at');
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  create table public.freight_records (id bigserial, ${cols.map((c) => `${c} text`).join(', ')}, updated_at timestamptz);
  alter table public.freight_records add primary key (bl_no);
  alter table public.freight_records enable row level security;
  grant select on public.freight_records to authenticated;
  create policy approved_read on public.freight_records for select to authenticated using (auth.jwt() ->> 'email' = 'ok@test');
`);
// dashboard.sql 의 2) 문자열 → 값 변환 함수만 (dash_text · dash_num · dash_date)
const dash = read('dashboard.sql');
await db.exec(dash.slice(dash.indexOf('create or replace function public.dash_text'), dash.indexOf('-- 3) 대시보드 전용 정규화 테이블')));
for (let i = 0; i < recs.length; i += 500) {
  const chunk = recs.slice(i, i + 500); const params = [];
  const values = chunk.map((r) => '(' + cols.map((c) => { params.push(r[c] ?? null); return '$' + params.length; }).join(',') + ')').join(',');
  await db.query(`insert into public.freight_records (${cols.join(',')}) values ${values}`, params);
}
await db.exec(read('freight_filter_types.sql'));
await db.exec(read('freight_filter_types.sql')); // 두 번 실행해도 안전
check('freight_filter_types.sql 두 번 실행', true);

const as = (email, fn) => db.transaction(async (tx) => {
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(email ? { email, role: 'authenticated' } : {})]);
  await tx.exec(`set local role ${email ? 'authenticated' : 'anon'}`);
  return fn(tx);
});
const rpc = (email, fn, p) => as(email, (tx) => tx.query(`select public.${fn}($1::jsonb) v`, [JSON.stringify(p)]).then((r) => r.rows[0].v));

// ── 화면 코드에서 함수 꺼내기 (cargo-tool.html 의 실제 코드) ──
const html = fs.readFileSync(path.join(TOOL, 'private/cargo-tool.html'), 'utf8').replace(/\r\n/g, '\n');
function fnSource(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`cargo-tool.html 에 ${name} 이 없음`);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
  return html.slice(start, i + 1);
}
const { mapFreightDbToClient, freightTypeKey } = new Function(`${fnSource('mapFreightDbToClient')}\n${fnSource('freightTypeKey')}\nreturn { mapFreightDbToClient, freightTypeKey };`)();
const COLMAP = new Function(`${html.slice(html.indexOf('const FREIGHT_FILTER_TO_DB_COL'), html.indexOf('};', html.indexOf('const FREIGHT_FILTER_TO_DB_COL')) + 2)}\nreturn FREIGHT_FILTER_TO_DB_COL;`)();
const jsKey = (row) => freightTypeKey(mapFreightDbToClient(row));

// ── 1) 기준이 같은지: 모든 B/L 에서 서버 키 ↔ 화면 키가 1:1 ──
const all = (await db.query(`select f.*, public.freight_type_key(f) as k from public.freight_records f`)).rows;
const s2j = new Map(), j2s = new Map();
for (const r of all) {
  const j = jsKey(r);
  (s2j.get(r.k) || s2j.set(r.k, new Set()).get(r.k)).add(j);
  (j2s.get(j) || j2s.set(j, new Set()).get(j)).add(r.k);
}
const bad1 = [...s2j.values()].filter((s) => s.size > 1).length + [...j2s.values()].filter((s) => s.size > 1).length;
check('서버 기준 = 화면 기준 (모든 B/L)', bad1 === 0 && s2j.size === j2s.size, `B/L ${all.length}건 → 운임 종류 ${s2j.size}개, 어긋남 ${bad1}`);

// ── 2) · 3) 검색별 비교 ──
const top = async (col, n) => (await db.query(`select ${col} v, count(*) c from public.freight_records where coalesce(${col}, '') <> '' group by 1 order by 2 desc limit ${n}`)).rows.map((r) => r.v);
const names = await top('consignee', 4), codes = await top('consignee_code', 2), shippers = await top('actual_shipper', 2), voys = await top('voyage', 2);
const searches = [
  ...names.map((v) => ['consignee', v]), ['consignee', names[0].slice(0, 4)], ['consignee', '주식회사'], ['consignee', '(주)'], ['consignee', 'logis'],
  ...codes.map((v) => ['consignee_code', v]), ['consignee_code', codes[0].slice(0, 6)],
  ['actual_shipper', shippers[0]], ['actual_shipper', shippers[1].slice(0, 5)],
  ['item', 'RA'], ['item', 'GE'], ['item', 'EL'], ['description', 'WIRE'], ['description', 'box'], ['notify', '현대'], ['remark', '선어'],
  ['bl_no', 'E12'], ['voyage', voys[0]], ['io_date', '9/'], ['shipper', 'CO'], ['a_shipper_code', '9'],
];
const froms = ['', '2026-04-01', '2026-08-15'];
let compared = 0, bigTypes = null, expandChecked = 0, maxMs = 0, searchBad = 0, expandBad = 0;
const cmpRow = (a, b) => (a.d === b.d ? (a.bl_no < b.bl_no ? 1 : a.bl_no > b.bl_no ? -1 : 0) : a.d == null ? 1 : b.d == null ? -1 : a.d < b.d ? 1 : -1);
for (const [col, q] of searches) {
  for (const from of froms) {
    const t0 = Date.now();
    const res = await rpc('ok@test', 'freight_filter_types', { col, q, from, limit: 2000 });
    maxMs = Math.max(maxMs, Date.now() - t0);
    // 기준: 검색된 B/L 을 모두 받아 화면 기준으로 합침 (최근 = 입항일 → B/L 번호 큰 순)
    const raw = (await db.query(`select f.*, public.dash_date(f.io_date::text)::text as d from public.freight_records f
      where f.${col}::text ilike $1 and ($2::date is null or public.dash_date(f.io_date::text) >= $2)`, ['%' + q + '%', from || null])).rows;
    const groups = new Map();
    for (const r of raw.sort(cmpRow)) {
      const k = jsKey(r), g = groups.get(k);
      if (!g) groups.set(k, { rep: r, n: 1, first: r.d, last: r.d, bls: [r.bl_no] });
      else { g.n++; g.bls.push(r.bl_no); if (r.d && (!g.first || r.d < g.first)) g.first = r.d; if (r.d && (!g.last || r.d > g.last)) g.last = r.d; }
    }
    const want = [...groups.values()].sort((a, b) => (b.n - a.n) || cmpRow(a.rep, b.rep)); // 같은 운임 건수 많은 순 → 최근 입항 순
    const got = res.rows;
    const diffs = [];
    if (res.total !== raw.length) diffs.push(`total ${res.total}≠${raw.length}`);
    if (res.types !== want.length || got.length !== Math.min(want.length, 2000)) diffs.push(`types ${res.types}/${got.length}≠${want.length}`); // 최대 2,000종류 (서버 상한)
    got.forEach((g, i) => {
      const w = want[i];
      if (!w) return;
      if (g.bl_no !== w.rep.bl_no) diffs.push(`#${i} 대표 ${g.bl_no}≠${w.rep.bl_no}`);
      if (g.same_count !== w.n) diffs.push(`#${i} 건수 ${g.same_count}≠${w.n}`);
      if ((g.first_date ?? null) !== (w.first ?? null) || (g.last_date ?? null) !== (w.last ?? null)) diffs.push(`#${i} 기간 ${g.first_date}~${g.last_date}≠${w.first}~${w.last}`);
      if (jsKey(g) !== jsKey(w.rep)) diffs.push(`#${i} 운임 칸이 다름`);
    });
    if (diffs.length) searchBad++;
    if (diffs.length) check(`검색 ${col}="${q}" ${from || '전체 기간'}`, false, diffs.slice(0, 5).join(', '));
    compared++;
    if (!bigTypes || want.length > bigTypes.n) bigTypes = { col, q, from, n: want.length, want };
    // B/L 목록 펼치기: 건수가 많은 것 · 1건 · 중간을 골라 확인
    if (from === froms[1]) {
      const pick = [...want].sort((a, b) => b.n - a.n);
      for (const w of [pick[0], pick[Math.floor(pick.length / 2)], pick[pick.length - 1]].filter(Boolean)) {
        const d = await rpc('ok@test', 'freight_filter_type_bls', { col, q, from, bl: w.rep.bl_no });
        const okList = d.total === w.n && d.rows.length === Math.min(w.n, 1000) && d.rows.every((r) => w.bls.includes(r.bl_no))
          && d.rows.map((r) => r.bl_no).join() === w.bls.slice(0, 1000).join();
        if (!okList) expandBad++;
        if (!okList) check(`B/L 목록 ${col}="${q}" ${w.rep.bl_no}`, false, `서버 ${d.total}건 / 기준 ${w.n}건`);
        expandChecked++;
      }
    }
  }
}
check('검색 결과 = 모두 받아 합친 결과', searchBad === 0 && compared > 0, `검색 ${searches.length}개 × 기간 ${froms.length}가지 = ${compared}회, 가장 오래 걸린 검색 ${maxMs}ms`);
check('B/L 목록 펼치기 = 그 운임의 B/L 전체 (최근 입항 순)', expandBad === 0 && expandChecked > 0, `${expandChecked}개 확인`);

// 500종류 제한 (기본값): 가장 최근 500종류
if (bigTypes && bigTypes.n > 500) {
  const r = await rpc('ok@test', 'freight_filter_types', { col: bigTypes.col, q: bigTypes.q, from: bigTypes.from });
  check('기본 500종류까지 · 많이 적용된 것', r.rows.length === 500 && r.types === bigTypes.n
    && r.rows.map((x) => x.bl_no).join() === bigTypes.want.slice(0, 500).map((w) => w.rep.bl_no).join(), `${bigTypes.col}="${bigTypes.q}" 운임 종류 ${bigTypes.n}개`);
}

// ── 4) 권한 · 입력 검사 ──
const other = await rpc('wait@test', 'freight_filter_types', { col: 'consignee', q: '주식회사' });
check('승인 안 된 사용자는 RLS 로 0건', other.total === 0 && other.rows.length === 0);
check('로그인 안 한 사용자(anon)는 실행 불가', await rpc(null, 'freight_filter_types', { col: 'consignee', q: 'a' }).then(() => false, () => true));
check('잘못된 검색 칸 거부', await rpc('ok@test', 'freight_filter_types', { col: 'bl_no; drop table x', q: 'a' }).then(() => false, () => true));
check('화면 검색 칸 목록 = 서버가 받는 칸', (await Promise.all(Object.values(COLMAP).map((c) => rpc('ok@test', 'freight_filter_types', { col: c, q: 'zzzz' }).then(() => true, () => false)))).every(Boolean), Object.values(COLMAP).join(', '));
const empty = await rpc('ok@test', 'freight_filter_types', { col: 'consignee', q: '  ' });
check('빈 검색어는 결과 없음', empty.rows.length === 0 && empty.total === 0);
check('B/L 목록: 없는 B/L 은 빈 목록', (await rpc('ok@test', 'freight_filter_type_bls', { col: 'consignee', q: 'a', bl: 'NONE' })).rows.length === 0);

// 받는 양 비교 (전체 기록 = 최대 500건 select *, 운임 종류 = 합친 결과)
const sizeOf = (v) => Buffer.byteLength(JSON.stringify(v));
const sample = names[0];
const allRows = (await db.query(`select * from public.freight_records where consignee ilike $1 order by bl_no desc limit 500`, ['%' + sample + '%'])).rows;
const typesRes = await rpc('ok@test', 'freight_filter_types', { col: 'consignee', q: sample });
console.log(`받는 양 예시 (B/L 가장 많은 업체): 전체 기록 ${allRows.length}건 ${(sizeOf(allRows) / 1024).toFixed(0)}KB → 운임 종류 ${typesRes.rows.length}개 ${(sizeOf(typesRes) / 1024).toFixed(1)}KB (B/L ${typesRes.total}건 대표)`);

// ── 되돌리기 (SQL 머리말의 drop 3줄) ──
const drops = read('freight_filter_types.sql').split('\n').filter((l) => /^--\s+drop function if exists public\.freight_/.test(l)).map((l) => l.replace(/^--\s+/, ''));
await db.exec(drops.join('\n'));
const left = (await db.query(`select count(*)::int n from pg_proc where proname like 'freight_filter%' or proname = 'freight_type_key'`)).rows[0].n;
const kept = (await db.query(`select count(*)::int n from public.freight_records`)).rows[0].n;
check('되돌리기: 함수 3개만 지워지고 운임 기록은 그대로', drops.length === 3 && left === 0 && kept === recs.length, `drop ${drops.length}줄, 남은 함수 ${left}, 운임 ${kept}건`);

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
