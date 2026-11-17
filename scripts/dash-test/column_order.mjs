// 화물시스템 엑셀 열 순서 변경 검증 (2026-11-17 '입금증여부' 추가 · 열 이동). 실제 Supabase 를 건드리지 않음.
// 사용: node column_order.mjs [새 수입.xlsx] [새 수출.xlsx] [예전 수입.xlsx] [예전 수출.xlsx] [화면복사.xlsx] [다른 지역 수입.xlsx]
//   (생략하면 평택데이터/ 안의 2026-11-17 파일 · 9월 파일을 씀. 평택데이터/ 는 저장소에 올리지 않음)
//   1) 운임 체크 붙여넣기(머리글 없음): 새 순서 · 예전 순서 · 앞 빈 칸 모두 = 같은 파일을 머리글로 읽은 결과
//   2) 실제 화면 복사본(엑셀에 붙여넣어 저장한 시트) = 다운로드 파일 (같은 B/L)
//   3) 모양이 다른 데이터(인천 · 제주 수입 등)는 받지 않고 안내
//   4) 운임 필터 · 대시보드 수입 올리기(toFreightItems) · 수출 올리기(parseExportSheet): 새 순서 = 예전 순서로 되돌린 같은 데이터
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../..');
const DATA = path.join(TOOL, '평택데이터');
const NEWDIR = path.join(DATA, '입금표여부 열 추가 및 열 순서 조정_20261117');
const [NEW_IN, NEW_OUT, OLD_IN, OLD_OUT, PASTE, OTHER] = [
  process.argv[2] || path.join(NEWDIR, '평택 수입 11월 17일까지.xlsx'),
  process.argv[3] || path.join(NEWDIR, '평택 수출 11월 17일까지.xlsx'),
  process.argv[4] || path.join(DATA, '9월 수입.xlsx'),
  process.argv[5] || path.join(DATA, '9월 수출.xlsx'),
  process.argv[6] || path.join(NEWDIR, '입금내역 화물시스템.xlsx'),
  process.argv[7] || path.join(NEWDIR, '인천 수입 11월 17일까지.xlsx'),
];

let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); };

// ── cargo-tool.html 의 붙여넣기 파서를 그대로 꺼내 씀 ─────────
const html = fs.readFileSync(path.join(TOOL, 'private', 'cargo-tool.html'), 'utf8');
const from = html.indexOf('  const FC_BASE_HEADERS = [');
const to = html.indexOf('  function fcParseExcelWithAutoHeader(');
if (from < 0 || to < 0) throw new Error('cargo-tool.html 에서 붙여넣기 파서를 찾지 못함');
const ctx = { console: { info() {}, log: console.log }, Math, String, Error };
vm.createContext(ctx);
vm.runInContext(html.slice(from, to) + '\nthis.fcParseRawRows = fcParseRawRows; this.FC_BASE_HEADERS = FC_BASE_HEADERS; this.FC_BASE_HEADERS_OLD = FC_BASE_HEADERS_OLD;', ctx);
const { fcParseRawRows } = ctx;

// ── upload.js (대시보드 데이터 올리기, 화물 도구와 같은 변환) ─────────
const uctx = { window: {}, document: { getElementById: () => null }, console };
vm.createContext(uctx);
vm.runInContext(fs.readFileSync(path.join(TOOL, 'public', 'dash', 'upload.js'), 'utf8'), uctx);
const U = uctx.window.DashUpload;

const sheet = (f, name) => { const wb = XLSX.read(fs.readFileSync(f)); return wb.Sheets[name || wb.SheetNames[0]]; };
const aoaOf = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
// 화면 붙여넣기 흉내: 탭으로 이어 붙인 뒤 processFcTargetPastedText 와 같은 방식으로 나눔
const pasteOf = (rows) => rows.map((r) => r.join('\t')).map((l) => l.trimEnd()).filter((l) => l.length > 0)
  .map((l) => l.split('\t').map((c) => c.trim()));
const byBl = (rows) => new Map(rows.map((r) => [r['B/L NO'], r]));
// 열 이름 · 값이 모두 같은지 (붙여넣기 쪽 'Dummy_A' · 'Unknown_n' 칸은 뺌)
function sameRows(a, b) {
  const A = byBl(a), B = byBl(b);
  if (A.size !== B.size) return `B/L 수 ${A.size} ≠ ${B.size}`;
  for (const [bl, r] of A) {
    const s = B.get(bl);
    if (!s) return `${bl} 없음`;
    // EXT(\) 는 예전 목록 표기가 'EXT(\\)' 라 이름이 다름 (어디서도 쓰지 않는 칸)
    for (const k of Object.keys(s)) if (!/^(Dummy_A|Unknown_|EXT\()/.test(k) && (r[k] ?? '') !== s[k]) return `${bl} ${k}: "${r[k]}" ≠ "${s[k]}"`;
  }
  return '';
}

// 1) 붙여넣기 = 머리글 있는 파일
for (const [label, f, n] of [['새 순서', NEW_IN, 80], ['예전 순서', OLD_IN, 79]]) {
  const aoa = aoaOf(sheet(f));
  check(`${label} 수입 엑셀 열 수 ${n}`, aoa[0].length === n, `${aoa[0].length}칸`);
  const head = fcParseRawRows(aoa);
  const pasted = fcParseRawRows(pasteOf(aoa.slice(1)));
  let diff = sameRows(pasted, head);
  check(`${label} 붙여넣기 = 머리글로 읽은 결과 (${head.length.toLocaleString()}건)`, !diff, diff);
  const dummy = fcParseRawRows(aoa.slice(1).map((r) => ['', ...r]));
  diff = sameRows(dummy, head);
  check(`${label} 앞에 빈 칸이 붙은 붙여넣기도 같음`, !diff, diff);
}
check('새 목록 = 새 다운로드 머리글', JSON.stringify([...ctx.FC_BASE_HEADERS]) === JSON.stringify(aoaOf(sheet(NEW_IN))[0]));
check('예전 목록 = 9월 다운로드 머리글 (EXT(\\) 표기 제외)',
  JSON.stringify([...ctx.FC_BASE_HEADERS_OLD].map((h) => h.replace(/\\+/g, '\\'))) === JSON.stringify(aoaOf(sheet(OLD_IN))[0]));

// 2) 실제 화면 복사본 (머리글 없음, 평택 = 위해수입 시트)
if (fs.existsSync(PASTE)) {
  const pasted = fcParseRawRows(aoaOf(sheet(PASTE, '위해수입')));
  const head = byBl(fcParseRawRows(aoaOf(sheet(NEW_IN))));
  const both = pasted.filter((r) => head.has(r['B/L NO']));
  // 복사본은 사용자 엑셀에 붙여넣어 저장한 것이라 표시 형식이 다름(80.00 ↔ 80, 18 ↔ 18.2) → 글자 칸은 그대로, 숫자 칸은 값(1 미만 차이 허용)으로 비교
  const TEXT = ['I/O Date', 'Consignee Code', 'Consignee', 'Notify', 'Actual Shipper', 'A/Shipper Code', 'Cargo', 'B/T (B/L Type)', 'T/S', 'ITEM', 'REMARK'];
  const NUM = ["20'", "40'", "45'", 'Collect TTL', 'THC', 'CRS($) C', 'FRT(＄) C (COLLECT)', 'BAF(＄) C (COLLECT)', 'CAF',
    'DOC', 'WFG', 'CCF', 'TSF', 'PSC', 'ESC', 'LSS($) C', 'PSS($) C', 'Weight', 'Measure'];
  const num = (v) => Number(String(v || '0').replace(/,/g, ''));
  const diffs = [];
  both.forEach((r) => {
    const h = head.get(r['B/L NO']);
    TEXT.forEach((k) => { if (r[k] !== h[k]) diffs.push(`${r['B/L NO']} ${k}`); });
    NUM.forEach((k) => { if (!(Math.abs(num(r[k]) - num(h[k])) < 1)) diffs.push(`${r['B/L NO']} ${k}: ${r[k]} ≠ ${h[k]}`); });
  });
  check(`화면 복사본 ${pasted.length}건 중 다운로드와 같은 B/L ${both.length}건 운임 항목 일치`, both.length > 0 && diffs.length === 0,
    diffs.length ? `다른 칸 ${diffs.length}개 (예: ${diffs.slice(0, 3).join(', ')})` : '');
} else console.log(`SKIP 화면 복사본 없음: ${PASTE}`);

// 3) 모양이 다른 데이터는 거부
if (fs.existsSync(OTHER)) {
  let msg = '';
  try { fcParseRawRows(aoaOf(sheet(OTHER)).slice(1)); } catch (e) { msg = e.message; }
  check('모양이 다른 붙여넣기(인천 수입 82칸)는 안내 후 거부', /열 순서를 알아볼 수 없습니다/.test(msg), msg.slice(0, 40));
}

// 4) 이름으로 읽는 곳: 새 순서 = 예전 순서로 되돌린 같은 데이터
function reorder(ws, oldHead) {
  const aoa = aoaOf(ws);
  const key = (seen) => (c) => { seen[c] = (seen[c] || 0) + 1; return `${c}#${seen[c]}`; };
  const nk = aoa[0].map(key({})), ok = oldHead.map(key({}));
  const idx = ok.map((k) => nk.indexOf(k));
  return XLSX.utils.aoa_to_sheet(aoa.map((r) => idx.map((i) => (i < 0 ? '' : r[i]))));
}
const strip = (rows) => JSON.stringify(rows.map(({ updated_at, ...r }) => r));
{
  const ws = sheet(NEW_IN), wr = reorder(ws, aoaOf(sheet(OLD_IN))[0]);
  const a = U.parseImportRows(XLSX.utils.sheet_to_json(ws, { defval: '', raw: false }), 't');
  const b = U.parseImportRows(XLSX.utils.sheet_to_json(wr, { defval: '', raw: false }), 't');
  check(`수입 올리기 (운임 필터 동기화 · 대시보드) 새 순서 = 예전 순서 (${a.rows.length}건)`, !a.error && strip(a.rows) === strip(b.rows), a.error || '');
  const r = a.rows.find((x) => Number(String(x.thc).replace(/,/g, '')) > 0);
  check('수입 올리기 값 확인 (THC · Collect TTL 숫자, 입항일 날짜)', !!r && /^[\d,]+$/.test(r.collect_ttl) && /^\d+\/\d+\/\d+$/.test(r.io_date));
}
{
  const ws = sheet(NEW_OUT), wr = reorder(ws, aoaOf(sheet(OLD_OUT))[0]);
  const a = U.parseExportSheet(aoaOf(ws), 't'), b = U.parseExportSheet(aoaOf(wr), 't');
  check(`수출 올리기 새 순서 = 예전 순서 (${(a.rows || []).length}건)`, !a.error && strip(a.rows) === strip(b.rows), a.error || '');
}

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
