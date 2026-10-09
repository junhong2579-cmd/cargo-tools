// Supabase 흉내 PGlite DB(pgdata/)를 만들고, cargo-tool.html 의 실제 업로드 매핑 코드로 엑셀을 올린 뒤 dashboard.sql 을 실행한다.
// 사용: node setup.mjs <운임엑셀.xlsx>   (엑셀에는 실제 업체 정보가 있으므로 저장소에 넣지 않는다)
import { PGlite } from '@electric-sql/pglite';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../..'); // 저장소 루트
const XLSX_PATH = process.argv[2];
if (!XLSX_PATH) { console.error('사용법: node setup.mjs <운임엑셀.xlsx>'); process.exit(1); }
const html = fs.readFileSync(TOOL + '/private/cargo-tool.html', 'utf8').replace(/\r\n/g, '\n');

// 1) 업로드 매핑 코드 추출
const mapStart = html.indexOf('freightDataList = jsonData.map(row => {');
const mapEnd = html.indexOf('        // Local Storage에 저장', mapStart);
const mapCode = html.slice(mapStart + 'freightDataList = '.length, mapEnd).trim().replace(/;$/, '');
const recStart = html.indexOf('const validRecords = freightDataList');
const recEnd = html.indexOf('}));', recStart) + 4;
const recCode = html.slice(recStart, recEnd);
const toItems = new Function('jsonData', `return ${mapCode};`);
const toRecords = new Function('freightDataList', 'user', `${recCode}; return validRecords;`);

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });
const jsonData = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
const items = toItems(jsonData);
const records = toRecords(items, { email: 'junhong2579@gmail.com' });
console.log('excel rows', jsonData.length, 'records', records.length);
console.log('sample', JSON.stringify(records[0]).slice(0, 400));

const dir = path.join(HERE, 'pgdata');
await fs.promises.rm(dir, { recursive: true, force: true }); // Node 24 의 rmSync 는 한글 경로(바탕 화면)에서 멈춤
const db = new PGlite(dir);

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
  insert into public.profiles values
    ('11111111-1111-1111-1111-111111111111', 'ok@test', true, false),
    ('22222222-2222-2222-2222-222222222222', 'wait@test', false, false);
  create table public.freight_records (
    bl_no text primary key, io_date text, cargo text, voyage text, description text, bt text,
    consignee_code text, consignee text, notify text, actual_shipper text, a_shipper_code text, shipper text,
    twenty text, forty text, forty_five text, ts text, item text, remark text,
    crs_c text, lss_c text, pss_c text, frt_c text, esc text, caf text, baf_c text, thc text, ccf text, doc text,
    wfg text, tsf text, psc text, ebs_c text, cfs text, collect_ttl text, updated_at timestamptz, updated_by text);
  alter table public.freight_records enable row level security;
`);

const OLD_COLS = ['bl_no', 'io_date', 'cargo', 'voyage', 'description', 'bt', 'consignee_code', 'consignee', 'notify',
  'actual_shipper', 'a_shipper_code', 'shipper', 'twenty', 'forty', 'forty_five', 'ts', 'item', 'remark', 'crs_c', 'lss_c',
  'pss_c', 'frt_c', 'esc', 'caf', 'baf_c', 'thc', 'ccf', 'doc', 'wfg', 'tsf', 'psc', 'ebs_c', 'cfs', 'collect_ttl', 'updated_at', 'updated_by'];

async function upsert(rows, cols) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params = [];
    const values = chunk.map((r) => '(' + cols.map((c) => { params.push(r[c]); return '$' + params.length; }).join(',') + ')').join(',');
    await db.query(`insert into public.freight_records (${cols.join(',')}) values ${values}
      on conflict (bl_no) do update set ${cols.filter((c) => c !== 'bl_no').map((c) => `${c} = excluded.${c}`).join(', ')}`, params);
  }
}

// 2) 대시보드 SQL 실행 전: 기존 방식(추가 컬럼 없음)으로 앞쪽 절반만 업로드
const half = records.slice(0, 4000);
await upsert(half, OLD_COLS);

// 3) dashboard.sql 실행 (기존 데이터 백필 확인)
const sql = fs.readFileSync(TOOL + '/supabase/dashboard.sql', 'utf8');
await db.exec(sql);
let r = await db.query(`select count(*)::int n, count(*) filter (where ext)::int ext, min(d)::text dmin, max(d)::text dmax,
  count(*) filter (where d is null)::int nodate from public.dash_rows`);
console.log('after backfill', r.rows[0]);

// 4) 새 매핑으로 전체 업로드 (추가 컬럼 포함, 트리거 동기화 확인)
const NEW_COLS = Object.keys(records[0]);
await upsert(records, NEW_COLS);
r = await db.query(`select count(*)::int n, count(*) filter (where ext)::int ext, min(d)::text dmin, max(d)::text dmax,
  count(*) filter (where d is null)::int nodate, count(*) filter (where issue_date is null)::int noissue from public.dash_rows`);
console.log('after full upload', r.rows[0]);
await db.close();
