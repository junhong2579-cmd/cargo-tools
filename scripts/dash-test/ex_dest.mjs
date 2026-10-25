// 특송 도착지(평택 · ACT자가 · 부산 · 인천) 검증 (실제 Supabase 를 건드리지 않음, 메모리 DB)
// 사용: node ex_dest.mjs ["<ACT 자가 장치장 목록.xlsx>"] ["<수입엑셀 또는 폴더>" ...]
//   (없으면 ../../평택데이터/ACT자가장치장 취합.xlsx 와 ../../평택데이터 · 2025 폴더의 수입 엑셀 전체)
//   1) 도착지 규칙 = 엑셀로 직접 계산한 값 (REMARK 인천 · 부산 > ACT 목록 > 평택, 특송 아니면 없음)
//   2) 평택 + ACT자가 + 부산 + 인천 = 특송 TEU (합계 · 월 · 항차 · 조건)
//   3) 목록 바꾸기 권한(관리자만) · 통째로 바꾸기(빠진 B/L 은 평택으로) · 빈 목록 거부 · 운임 재동기화 뒤에도 유지
//   4) dashboard.sql 두 번 실행 · 되돌리기(dashboard_rollback.sql) 뒤 재적용
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

const ctx = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(fs.readFileSync(path.join(TOOL, 'public/dash/upload.js'), 'utf8'), ctx);
const { toFreightItems, toFreightRecords, detectKind, parseActList } = ctx.window.DashUpload;

const args = process.argv.slice(2);
const ACT_XLSX = args[0] || path.join(TOOL, '평택데이터', 'ACT자가장치장 취합.xlsx');
const roots = args.length > 1 ? args.slice(1) : [path.join(TOOL, '평택데이터'), path.join(TOOL, '평택데이터', '2025')];
const files = roots.flatMap((p) => (fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter((f) => f.endsWith('.xlsx') && !f.includes('수출') && !f.startsWith('ITEM_') && !f.includes('ACT')).map((f) => path.join(p, f))
  : [p]));
const sheet = (f) => { const wb = XLSX.read(fs.readFileSync(f), { type: 'buffer' }); return wb.Sheets[wb.SheetNames[0]]; };
let recs = [];
for (const f of files) recs = recs.concat(toFreightRecords(toFreightItems(XLSX.utils.sheet_to_json(sheet(f), { raw: false, defval: '' })), 'test'));
recs = [...new Map(recs.filter((r) => !/\dW\d{4}$/.test(r.bl_no)).map((r) => [r.bl_no, r])).values()];

// ACT 목록: 화면(upload.js)과 같은 코드로 읽기
const actAoa = XLSX.utils.sheet_to_json(sheet(ACT_XLSX), { header: 1, raw: false, defval: '' });
const act = parseActList(actAoa);
check('ACT 목록 = 운임 엑셀로 보지 않음 (B/L NO 머리글 없음)', detectKind(actAoa) === null);
check('ACT 목록 읽기', act && act.bls.length > 0, `B/L ${act?.bls.length}건 · 뺀 칸 ${act?.skipped} · 중복 ${act?.dup}`);
console.log(`엑셀 ${files.length}개 → 수입 B/L ${recs.length}건, ACT 목록 ${act.bls.length}건`);

// ── 메모리 DB (setup.mjs 와 같은 Supabase 흉내) ──
const db = new PGlite();
const cols = Object.keys(recs[0]);
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  create table public.profiles (id uuid primary key, email text, is_approved boolean default false, is_admin boolean default false);
  insert into public.profiles values ('11111111-1111-1111-1111-111111111111', 'ok@test', true, false);
  create table public.freight_records (${cols.map((c) => `${c} ${c === 'updated_at' ? 'timestamptz' : 'text'}`).join(', ')});
  alter table public.freight_records add primary key (bl_no);
  alter table public.freight_records enable row level security;
`);
async function upsert(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500); const params = [];
    const values = chunk.map((r) => '(' + cols.map((c) => { params.push(r[c] ?? null); return '$' + params.length; }).join(',') + ')').join(',');
    await db.query(`insert into public.freight_records (${cols.join(',')}) values ${values}
      on conflict (bl_no) do update set ${cols.filter((c) => c !== 'bl_no').map((c) => `${c} = excluded.${c}`).join(', ')}`, params);
  }
}
await upsert(recs);
await db.exec(read('dashboard.sql'));
await db.exec(read('dashboard.sql'));
check('dashboard.sql 두 번 실행', true);

const APPROVED = { sub: '11111111-1111-1111-1111-111111111111', email: 'ok@test', role: 'authenticated' };
const ADMIN = { sub: '33333333-3333-3333-3333-333333333333', email: 'junhong2579@gmail.com', role: 'authenticated' };
const as = (claims, fn) => db.transaction(async (tx) => {
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  await tx.exec('set local role authenticated');
  return fn(tx);
});
const rpc = (claims, fn, p) => as(claims, (tx) => tx.query(`select public.${fn}(${p === undefined ? '' : '$1::jsonb'}) v`, p === undefined ? [] : [JSON.stringify(p)]).then((r) => r.rows[0].v));
const replace = (claims, bls) => rpc(claims, 'dash_ex_act_replace', bls);

// ── 기대값: 엑셀 값으로 직접 계산 ──
const num = (v) => Number(String(v ?? '').replace(/,/g, '')) || 0;
const teuOf = (r) => (String(r.bt).trim().toUpperCase() === 'E' ? 0 : num(r.twenty) + 2 * num(r.forty) + 2 * num(r.forty_five));
function expected(list) {
  const set = new Set(list);
  const m = new Map();
  for (const r of recs) {
    const x = String(r.bt).trim().toUpperCase() === 'X';
    const rm = String(r.remark || '');
    m.set(r.bl_no, !x ? null : rm.includes('인천') ? 'I' : rm.includes('부산') ? 'B' : set.has(r.bl_no) ? 'A' : 'P');
  }
  return m;
}
async function compare(label, list) {
  const exp = expected(list);
  const got = new Map((await db.query(`select bl, exd from public.dash_rows where dir = 'IN'`)).rows.map((r) => [r.bl, r.exd]));
  const bad = [...exp].filter(([bl, v]) => got.get(bl) !== v);
  const cnt = {}; for (const v of exp.values()) if (v) cnt[v] = (cnt[v] || 0) + 1;
  check(`${label}: 도착지 = 엑셀로 계산한 값`, bad.length === 0 && got.size === exp.size, `평택 ${cnt.P || 0} · ACT자가 ${cnt.A || 0} · 부산 ${cnt.B || 0} · 인천 ${cnt.I || 0}건${bad.length ? `, 다름 ${bad.length} (예: ${bad.slice(0, 3).map(([b, v]) => `${b} ${v}≠${got.get(b)}`).join(', ')})` : ''}`);
  return cnt;
}
async function sums(label, f = {}) {
  const S = await rpc(APPROVED, 'dash_summary', f);
  const t = S.totals, i = (k) => S.fields.indexOf(k);
  const part = (o) => o.exP + o.exA + o.exB + o.exI;
  let bad = 0;
  for (const dim of ['month', 'voyage', 'consignee']) {
    for (const a of S.groups[dim] || []) if (a[i('exP')] + a[i('exA')] + a[i('exB')] + a[i('exI')] !== a[i('exTeu')]) bad++;
  }
  const blOk = t.exPBl + t.exABl + t.exBBl + t.exIBl === t.ex;
  check(`${label}: 평택 + ACT자가 + 부산 + 인천 = 특송 (합계 · 월 · 항차 · 업체)`, part(t) === t.exTeu && blOk && bad === 0,
    `TEU 평택 ${t.exP} · ACT자가 ${t.exA} · 부산 ${t.exB} · 인천 ${t.exI} = ${t.exTeu}, B/L ${t.ex}건${bad ? `, 어긋난 묶음 ${bad}` : ''}`);
  return t;
}

// 1) 목록 없음 → ACT 자가 0, 나머지 평택
await compare('목록 없음', []);
let t0 = await sums('목록 없음');
check('목록 없음: ACT자가 0', t0.exA === 0 && t0.exABl === 0);
check('dash_meta.exAct (목록 없음)', (await rpc(APPROVED, 'dash_meta')).exAct.rows === 0);

// 2) 권한: 승인 사용자는 바꿀 수 없음 · 직접 쓰기 막힘
let denied = false;
try { await replace(APPROVED, act.bls); } catch (e) { denied = e.code === '42501'; }
check('승인 사용자 목록 바꾸기 거부', denied);
denied = false;
try { await as(APPROVED, (tx) => tx.query(`insert into public.ex_act_bl (bl_no) values ('X')`)); } catch (e) { denied = /permission denied|row-level/.test(e.message); }
check('승인 사용자 표 직접 쓰기 거부', denied);
denied = false;
try { await as(APPROVED, (tx) => tx.query(`select public.dash_ex_dest('X', '', 'A')`)); } catch (e) { denied = /permission denied/.test(e.message); }
check('dash_ex_dest 직접 호출 거부', denied);

// 3) 관리자 올리기
const r1 = await replace(ADMIN, act.bls);
const inData = new Set(recs.map((r) => r.bl_no));
const xBls = new Set(recs.filter((r) => String(r.bt).trim().toUpperCase() === 'X').map((r) => r.bl_no));
check('올리기 결과 숫자', r1.before === 0 && r1.rows === act.bls.length
  && r1.matched === act.bls.filter((b) => xBls.has(b)).length
  && r1.missing === act.bls.filter((b) => !inData.has(b)).length
  && r1.notEx === act.bls.filter((b) => inData.has(b) && !xBls.has(b)).length, JSON.stringify(r1));
const c1 = await compare('목록 올림', act.bls);
const t1 = await sums('목록 올림');
check('목록 올림: 특송 합계는 그대로', t1.exTeu === t0.exTeu && t1.ex === t0.ex);
check('목록 올림: ACT자가 TEU > 0', t1.exA > 0, `${t1.exA} TEU · ${c1.A}건`);
const meta = await rpc(APPROVED, 'dash_meta');
check('dash_meta.exAct', meta.exAct.rows === act.bls.length && !!meta.exAct.updatedAt, JSON.stringify(meta.exAct));
await sums('목록 올림 · 2026-03 · 특송만', { from: '2026-03-01', to: '2026-03-31', ex: '1' });

// 4) REMARK 우선: 목록에 인천 B/L 을 넣어도 인천
const inch = recs.find((r) => String(r.bt).trim().toUpperCase() === 'X' && String(r.remark).includes('인천'));
if (inch) {
  await replace(ADMIN, [...act.bls, inch.bl_no]);
  check('REMARK 인천이 ACT 목록보다 우선', (await db.query(`select exd from public.dash_rows where bl = $1`, [inch.bl_no])).rows[0].exd === 'I', inch.bl_no);
}

// 5) 운임 데이터 다시 올려도(트리거) ACT자가 유지
await replace(ADMIN, act.bls);
const sample = recs.filter((r) => act.bls.includes(r.bl_no)).slice(0, 50);
await upsert(sample.map((r) => ({ ...r, updated_at: new Date().toISOString() })));
await compare('운임 재동기화 뒤', act.bls);

// 6) 통째로 바꾸기: 작은 목록 → 빠진 B/L 은 평택
const small = act.bls.slice(0, 10);
const r2 = await replace(ADMIN, small);
check('작은 목록으로 바꾸기 (before = 이전 건수)', r2.before === act.bls.length && r2.rows === small.length, JSON.stringify(r2));
await compare('작은 목록', small);
check('같은 B/L 여러 번 · 소문자 · 빈 칸 정리', (await replace(ADMIN, [small[0], small[0].toLowerCase(), ' ', small[1]])).rows === 2);

// 7) 빈 목록은 거부하고 이전 목록 유지
let empty = false;
try { await replace(ADMIN, ['', ' ']); } catch (e) { empty = /올릴 B\/L 이 없습니다/.test(e.message); }
check('빈 목록 거부 · 이전 목록 그대로', empty && (await db.query(`select count(*)::int n from public.ex_act_bl`)).rows[0].n === 2);

// 8) 되돌리기 → 재적용 (목록 데이터는 남음)
await replace(ADMIN, act.bls);
await db.exec(read('dashboard_rollback.sql'));
check('되돌리기: dash 함수 없음 · ACT 목록 데이터 남음',
  (await db.query(`select count(*)::int n from pg_proc where proname like 'dash%'`)).rows[0].n === 0
  && (await db.query(`select count(*)::int n from public.ex_act_bl`)).rows[0].n === act.bls.length);
await db.exec(read('dashboard.sql'));
await compare('되돌리기 뒤 재적용', act.bls);

await db.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
