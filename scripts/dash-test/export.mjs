// 수출 대시보드 검증 (실제 Supabase 를 건드리지 않음). 사용: node export.mjs "<수출엑셀.xlsx>"
//   pgdata/(setup.mjs 로 만든 수입 DB)를 pgex/ 로 복사해서
//   1) before-export 이름표 시점의 SQL 을 적용 → 수입 대시보드 결과를 기록(기준)
//   2) 지금 SQL(dashboard.sql · stats_*.sql) 적용 → 수입 결과가 기준과 같은지
//   3) 수출 엑셀을 upload.js 의 parseExportSheet(화면과 같은 코드)로 바꿔 관리자 권한으로 올림
//      (일반 승인 사용자 · 수입 B/L 은 거부되는지) → 수입 결과가 그대로인지, 수출 집계가 엑셀 합계와 맞는지
//   4) 화물 도구의 수입 업로드(트리거) 흉내 → 오류 없이 반영되는지
//   5) export_rollback.sql → before-export 와 구조 · 결과가 같은지 → 지금 SQL 재적용 → 수출 복원
//   끝나면 pgex/ 는 수입 + 수출이 올라간 상태로 남는다 (DASH_DB=pgex node serve.mjs 로 화면 확인).
import { PGlite } from '@electric-sql/pglite';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../..');
const XLSX_PATH = process.argv[2];
const IMPORT_XLSX = process.argv[3]; // (선택) 수입 운임 엑셀: 대시보드 수입 올리기 = 화물 도구 동기화 인지 확인
if (!XLSX_PATH) { console.error('사용법: node export.mjs <수출엑셀.xlsx>'); process.exit(1); }
const DIR = path.join(HERE, 'pgex');
await fs.promises.rm(DIR, { recursive: true, force: true }); // Node 24 의 rmSync · cpSync 는 한글 경로에서 멈춤
await fs.promises.cp(path.join(HERE, 'pgdata'), DIR, { recursive: true });
const db = new PGlite(DIR);

const read = (f) => fs.readFileSync(path.join(TOOL, 'supabase', f), 'utf8');
const old = (f) => execFileSync('git', ['show', `before-export:supabase/${f}`], { cwd: TOOL, encoding: 'utf8' });
const STATS = ['stats_customers.sql', 'stats_shippers.sql'];
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); };

const APPROVED = { sub: '11111111-1111-1111-1111-111111111111', email: 'ok@test', role: 'authenticated' };
const ADMIN = { sub: '33333333-3333-3333-3333-333333333333', email: 'junhong2579@gmail.com', role: 'authenticated' };
async function as(claims, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await tx.exec('set local role authenticated');
    return fn(tx);
  });
}
const call = (tx, sql, ...args) => tx.query(sql, args.map((a) => JSON.stringify(a))).then((r) => r.rows[0].v);

// 수출 작업으로 결과 끝에 덧붙인 칸 · 키를 빼서 before-export 와 같은 모양으로 (기존 칸의 값은 그대로 비교)
const OLD_SUMMARY_FIELDS = 24, OLD_DETAIL_FIELDS = 39;
const NEW_TOTAL_KEYS = ['inBl', 'inTeu', 'outTeu', 'CFS', 'krIn', 'krOut', 'cnOut', 'mtTeu', 'mtBl', 'mtCntr', 'rf20', 'rf40', 'e20', 'e40', 'e45', 'mt20', 'mt40', 'mt45', 'mtR20', 'mtR40'];
function oldShape(v) {
  const o = structuredClone(v);
  if (o.groups) { // dash_summary
    o.fields = o.fields.slice(0, OLD_SUMMARY_FIELDS);
    for (const k of Object.keys(o.groups)) o.groups[k] = o.groups[k].map((a) => a.slice(0, OLD_SUMMARY_FIELDS));
  } else if (o.rows) { // dash_detail
    o.fields = o.fields.slice(0, OLD_DETAIL_FIELDS);
    o.rows = o.rows.map((a) => a.slice(0, OLD_DETAIL_FIELDS));
  }
  if (o.totals) NEW_TOTAL_KEYS.forEach((k) => delete o.totals[k]);
  // 점검 '컨테이너 수량 0' 은 파트 B/L 을 빼도록 바뀜 (사용자 확정 2026-10-22). 아래 '파트 B/L' 검사에서 따로 확인
  // 점검 'notify' 는 수출 Forwarder 누락만 세도록 바뀜 (수입 Notify 없음은 정상, 사용자 확정 2026-10-22)
  if (o.totals?.qc) { delete o.totals.qc.cntr; delete o.totals.qc.notify; }
  return o;
}

// 수입 대시보드 결과 (화면이 부르는 RPC 들)
async function snapshot() {
  return as(APPROVED, async (tx) => {
    const out = {};
    const meta = await call(tx, 'select public.dash_meta() v');
    delete meta.syncedAt; delete meta.export; delete meta.import; delete meta.canUpload; delete meta.byDir; // 새로 생긴 키 · 재적용 시각은 비교 제외
    out.meta = meta;
    out.options = await call(tx, 'select public.dash_options() v');
    delete out.options.byDir;
    const top = out.options.consignee[0][0];
    const filters = [{}, { from: '2026-05-01', to: '2026-05-31' }, { consignee: [top] }, { notify: ['현대글로비스 주식회사'] },
      { rf: '1' }, { cargo: ['L'] }, { bt: ['E'] }, { ft: 'P', ts: '0' }];
    for (const [i, f] of filters.entries()) {
      out['summary' + i] = oldShape(await call(tx, 'select public.dash_summary($1::jsonb) v', f));
      out['detail' + i] = oldShape(await call(tx, 'select public.dash_detail($1::jsonb, $2::jsonb) v', f, { limit: 200, sort: 'teu' }));
    }
    for (const opt of [{}, { from: '2026-06-01', to: '2026-07-31', basis: 'notify', cmpFrom: '2026-04-01', cmpTo: '2026-05-31' }]) {
      out['cust' + JSON.stringify(opt)] = await call(tx, 'select public.dash_customers($1::jsonb, $2::jsonb) v', {}, opt);
      out['ship' + JSON.stringify(opt)] = await call(tx, 'select public.dash_shippers($1::jsonb, $2::jsonb) v', {}, opt);
    }
    return out;
  });
}
// 목록 안의 순서를 무시한 비교용 형태. 건수가 같은 업체(동점)끼리의 나열 순서는 집계표를 다시 채울 때마다
// 바뀔 수 있어(예전 SQL 도 같음) 값이 같은지만 본다. 순서까지 같은지는 따로 표시한다.
const canon = (v) => (Array.isArray(v)
  ? v.map(canon).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)])) : v);
const same = (a, b) => {
  const keys = Object.keys(a);
  const diff = keys.filter((k) => JSON.stringify(canon(a[k])) !== JSON.stringify(canon(b[k])));
  const order = keys.filter((k) => !diff.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return { ok: diff.length === 0 && keys.length === Object.keys(b).length, diff: diff.concat(order.length ? [`(값 같음, 동점 순서만 다름: ${order.join(' ')})`] : []) };
};
const one = async (s) => (await db.query(s)).rows[0];
const structure = async () => ({
  cols: (await db.query(`select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) v from information_schema.columns where table_name = 'dash_rows'`)).rows[0].v,
  fns: (await db.query(`select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ',' order by 1) v from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'dash%'`)).rows[0].v,
  trg: (await db.query(`select string_agg(tgname || '@' || tgrelid::regclass, ',' order by 1) v from pg_trigger where not tgisinternal`)).rows[0].v,
});
const freightHash = async () => (await one(`select count(*)::int n, md5(string_agg(f::text, '|' order by bl_no)) h from freight_records f`));

// ── 1) before-export 기준 ──
await db.exec(old('dashboard.sql'));
for (const f of STATS) await db.exec(old(f));
const base = await snapshot();
const baseStruct = await structure();
const fh0 = await freightHash();
console.log(`기준(before-export): 수입 B/L ${base.meta.rows}건, freight_records ${fh0.n}건`);

// ── 2) 지금 SQL 적용 ──
await db.exec(read('dashboard.sql'));
for (const f of STATS) await db.exec(read(f));
let s = same(base, await snapshot());
check('새 SQL 적용 후 수입 결과 동일', s.ok, s.diff.join(','));
check('새 SQL 두 번째 실행도 안전', await db.exec(read('dashboard.sql')).then(() => true, (e) => (console.log(e.message), false)));
// 파트 B/L: 수입은 끝이 영문 + 컨테이너 0 인 B/L 만 점검에서 빠지고, 나머지 컨테이너 0 은 그대로 잡힘
const partIn = await one(`select count(*) filter (where cntr = 0 and cargo in ('F', 'L'))::int was,
  count(*) filter (where public.dash_qc(r, 'cntr'))::int now,
  count(*) filter (where part)::int part, count(*) filter (where part and (cntr <> 0 or bl !~ '[A-Z]$'))::int bad
  from dash_rows r where dir = 'IN'`);
check('점검 Notify: 수입은 세지 않음', (await one(`select count(*) filter (where public.dash_qc(r, 'notify'))::int n from dash_rows r where dir = 'IN'`)).n === 0);
check('점검 컨테이너 0: 수입 파트 B/L 만 뺌', partIn.bad === 0 && partIn.was - partIn.now <= partIn.part, JSON.stringify(partIn));

// ── 3) 수출 업로드 ──
const ctx = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(fs.readFileSync(path.join(TOOL, 'public/dash/upload.js'), 'utf8'), ctx);
const { parseExportSheet, toFreightItems, toFreightRecords, detectKind } = ctx.window.DashUpload;
const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
const parsed = parseExportSheet(aoa, ADMIN.email);
check('수출 엑셀 해석', !parsed.error, parsed.error || JSON.stringify(parsed.summary));
// 잘못된 파일은 거부
const asImport = aoa.map((r, i) => (i === 1 ? r.map((c) => String(c).replace(/W(\d{4})$/, 'E$1')) : r));
check('수입 B/L 이 섞인 엑셀 거부', !!parseExportSheet(asImport, '').error);
check('수출 열이 없는 엑셀 거부', !!parseExportSheet(aoa.map((r) => r.filter((_, j) => aoa[0][j] !== 'Prepaid TTL')), '').error);
const forbidden = ['insert by', 'update by', 'insert dt'].filter((k) => Object.keys(parsed.rows[0]).some((c) => c.toLowerCase().includes(k)));
check('작업자 이름 등 저장 안 함', forbidden.length === 0);

const cols = Object.keys(parsed.rows[0]);
const upsertAs = (claims, rows) => as(claims, async (tx) => {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500); const params = [];
    const values = chunk.map((r) => '(' + cols.map((c) => { params.push(r[c]); return '$' + params.length; }).join(',') + ')').join(',');
    await tx.query(`insert into public.export_records (${cols.join(',')}) values ${values}
      on conflict (bl_no) do update set ${cols.filter((c) => c !== 'bl_no').map((c) => `${c} = excluded.${c}`).join(', ')}`, params);
  }
});
check('일반 승인 사용자는 올리기 거부', await upsertAs(APPROVED, parsed.rows.slice(0, 3)).then(() => false, () => true));
check('수입 B/L 은 수출 표에 못 들어감', await upsertAs(ADMIN, [{ ...parsed.rows[0], bl_no: 'JDSNGP1089E1001' }]).then(() => false, () => true));
await upsertAs(ADMIN, parsed.rows);
await upsertAs(ADMIN, parsed.rows); // 같은 엑셀 다시 올리기 = 덮어쓰기
s = same(base, await snapshot());
check('수출 업로드 후 수입 결과 동일', s.ok, s.diff.join(','));

// 수출 집계 = 엑셀 합계
const n = (v) => parseFloat(String(v).replace(/,/g, '')) || 0;
const xs = parsed.rows;
const xl = {
  bl: xs.length,
  pp: xs.reduce((a, r) => a + n(r.prepaid_ttl), 0), cc: xs.reduce((a, r) => a + n(r.collect_ttl), 0),
  rf: xs.filter((r) => n(r.rf20) + n(r.rf40) > 0).length,
  teu: xs.filter((r) => r.bt !== 'E').reduce((a, r) => a + n(r.twenty) + n(r.rf20) + 2 * (n(r.forty) + n(r.rf40)) + 2 * n(r.forty_five), 0),
  mt: xs.filter((r) => r.bt === 'E' && r.bl_no.endsWith('1000')).reduce((a, r) => a + n(r.twenty) + n(r.rf20) + 2 * (n(r.forty) + n(r.rf40)) + 2 * n(r.forty_five), 0),
  mtBl: xs.filter((r) => r.bt === 'E' && r.bl_no.endsWith('1000')).length,
};
const dbx = await one(`select count(*)::int bl, sum(pp)::float pp, sum(cc)::float cc, count(*) filter (where rf = 'R')::int rf, sum(teu)::float teu,
  sum(mt_teu)::float mt, count(*) filter (where mt_teu > 0)::int "mtBl", count(*) filter (where d is null)::int nodate,
  count(*) filter (where ckey = '')::int nokey, sum(total)::float total from dash_rows where dir = 'OUT'`);
for (const k of ['bl', 'pp', 'cc', 'rf', 'teu', 'mt', 'mtBl']) check(`수출 ${k} = 엑셀`, Math.abs(dbx[k] - xl[k]) < 0.5, `${dbx[k]} / ${xl[k]}`);
check('수출 금액 = Prepaid + Collect', Math.abs(dbx.total - xl.pp - xl.cc) < 0.5);
check('수출 입항일 · 업체 키 모두 있음', dbx.nodate === 0 && dbx.nokey === 0, JSON.stringify({ nodate: dbx.nodate, nokey: dbx.nokey }));
const r3 = await as(APPROVED, async (tx) => ({
  out: (await call(tx, 'select public.dash_totals($1::jsonb) v', { dir: 'OUT' })).bl,
  all: (await call(tx, 'select public.dash_totals($1::jsonb) v', { dir: 'ALL' })).bl,
  meta: await call(tx, 'select public.dash_meta() v'),
  metaAdmin: null,
}));
r3.metaAdmin = await as(ADMIN, (tx) => call(tx, 'select public.dash_meta() v'));
check('조회 조건 dir=OUT · ALL', r3.out === xl.bl && r3.all === xl.bl + base.meta.rows, `${r3.out} / ${r3.all}`);
check('dash_meta.export 현황', r3.meta.export.rows === xl.bl, JSON.stringify(r3.meta.export));
check('업로드 권한 표시 (승인=false, 관리자=true)', r3.meta.canUpload === false && r3.metaAdmin.canUpload === true);
check('freight_records(수입 원본) 그대로', JSON.stringify(await freightHash()) === JSON.stringify(fh0));

// 2단계: 수출 · 전체 집계
const p2 = await as(APPROVED, async (tx) => ({
  out: await call(tx, 'select public.dash_totals($1::jsonb) v', { dir: 'OUT' }),
  all: await call(tx, 'select public.dash_totals($1::jsonb) v', { dir: 'ALL' }),
  inn: await call(tx, 'select public.dash_totals($1::jsonb) v', {}),
  sumAll: await call(tx, 'select public.dash_summary($1::jsonb) v', { dir: 'ALL' }),
  meta: await call(tx, 'select public.dash_meta() v'),
  opts: await call(tx, 'select public.dash_options() v'),
}));
const fwdN = new Set(xs.map((r) => r.forwarder).filter(Boolean)).size;
check('수출 한국 금액(PP) · 중국 금액(CC) · 공컨', Math.abs(p2.out.krOut - xl.pp) < 0.5 && Math.abs(p2.out.cnOut - xl.cc) < 0.5 && p2.out.mtTeu === xl.mt && p2.out.mtBl === xl.mtBl,
  JSON.stringify({ krOut: p2.out.krOut, cnOut: p2.out.cnOut, mtTeu: p2.out.mtTeu }));
check('전체 = 수입 + 수출 (B/L · TEU · 한국 금액)', p2.all.bl === p2.inn.bl + p2.out.bl && p2.all.teu === p2.inn.teu + p2.out.teu
  && Math.abs(p2.all.krIn + p2.all.krOut - p2.inn.total - xl.pp) < 1 && p2.all.inTeu === p2.inn.teu && p2.all.outTeu === p2.out.teu);
const months = Object.fromEntries(p2.sumAll.groups.month.map((a) => [a[0], Object.fromEntries(p2.sumAll.fields.map((f, i) => [f, a[i]]))]));
check('전체 월별: 9월은 수출만, 4월은 수입만', months['2026-09']?.inBl === 0 && months['2026-09']?.bl === xl.bl && months['2026-04']?.inBl === months['2026-04']?.bl);
check('수출 목록: Shipper 사업자번호 · Forwarder', p2.meta.byDir.OUT.rows === xl.bl && p2.opts.byDir.OUT.consignee.length === new Set(xs.map((r) => r.shipper_code)).size
  && p2.opts.byDir.OUT.notify.filter(([k]) => k).length === fwdN, `Forwarder ${fwdN}곳`);
const mtX = xs.filter((r) => r.bt === 'E' && r.bl_no.endsWith('1000'));
const mtSum = (f) => mtX.reduce((a, r) => a + f(r), 0);
const mtXl = { mt20: mtSum((r) => n(r.twenty)), mt40: mtSum((r) => n(r.forty)), mt45: mtSum((r) => n(r.forty_five)), mtR20: mtSum((r) => n(r.rf20)), mtR40: mtSum((r) => n(r.rf40)) };
check('공컨 종류 · 사이즈별 개수 = 엑셀, TEU 합 = 공컨 TEU', ['mt20', 'mt40', 'mt45', 'mtR20', 'mtR40'].every((k) => p2.out[k] === mtXl[k])
  && p2.out.mt20 + p2.out.mtR20 + 2 * (p2.out.mt40 + p2.out.mtR40 + p2.out.mt45) === p2.out.mtTeu, JSON.stringify(mtXl));
check('수출 점검: 발행일 · 배정장소는 수입만', p2.out.qc.issue === 0 && p2.out.qc.place === 0 && p2.out.qc.notify === xs.filter((r) => !r.forwarder).length);
const cntr0 = xs.filter((r) => ['F', 'L'].includes(r.cargo.toUpperCase()) && n(r.twenty) + n(r.forty) + n(r.forty_five) + n(r.rf20) + n(r.rf40) === 0);
check('수출 점검 컨테이너 0: PART 있는 파트 B/L 은 뺌', p2.out.qc.cntr === cntr0.filter((r) => !r.part).length && cntr0.some((r) => r.part),
  `점검 ${p2.out.qc.cntr}건, 엑셀 컨테이너 0 ${cntr0.length}건 중 파트 ${cntr0.filter((r) => r.part).length}건`);

// ── 4) 화물 도구의 수입 업로드 흉내 (트리거) ──
const any = await one(`select bl_no from freight_records order by bl_no limit 1`);
await db.query(`update freight_records set remark = remark where bl_no = $1`, [any.bl_no]);
await db.query(`insert into freight_records (bl_no, io_date, consignee, twenty) values ('JDSNGP9999E1001', '9/30/26', 'TEST', '1')`);
const t1 = await one(`select dir, teu::float from dash_rows where bl = 'JDSNGP9999E1001'`);
await db.query(`delete from freight_records where bl_no = 'JDSNGP9999E1001'`);
const t2 = await one(`select count(*)::int n from dash_rows where bl = 'JDSNGP9999E1001'`);
check('수입 업로드 · 삭제 트리거 정상', t1?.dir === 'IN' && t1.teu === 1 && t2.n === 0);
s = same(base, await snapshot());
check('수입 업로드 흉내 후 수입 결과 동일', s.ok, s.diff.join(','));
check('수출 행 유지', (await one(`select count(*)::int n from dash_rows where dir = 'OUT'`)).n === xl.bl);

// ── 5) 되돌리기 → 재적용 ──
await db.exec(read('export_rollback.sql'));
const rbStruct = await structure();
check('되돌린 후 구조 = before-export (집계표 칸 · 함수 · 트리거)',
  rbStruct.cols === baseStruct.cols && rbStruct.fns === baseStruct.fns && rbStruct.trg === baseStruct.trg.split(',').filter((t) => !t.includes('export')).join(','),
  JSON.stringify({ cols: rbStruct.cols === baseStruct.cols, fns: rbStruct.fns === baseStruct.fns, trg: rbStruct.trg }));
s = same(base, await snapshot());
check('되돌린 후 수입 결과 = before-export', s.ok, s.diff.join(','));
check('되돌린 후 freight_records 그대로', JSON.stringify(await freightHash()) === JSON.stringify(fh0));
check('되돌린 후 수입 업로드 정상', await db.query(`insert into freight_records (bl_no, io_date) values ('JDSNGP9999E1002', '9/30/26')`)
  .then(() => db.query(`delete from freight_records where bl_no = 'JDSNGP9999E1002'`)).then(() => true, (e) => (console.log(e.message), false)));
await db.exec(read('dashboard.sql'));
for (const f of STATS) await db.exec(read(f));
check('다시 적용하면 수출 복원', (await one(`select count(*)::int n from dash_rows where dir = 'OUT'`)).n === xl.bl);
s = same(base, await snapshot());
check('다시 적용 후 수입 결과 동일', s.ok, s.diff.join(','));

// 전체 제거(dashboard_rollback.sql) → 재적용
await db.exec(read('dashboard_rollback.sql'));
check('dashboard_rollback 후 대시보드 객체 없음', (await one(`select count(*)::int n from pg_proc where proname like 'dash%' and proname not in ('dash_customers', 'dash_shippers')`)).n === 0);
await db.exec(read('dashboard.sql'));
for (const f of STATS) await db.exec(read(f));
check('전체 제거 후 재적용: 수입 · 수출 복원', (await one(`select count(*)::int n from dash_rows where dir = 'OUT'`)).n === xl.bl
  && same(base, await snapshot()).ok);

// ── 6) 대시보드 데이터 올리기(수입) = 화물 도구 운임 동기화 ──
// 화물 도구(cargo-tool.html)의 엑셀 변환 · 저장 변환 코드를 그대로 꺼내 upload.js 결과와 비교한다 (setup.mjs 와 같은 방법)
const html = fs.readFileSync(path.join(TOOL, 'private/cargo-tool.html'), 'utf8').replace(/\r\n/g, '\n');
const mapStart = html.indexOf('freightDataList = jsonData.map(row => {');
const mapCode = html.slice(mapStart + 'freightDataList = '.length, html.indexOf('        // Local Storage에 저장', mapStart)).trim().replace(/;$/, '');
const recStart = html.indexOf('const validRecords = freightDataList');
const recCode = html.slice(recStart, html.indexOf('}));', recStart) + 4);
const dedupStart = html.indexOf('const uniqueMap = new Map();', recStart);
const dedupCode = html.slice(dedupStart, html.indexOf('const cleanRecords = Array.from(uniqueMap.values());', dedupStart) + 'const cleanRecords = Array.from(uniqueMap.values());'.length);
const toolItems = new Function('jsonData', `return ${mapCode};`);
const toolRecords = new Function('freightDataList', 'user', `${recCode}; ${dedupCode}; return cleanRecords;`);
const noTime = (rs) => rs.map(({ updated_at, updated_by, ...r }) => r);
const sameRecords = (jsonData) => {
  const a = noTime(toolRecords(toolItems(jsonData), { email: ADMIN.email }));
  const b = noTime(toFreightRecords(toFreightItems(jsonData), ADMIN.email));
  return { ok: JSON.stringify(a) === JSON.stringify(b), n: a.length };
};
const exJson = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
let sr = sameRecords(exJson);
check('수입 변환 = 화물 도구 변환 (수출 엑셀로 대조)', sr.ok, `${sr.n}건`);
check('파일 종류 자동 판별: 수출 엑셀 → OUT', detectKind(aoa) === 'OUT');
check('파일 종류 자동 판별: 섞인 엑셀 → MIXED', detectKind(asImport) === 'MIXED');
if (IMPORT_XLSX) {
  const iwb = XLSX.read(fs.readFileSync(IMPORT_XLSX), { type: 'buffer' });
  const iws = iwb.Sheets[iwb.SheetNames[0]];
  const iJson = XLSX.utils.sheet_to_json(iws, { defval: '', raw: false });
  sr = sameRecords(iJson);
  check('수입 변환 = 화물 도구 변환 (수입 엑셀)', sr.ok, `${sr.n}건`);
  check('파일 종류 자동 판별: 수입 엑셀 → IN', detectKind(XLSX.utils.sheet_to_json(iws, { header: 1, raw: false, defval: '' })) === 'IN');
  // 대시보드 방식으로 올린 뒤 DB 에 저장된 값 = 화물 도구 변환이 저장했을 값 (작업 시각 · 작업자 제외)
  const outBefore = (await one(`select count(*)::int n from dash_rows where dir = 'OUT'`)).n;
  // 로컬 시험 DB 에는 Supabase 의 freight_records 쓰기 정책이 없으므로 관리자 쓰기만 흉내 낸다
  await db.exec(`grant select, insert, update on public.freight_records to authenticated;
    drop policy if exists t_admin_rw on public.freight_records;
    create policy t_admin_rw on public.freight_records for all to authenticated using (public.dash_is_admin()) with check (public.dash_is_admin());`);
  const recs = toFreightRecords(toFreightItems(iJson), ADMIN.email);
  const icols = Object.keys(recs[0]);
  await as(ADMIN, async (tx) => {
    for (let i = 0; i < recs.length; i += 500) {
      const chunk = recs.slice(i, i + 500); const params = [];
      const values = chunk.map((r) => '(' + icols.map((c) => { params.push(r[c]); return '$' + params.length; }).join(',') + ')').join(',');
      await tx.query(`insert into public.freight_records (${icols.join(',')}) values ${values}
        on conflict (bl_no) do update set ${icols.filter((c) => c !== 'bl_no').map((c) => `${c} = excluded.${c}`).join(', ')}`, params);
    }
  });
  const expected = noTime(toolRecords(toolItems(iJson), { email: ADMIN.email }));
  const stored = new Map((await db.query(`select bl_no, to_jsonb(f) - 'updated_at' - 'updated_by' v from freight_records f where bl_no = any($1)`,
    [expected.map((r) => r.bl_no)])).rows.map((r) => [r.bl_no, r.v]));
  const bad = expected.filter((e) => !stored.has(e.bl_no) || Object.keys(e).some((k) => String(stored.get(e.bl_no)[k] ?? '') !== e[k]));
  check('대시보드로 수입 올리기: 저장 값 = 화물 도구 동기화 값', bad.length === 0, `${expected.length}건 중 다름 ${bad.length}건${bad[0] ? ' 예: ' + bad[0].bl_no : ''}`);
  const io = await one(`select count(*) filter (where dir = 'IN')::int i, count(*) filter (where dir = 'OUT')::int o,
    (select count(*)::int from freight_records) f from dash_rows`);
  check('대시보드로 수입 올리기: 대시보드 수입 = freight_records, 수출 그대로', io.i === io.f && io.o === outBefore, JSON.stringify(io));
  await db.exec(`drop policy if exists t_admin_rw on public.freight_records;`);
}

await db.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
