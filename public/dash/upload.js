/* 데이터 올리기 (관리자 전용) — 화물시스템 운임 엑셀(수입 · 수출)을 Supabase 에 반영한다.
   - 수입: freight_records. 화물 도구(cargo-tool.html) 운임 필터 탭의 [클라우드 동기화]와 같은 표 · 같은 변환
           (parseImportRows 는 cargo-tool.html 의 엑셀 읽기 · 저장 변환을 그대로 옮긴 것. 화물 도구 쪽을 고치면 여기도 맞춰야 함.
            scripts/dash-test/export.mjs 가 두 변환 결과가 같은지 확인한다)
   - 수출: export_records (supabase/dashboard.sql 3-2). 화물 도구의 운임 필터 · 운임 체크는 이 표를 보지 않는다.
   - 파일 종류는 B/L 번호로 자동 판별: 모두 …W0001 형식이면 수출, W 형식이 하나도 없으면 수입, 섞이면 거부.
   엑셀 읽기(SheetJS, vendor/xlsx.full.min.js)는 창을 열 때만 불러온다. */
(() => {
  'use strict';

  const EXPORT_BL = /[0-9]W[0-9]{4}$/; // 수출 …1154W0001 (수입은 …1089E1001 등)

  // ── 수입: cargo-tool.html 의 운임 엑셀 변환과 같은 코드 ─────────────
  /** sheet_to_json(첫 시트, { defval: '', raw: false }) 결과 → 화물 도구의 freightDataList 와 같은 항목 */
  function toFreightItems(jsonData) {
    return jsonData.map(row => {
      const getVal = (targetKeys) => {
        for (let key of Object.keys(row)) {
          let upperKey = key.toUpperCase().trim();
          for (let target of targetKeys) {
            if (upperKey === target || upperKey.replace(/\s+/g, "") === target.replace(/\s+/g, "")) {
              return row[key] !== undefined && row[key] !== null ? String(row[key]).trim() : "";
            }
          }
        }
        for (let key of Object.keys(row)) {
          let upperKey = key.toUpperCase().trim();
          for (let target of targetKeys) {
            if (upperKey.includes(target)) {
              return row[key] !== undefined && row[key] !== null ? String(row[key]).trim() : "";
            }
          }
        }
        return "";
      };

      return {
        ioDate: getVal(["I/O DATE", "I/O", "DATE"]),
        blNo: getVal(["B/L NO", "B/L NUMBER", "B/L"]),
        cargo: getVal(["CARGO"]),
        voyage: getVal(["VOYAGE", "VVD"]),
        description: getVal(["DESCRIPTION", "DESC"]),
        bt: getVal(["B/T", "B/L TYPE", "B/T (B/L TYPE)"]),
        consigneeCode: getVal(["CONSIGNEE CODE", "CONSIGNEECODE", "C/CODE"]),
        consignee: getVal(["CONSIGNEE"]),
        notify: getVal(["NOTIFY"]),
        actualShipper: getVal(["ACTUAL SHIPPER", "ACTUALSHIPPER", "A/SHIPPER"]),
        aShipperCode: getVal(["A/SHIPPER CODE", "A/SHIPPERCODE", "ACTUAL SHIPPER CODE", "ASHIPPER CODE", "A/CODE", "ACTUALSHIPPERCODE"]),
        shipper: getVal(["SHIPPER"]),
        twenty: getVal(["20'", "20", "20FT"]),
        forty: getVal(["40'", "40", "40FT"]),
        fortyFive: getVal(["45'", "45", "45FT"]),
        ts: getVal(["T/S", "TS"]),
        item: getVal(["ITEM"]),
        remark: getVal(["REMARK", "REMARKS"]),
        crsC: getVal(["CRS($) C", "CRS($)C", "CRS($)", "CRS"]),
        lssC: getVal(["LSS($) C", "LSS($)C", "LSS($)", "LSS"]),
        pssC: getVal(["PSS($) C", "PSS($)C", "PSS($)", "PSS"]),
        frtC: getVal(["FRT(＄) C (COLLECT)", "FRT($) C (COLLECT)", "FRT(＄) C", "FRT($) C", "FRT(＄)C", "FRT($)C", "FRT", "FRT C"]),
        esc: getVal(["ESC"]),
        caf: getVal(["CAF"]),
        bafC: getVal(["BAF(＄) C (COLLECT)", "BAF($) C (COLLECT)", "BAF(＄) C", "BAF($) C", "BAF(＄)C", "BAF($)C", "BAF", "BAF C"]),
        thc: getVal(["THC"]),
        ccf: getVal(["CCF"]),
        doc: getVal(["DOC"]),
        wfg: getVal(["WFG"]),
        tsf: getVal(["TSF"]),
        psc: getVal(["PSC"]),
        ebsC: getVal(["EBS($) C", "EBS($)C", "EBS($)", "EBS"]),
        cfs: getVal(["CFS"]),
        collectTtl: getVal(["COLLECT TTL", "C TTL", "COLLECT TOTAL"]),
        vsl: getVal(["VSL"]),
        issueDate: getVal(["ISSUE DATE"]),
        ft: getVal(["F/T (FREIGHT TYPE)", "F/T"]),
        pkg: getVal(["PKG"]),
        weight: getVal(["WEIGHT"]),
        measure: getVal(["MEASURE"]),
        place: getVal(["배정장소 명", "배정장소명"])
      };
    });
  }

  /** freightDataList → freight_records 행 (화물 도구 syncFreightDataToSupabase 와 같은 변환 · 같은 B/L 은 마지막 행) */
  function toFreightRecords(freightDataList, who, now = new Date().toISOString()) {
    const validRecords = freightDataList
      .filter(item => item.blNo && String(item.blNo).trim() !== "")
      .map(item => ({
        io_date: String(item.ioDate || '').trim(),
        bl_no: String(item.blNo).trim(),
        cargo: String(item.cargo || '').trim(),
        voyage: String(item.voyage || '').trim(),
        description: String(item.description || '').trim(),
        bt: String(item.bt || '').trim(),
        consignee_code: String(item.consigneeCode || '').trim(),
        consignee: String(item.consignee || '').trim(),
        notify: String(item.notify || '').trim(),
        actual_shipper: String(item.actualShipper || '').trim(),
        a_shipper_code: String(item.aShipperCode || '').trim(),
        shipper: String(item.shipper || '').trim(),
        twenty: String(item.twenty || '0').trim(),
        forty: String(item.forty || '0').trim(),
        forty_five: String(item.fortyFive || '0').trim(),
        ts: String(item.ts || '').trim(),
        item: String(item.item || '').trim(),
        remark: String(item.remark || '').trim(),
        crs_c: String(item.crsC || '0').trim(),
        lss_c: String(item.lssC || '0').trim(),
        pss_c: String(item.pssC || '0').trim(),
        frt_c: String(item.frtC || '0').trim(),
        esc: String(item.esc || '').trim(),
        caf: String(item.caf || '').trim(),
        baf_c: String(item.bafC || '0').trim(),
        thc: String(item.thc || '').trim(),
        ccf: String(item.ccf || '').trim(),
        doc: String(item.doc || '').trim(),
        wfg: String(item.wfg || '').trim(),
        tsf: String(item.tsf || '').trim(),
        psc: String(item.psc || '').trim(),
        ebs_c: String(item.ebsC || '0').trim(),
        cfs: String(item.cfs || '').trim(),
        collect_ttl: String(item.collectTtl || '').trim(),
        vsl: String(item.vsl || '').trim(),
        issue_date: String(item.issueDate || '').trim(),
        ft: String(item.ft || '').trim(),
        pkg: String(item.pkg || '').trim(),
        weight: String(item.weight || '').trim(),
        measure: String(item.measure || '').trim(),
        place: String(item.place || '').trim(),
        updated_at: now,
        updated_by: who || '관리자'
      }));
    const uniqueMap = new Map();
    validRecords.forEach(r => uniqueMap.set(r.bl_no, r));
    return Array.from(uniqueMap.values());
  }

  /** 수입 엑셀 → { rows, error, summary } */
  function parseImportRows(jsonData, who) {
    const rows = toFreightRecords(toFreightItems(jsonData), who);
    if (!rows.length) return { error: 'B/L NO 가 있는 행이 없습니다. 화물시스템에서 내려받은 운임 엑셀인지 확인해 주세요.' };
    const exp = rows.filter((r) => EXPORT_BL.test(r.bl_no));
    if (exp.length) return { error: `수출 B/L(…W0001 형식)이 ${exp.length.toLocaleString()}건 섞여 있습니다 (예: ${exp.slice(0, 3).map((r) => r.bl_no).join(', ')}). 수입과 수출은 따로 올려 주세요.` };
    return { rows, summary: summaryOf(rows, jsonData.length) };
  }

  // ── 수출 ─────────────────────────────────────────────
  // export_records 컬럼 ← 엑셀 머리글 (Insert by · Update by 등 작업자 이름은 저장하지 않음)
  const COLS = {
    bl_no: 'B/L NO', vsl: 'VSL', voyage: 'VOYAGE', io_date: 'I/O Date', cargo: 'Cargo', bt: 'B/T (B/L Type)', ts: 'T/S',
    shipper_code: 'Shipper Code', shipper: 'Shipper', a_shipper_code: 'A/Shipper Code', actual_shipper: 'Actual Shipper',
    forwarder: 'Forwarder', consignee: 'Consignee',
    twenty: "20'", forty: "40'", forty_five: "45'", rf20: '20RF', rf40: '40RF',
    item: 'ITEM', issue_date: 'Issue Date', pkg: 'PKG', weight: 'Weight', measure: 'Measure', ft: 'F/T (Freight Type)',
    frt_p: 'FRT($) P (PREPAID)', frt_c: 'FRT($) C (COLLECT)', baf_p: 'BAF($) P (PREPAID)', baf_c: 'BAF($) C (COLLECT)', caf: 'CAF',
    crs_p: 'CRS($) P', crs_c: 'CRS($) C', lss_p: 'LSS($) P', lss_c: 'LSS($) C', esc: 'ESC',
    thc: 'THC', doc: 'DOC', wfg: 'WFG', cfs: 'CFS', ccf: 'CCF', tsf: 'TSF', psc: 'PSC',
    prepaid_ttl: 'Prepaid TTL', collect_ttl: 'Collect TTL', description: 'DESCRIPTION', remark: 'REMARK', ccam_check: 'CCAM CHECK',
  };
  // 없으면 수출 엑셀로 보지 않는 열
  const REQUIRED = ['bl_no', 'io_date', 'shipper_code', 'shipper', 'forwarder', 'twenty', 'forty', 'forty_five', 'rf20', 'rf40', 'prepaid_ttl', 'collect_ttl'];
  // 머리글 비교: 전각 ＄ → $, 공백 · 대소문자 무시
  const norm = (h) => String(h ?? '').replace(/＄/g, '$').replace(/\s+/g, '').toUpperCase();

  /** M/D/YY · YYYY-MM-DD 등 → 'YYYY-MM-DD' (요약 표시용, 못 읽으면 '') */
  function isoDate(v) {
    const p = String(v || '').trim().split(/[/.\-\s]+/).map(Number);
    if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return '';
    let [a, b, c] = p;
    let y, m, d;
    if (a >= 1900) [y, m, d] = [a, b, c];
    else { y = c >= 100 ? c : c >= 70 ? 1900 + c : 2000 + c; if (a > 12 && b <= 12) [d, m] = [a, b]; else [m, d] = [a, b]; }
    if (m < 1 || m > 12 || d < 1 || d > 31) return '';
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function summaryOf(rows, lines) {
    const dates = rows.map((o) => isoDate(o.io_date)).filter(Boolean).sort();
    return {
      rows: rows.length,
      dup: lines - rows.length, // 빈 행 · 같은 B/L 이 여러 번
      from: dates[0] || '', to: dates[dates.length - 1] || '',
      noDate: rows.length - dates.length,
      voyages: new Set(rows.map((o) => o.voyage).filter(Boolean)).size,
    };
  }

  /**
   * 시트 → export_records 행. aoa = sheet_to_json(header:1, raw:false, defval:'') 결과(값은 화면 표시 문자열).
   * 반환 { rows, error, summary }. error 가 있으면 올리지 않는다.
   */
  function parseExportSheet(aoa, who) {
    const hi = aoa.slice(0, 10).findIndex((r) => r.some((c) => norm(c) === 'B/LNO') && r.some((c) => norm(c) === 'I/ODATE'));
    if (hi < 0) return { error: '머리글(B/L NO · I/O Date)을 찾지 못했습니다. 화물시스템에서 내려받은 수출 운임 엑셀인지 확인해 주세요.' };
    const head = aoa[hi].map(norm);
    const idx = {};
    for (const [col, label] of Object.entries(COLS)) idx[col] = head.indexOf(norm(label)); // 같은 이름이 여럿이면 첫 열
    const missing = REQUIRED.filter((c) => idx[c] < 0).map((c) => COLS[c]);
    if (missing.length) return { error: `수출 엑셀에 있어야 할 열이 없습니다: ${missing.join(', ')}.` };

    const now = new Date().toISOString();
    const byBl = new Map(); // 같은 B/L 이 여러 번 있으면 마지막 행
    const notExport = [];
    for (const r of aoa.slice(hi + 1)) {
      const bl = String(r[idx.bl_no] ?? '').trim();
      if (!bl) continue;
      if (!EXPORT_BL.test(bl)) { notExport.push(bl); continue; }
      const o = {};
      for (const col of Object.keys(COLS)) o[col] = idx[col] < 0 ? '' : String(r[idx[col]] ?? '').trim();
      o.bl_no = bl;
      o.updated_at = now;
      o.updated_by = who || '';
      byBl.set(bl, o);
    }
    if (notExport.length) {
      return { error: `수출 B/L(…W0001 형식)이 아닌 행이 ${notExport.length.toLocaleString()}건 섞여 있습니다 (예: ${notExport.slice(0, 3).join(', ')}). 수입과 수출은 따로 올려 주세요.` };
    }
    const rows = [...byBl.values()];
    if (!rows.length) return { error: '올릴 B/L 이 없습니다.' };
    return { rows, summary: summaryOf(rows, aoa.length - hi - 1) };
  }

  /** 첫 시트의 B/L 번호로 수입 · 수출 판별: 'OUT' | 'IN' | 'MIXED' | null(B/L 없음) */
  function detectKind(aoa) {
    const hi = aoa.slice(0, 10).findIndex((r) => r.some((c) => norm(c) === 'B/LNO'));
    if (hi < 0) return null;
    const col = aoa[hi].findIndex((c) => norm(c) === 'B/LNO');
    const bls = aoa.slice(hi + 1).map((r) => String(r[col] ?? '').trim()).filter(Boolean);
    if (!bls.length) return null;
    const w = bls.filter((b) => EXPORT_BL.test(b)).length;
    return w === bls.length ? 'OUT' : w === 0 ? 'IN' : 'MIXED';
  }

  window.DashUpload = { parseExportSheet, parseImportRows, toFreightItems, toFreightRecords, detectKind, COLS };

  // ── 화면 (대시보드에서만) ─────────────────────
  if (!document.getElementById('xu-modal')) return;
  const $ = (id) => document.getElementById(id);
  const CHUNK = 500;
  const KIND = { IN: { name: '수입', upload: (r) => window.DashApi.uploadImport(r) }, OUT: { name: '수출', upload: (r) => window.DashApi.uploadExport(r) } };
  let X = null;
  let parsed = null; // { kind, rows, summary, file }
  let busy = false;
  let status = null; // dash_meta 의 import · export 현황

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error('엑셀 읽기 도구를 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.'));
      document.head.appendChild(s);
    });
  }

  function statusLine(name, ex) {
    if (!ex || !ex.rows) return `<li><b>${name}</b> 아직 없음</li>`;
    return `<li><b>${name}</b> B/L ${X.fmt.int(ex.rows)}건 · 입항일 ${ex.dateMin || '-'} ~ ${ex.dateMax || '-'} · 최근 반영 ${ex.syncedAt || '-'}</li>`;
  }
  function renderStatus() {
    $('xu-status').innerHTML = `<ul class="xu-status">${statusLine('수입', status?.import)}${statusLine('수출', status?.export)}</ul>`;
  }

  function setMsg(html, kind = '') {
    const el = $('xu-msg');
    el.className = `notice ${kind}`.trim();
    el.innerHTML = html;
    el.hidden = !html;
  }

  function reset() {
    parsed = null;
    $('xu-file').value = '';
    $('xu-go').disabled = true;
    setMsg('');
  }

  async function open() {
    reset();
    renderStatus();
    $('xu-modal').hidden = false;
    loadXlsx().catch((e) => setMsg(X.esc(e.message), 'error'));
    window.DashApi.meta().then((m) => { status = { import: m.import, export: m.export }; renderStatus(); }).catch(() => {});
  }
  const close = () => { if (!busy) $('xu-modal').hidden = true; };

  async function onFile(file) {
    parsed = null;
    $('xu-go').disabled = true;
    if (!file) return;
    setMsg('엑셀을 읽는 중입니다…');
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      const who = await window.DashApi.email().catch(() => '');
      const kind = detectKind(aoa);
      if (!kind) { setMsg('B/L NO 열 또는 B/L 번호를 찾지 못했습니다. 화물시스템에서 내려받은 운임 엑셀인지 확인해 주세요.', 'error'); return; }
      if (kind === 'MIXED') { setMsg('수입 B/L 과 수출 B/L(…W0001)이 한 파일에 섞여 있습니다. 수입과 수출은 따로 올려 주세요.', 'error'); return; }
      // 수입은 화물 도구와 똑같이 읽는다 (첫 행 = 머리글)
      const res = kind === 'OUT'
        ? parseExportSheet(aoa, who)
        : parseImportRows(XLSX.utils.sheet_to_json(ws, { defval: '', raw: false }), who);
      if (res.error) { setMsg(X.esc(res.error), 'error'); return; }
      parsed = { kind, ...res, file: file.name };
      const s = res.summary;
      setMsg(`<b>${KIND[kind].name} 운임 엑셀</b> · ${X.esc(file.name)}<br>B/L ${X.fmt.int(s.rows)}건 · 입항일 ${s.from || '-'} ~ ${s.to || '-'} · 항차 ${X.fmt.int(s.voyages)}개`
        + (s.dup > 0 ? ` · 빈 행 · 중복 B/L ${X.fmt.int(s.dup)}행 (같은 B/L 은 마지막 행)` : '')
        + (s.noDate ? `<br>입항일을 읽지 못한 B/L ${X.fmt.int(s.noDate)}건` : '')
        + (kind === 'IN'
          ? '<br>화물 도구 운임 필터 탭의 [클라우드 동기화]와 같은 곳(운임 필터 · 운임 체크 · 대시보드 수입)에 같은 방식으로 저장됩니다.'
          : '<br>수출 표에만 저장되며 화물 도구의 운임 필터 · 운임 체크에는 영향이 없습니다.')
        + '<br>이미 있는 B/L 은 새 값으로 덮어씁니다. [올리기]를 누르세요.');
      $('xu-go').disabled = false;
    } catch (e) {
      setMsg('엑셀을 읽지 못했습니다: ' + X.esc(e.message), 'error');
    }
  }

  async function upload() {
    if (!parsed || busy) return;
    busy = true;
    $('xu-go').disabled = true;
    $('xu-file').disabled = true;
    const { kind, rows } = parsed;
    const key = kind === 'IN' ? 'import' : 'export';
    const before = status?.[key]?.rows || 0;
    let done = 0;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        setMsg(`${KIND[kind].name} 올리는 중… ${X.fmt.int(done)} / ${X.fmt.int(rows.length)}건`);
        await KIND[kind].upload(rows.slice(i, i + CHUNK));
        done = Math.min(rows.length, i + CHUNK);
      }
      const meta = await window.DashApi.meta();
      status = { import: meta.import, export: meta.export };
      renderStatus();
      const added = Math.max(0, (status[key]?.rows || 0) - before);
      setMsg(`<b>${KIND[kind].name} ${X.fmt.int(rows.length)}건을 반영했습니다.</b> (새 B/L ${X.fmt.int(added)}건 · 기존 B/L 갱신 ${X.fmt.int(rows.length - added)}건)<br>대시보드 화면에 반영하려면 창을 닫은 뒤 새로고침하세요.`);
      parsed = null;
      X.toast(`${KIND[kind].name} 데이터를 반영했습니다.`);
    } catch (e) {
      setMsg(`${X.fmt.int(done)}건까지 반영한 뒤 멈췄습니다: ${X.esc(e.message)}<br>같은 엑셀을 다시 올리면 이어서 반영됩니다(이미 올라간 B/L 은 덮어씀).`, 'error');
    } finally {
      busy = false;
      $('xu-file').disabled = false;
    }
  }

  document.addEventListener('dash:ready', () => {
    X = window.Dash;
    if (!X.META.canUpload) return; // 관리자만 (Supabase 정책도 같은 기준으로 막음)
    status = { import: X.META.import, export: X.META.export };
    $('btn-export-upload').hidden = false;
    $('btn-export-upload').addEventListener('click', open);
    $('xu-file').addEventListener('change', (e) => onFile(e.target.files[0]));
    $('xu-go').addEventListener('click', upload);
    $('xu-modal').addEventListener('click', (e) => { if (e.target === $('xu-modal') || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('xu-modal').hidden) close(); });
  });
})();
