// 운임 기록 표(freight_records) 보안 규칙 검증 (실제 Supabase 를 건드리지 않음)
// 사용: node rls_freight.mjs   (먼저 setup.mjs 로 pgdata/ 를 만든다. pgdata 는 복사본으로만 씀)
// 바꾸기 전(rollback 파일 = 운영 원문) → 바꾼 뒤(freight_records_rls.sql, 두 번 실행) → 되돌리기 순서로
// 사용자 종류별 읽기 · 저장 · 고치기 · 지우기 결과와 운임 필터 · 운임 체크 함수 결과를 비교한다. 모든 동작은 취소(rollback)한다.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../..');
const DIR = path.join(os.tmpdir(), 'rls_freight_pg');
await fs.promises.rm(DIR, { recursive: true, force: true });
await fs.promises.cp(path.join(HERE, 'pgdata'), DIR, { recursive: true });
const db = new PGlite(DIR);
const sql = (f) => fs.readFileSync(path.join(TOOL, 'supabase', f), 'utf8');

await db.exec(`
  create or replace function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt() ->> 'role', 'anon') $$;
  grant execute on function auth.role() to anon, authenticated;
  grant select, insert, update, delete on public.freight_records to anon, authenticated;
  grant select on public.profiles to anon, authenticated;
  insert into public.profiles values ('44444444-4444-4444-4444-444444444444', 'admin@test', true, true) on conflict do nothing;
  drop policy if exists t_admin_rw on public.freight_records; -- 시험 도구가 만든 규칙 (운영에는 없음)
`);
await db.exec(sql('freight_filter_types.sql')); // 운영과 같게 운임 필터 · 운임 체크 함수 준비
await db.exec(sql('freight_check_past.sql'));
const USERS = {
  '승인 직원': { sub: '11111111-1111-1111-1111-111111111111', email: 'ok@test', role: 'authenticated' },
  '승인 대기': { sub: '22222222-2222-2222-2222-222222222222', email: 'wait@test', role: 'authenticated' },
  '관리자(is_admin)': { sub: '44444444-4444-4444-4444-444444444444', email: 'admin@test', role: 'authenticated' },
  '관리자 이메일(profiles 없음)': { sub: '33333333-3333-3333-3333-333333333333', email: 'junhong2579@gmail.com', role: 'authenticated' },
  '로그인 안 함(anon)': null,
};
const sample = (await db.query(`select bl_no, consignee from public.freight_records where consignee <> '' order by bl_no limit 1`)).rows[0];

async function as(claims, fn) {
  let out;
  try {
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims ? JSON.stringify(claims) : '']);
      await tx.exec(`set local role ${claims ? 'authenticated' : 'anon'}`);
      out = await fn(tx);
      await tx.rollback();
    });
  } catch (e) { if (out === undefined) out = 'ERR ' + e.message.slice(0, 40); }
  return out;
}
const tryRows = async (tx, q) => { try { await tx.exec('savepoint s'); const r = await tx.query(q); return r.affectedRows ?? r.rows.length; } catch (e) { await tx.exec('rollback to savepoint s'); return /row-level security|permission/.test(e.message) ? '거부' : 'ERR ' + e.message.slice(0, 30); } };

async function matrix() {
  const res = {};
  for (const [name, c] of Object.entries(USERS)) {
    res[name] = await as(c, async (tx) => ({
      읽기: (await tx.query('select count(*)::int n from public.freight_records')).rows[0].n,
      저장: await tryRows(tx, `insert into public.freight_records (bl_no, io_date) values ('TESTRLS9999E0001', '11/16/26')`),
      고치기: await tryRows(tx, `update public.freight_records set remark = remark where bl_no = '${sample.bl_no}'`),
      지우기: await tryRows(tx, `delete from public.freight_records where bl_no = '${sample.bl_no}'`),
    }));
  }
  // 승인 직원이 쓰는 함수: 운임 필터 [운임 종류] · 운임 체크 과거 기록
  res['함수(승인 직원)'] = await as(USERS['승인 직원'], async (tx) => {
    const t = (await tx.query(`select public.freight_filter_types($1::jsonb) v`, [JSON.stringify({ col: 'consignee', q: sample.consignee.slice(0, 3) })])).rows[0].v;
    const p = (await tx.query(`select public.get_past_freight_since($1::text[], '2026-04-01'::date, '{}'::date[]) v`, [[sample.consignee]])).rows[0].v;
    return { 운임종류_결과: JSON.stringify(t).length, 운임체크_결과: JSON.stringify(p).length };
  });
  return res;
}
const show = (label, m) => { console.log(`\n[${label}]`); for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(16)} ${JSON.stringify(v)}`); };
const policies = async () => (await db.query(`select string_agg(policyname, ', ' order by policyname) v from pg_policies where tablename = 'freight_records'`)).rows[0].v;

await db.exec(sql('freight_records_rls_rollback.sql'));
const before = await matrix(); show('바꾸기 전 (운영 원문 규칙) ' + await policies(), before);
await db.exec(sql('freight_records_rls.sql'));
await db.exec(sql('freight_records_rls.sql')); // 두 번 실행해도 안전한지
const after = await matrix(); show('바꾼 뒤 ' + await policies(), after);
await db.exec(sql('freight_records_rls_rollback.sql'));
const back = await matrix(); show('되돌린 뒤 ' + await policies(), back);

let fails = 0;
const check = (label, ok) => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`); };
const N = before['관리자(is_admin)'].읽기;
console.log('');
check('승인 직원: 읽기 · 함수 결과가 바꾸기 전과 같음', JSON.stringify(after['승인 직원'].읽기) === JSON.stringify(before['승인 직원'].읽기) && JSON.stringify(after['함수(승인 직원)']) === JSON.stringify(before['함수(승인 직원)']));
check('승인 직원: 저장 · 고치기 · 지우기 거부(화면에서 원래 못 쓰는 기능)', after['승인 직원'].저장 === '거부' && after['승인 직원'].고치기 === 0 && after['승인 직원'].지우기 === 0);
check('승인 대기: 읽기 0건 · 저장 거부 · 고치기/지우기 0건', after['승인 대기'].읽기 === 0 && after['승인 대기'].저장 === '거부' && after['승인 대기'].고치기 === 0 && after['승인 대기'].지우기 === 0);
for (const a of ['관리자(is_admin)', '관리자 이메일(profiles 없음)'])
  check(`${a}: 바꾸기 전과 똑같이 모두 가능`, JSON.stringify(after[a]) === JSON.stringify(before[a]) && after[a].읽기 === N && after[a].저장 === 1);
check('로그인 안 함: 읽기 0건', after['로그인 안 함(anon)'].읽기 === 0);
check('되돌리기 = 바꾸기 전과 완전히 같음', JSON.stringify(back) === JSON.stringify(before));
const total = (await db.query('select count(*)::int n from public.freight_records')).rows[0].n;
check(`데이터 건수 그대로 (${total}건)`, total === N);
await db.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
