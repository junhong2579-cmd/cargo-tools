import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// dashboard_rollback.sql → dashboard.sql 재적용을 검증한다 (원본 freight_records 가 바뀌지 않는지). 사용: node rollback.mjs
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../..'); // 저장소 루트
await fs.promises.rm(path.join(HERE, 'pgrb'), { recursive: true, force: true }); await fs.promises.cp(path.join(HERE, 'pgdata'), path.join(HERE, 'pgrb'), { recursive: true }); // Node 24 의 rmSync · cpSync 는 한글 경로에서 멈춤
const db = new PGlite(path.join(HERE, 'pgrb'));
const state = async (l) => {
  const q = async (s) => (await db.query(s)).rows[0];
  console.log(l, JSON.stringify({
    freight: (await q(`select count(*)::int n, count(weight)::int w, md5(string_agg(bl_no||coalesce(collect_ttl,''), ',' order by bl_no)) h from freight_records`)),
    dashTable: (await q(`select to_regclass('public.dash_rows') is not null as v`)).v,
    dashFns: (await q(`select count(*)::int n from pg_proc where proname like 'dash\_%'`)).n,
    triggers: (await q(`select count(*)::int n from pg_trigger where tgname like 'dash_rows%'`)).n,
  }));
};
await state('적용 상태   ');
await db.exec(fs.readFileSync(path.join(TOOL, 'supabase', 'dashboard_rollback.sql'), 'utf8'));
await state('되돌린 후   ');
await db.query(`insert into freight_records (bl_no, io_date) values ('TEST-AFTER-RB','5/1/26')`);  // 예전 도구처럼 업로드해도 오류 없음
await db.query(`delete from freight_records where bl_no='TEST-AFTER-RB'`);
await db.exec(fs.readFileSync(path.join(TOOL, 'supabase', 'dashboard.sql'), 'utf8'));
await state('다시 적용 후');
console.log('dash_rows', (await db.query('select count(*)::int n from dash_rows')).rows[0].n);
await db.close();
