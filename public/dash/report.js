/* 보고서(월별 · 연별 · 업체별 · 현재 조회 화면) 생성 → A4 미리보기 → window.print() 로 PDF 저장.
   집계는 app.js 의 window.Dash(fetchSummary 등, Supabase RPC)를 그대로 쓴다. */
document.addEventListener('dash:ready', () => {
  'use strict';
  const X = window.Dash;
  const $ = (id) => document.getElementById(id);
  const { fmt, esc } = X;

  const cfg = {
    type: 'month', month: X.MONTHS[X.MONTHS.length - 1], year: X.YEARS[X.YEARS.length - 1],
    basis: 'consignee', company: null, cperiod: '', detail: false,
  };
  const TYPES = [['month', '월별'], ['year', '연별'], ['company', '업체별'], ['current', '현재 조회 화면']];

  // ── 모달 ────────────────────────────────────
  function segInit(el, opts, get, set) {
    el.innerHTML = opts.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('');
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { set(b.dataset.v); sync(); } });
  }
  function fillCompanies() {
    const term = $('rm-company-search').value.trim().toLowerCase();
    const all = X.companyList(cfg.basis).sort((a, b) => b.n - a.n);
    const opts = all.filter((o) => !term || (o.name + ' ' + o.code).toLowerCase().includes(term)).slice(0, 500);
    if (cfg.company == null || !all.some((o) => o.key === cfg.company)) cfg.company = opts[0]?.key ?? null;
    $('rm-company').innerHTML = opts.map((o) => `<option value="${esc(o.key)}"${o.key === cfg.company ? ' selected' : ''}>${esc(o.name)}${o.code ? ` (${esc(o.code)})` : ''} · ${fmt.int(o.n)}건</option>`).join('');
  }

  let hintSeq = 0;
  function sync() {
    document.querySelectorAll('#rm-type button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === cfg.type));
    document.querySelectorAll('#rm-basis button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === cfg.basis));
    $('rm-month-field').hidden = cfg.type !== 'month';
    $('rm-year-field').hidden = cfg.type !== 'year';
    $('rm-company-fields').hidden = cfg.type !== 'company';
    $('rm-current-hint').hidden = cfg.type !== 'current';
    if (cfg.type === 'company') fillCompanies();
    // B/L 상세 목록 쪽수 안내 (건수는 서버에서)
    const my = ++hintSeq;
    $('rm-detail-hint').textContent = '';
    X.fetchTotals(reportScope().s).then((t) => {
      if (my === hintSeq && t.bl) $('rm-detail-hint').textContent = `(${fmt.int(t.bl)}건, 약 ${Math.max(1, Math.ceil(t.bl / 38))}쪽 추가)`;
    }).catch(() => {});
  }

  function openModal() {
    const s = X.state;
    // 현재 조회 조건에서 기본값을 가져온다.
    if (s.from && s.to && s.from.slice(0, 7) === s.to.slice(0, 7) && X.MONTHS.includes(s.from.slice(0, 7))) cfg.month = s.from.slice(0, 7);
    if (s.consignee.length === 1) { cfg.basis = 'consignee'; cfg.company = s.consignee[0]; }
    else if (s.notify.length === 1 && s.notify[0] !== X.NONE) { cfg.basis = 'notify'; cfg.company = s.notify[0]; }
    $('rm-company-search').value = '';
    $('rm-month').value = cfg.month; $('rm-year').value = cfg.year;
    $('report-modal').hidden = false;
    sync();
  }
  const closeModal = () => { $('report-modal').hidden = true; };

  segInit($('rm-type'), TYPES, () => cfg.type, (v) => { cfg.type = v; });
  segInit($('rm-basis'), [['consignee', 'Consignee'], ['notify', 'Notify']], () => cfg.basis, (v) => { cfg.basis = v; cfg.company = null; });
  $('rm-month').innerHTML = [...X.MONTHS].reverse().map((m) => `<option value="${m}">${X.monthLabel(m)}</option>`).join('');
  $('rm-year').innerHTML = [...X.YEARS].reverse().map((y) => `<option value="${y}">${y}년</option>`).join('');
  $('rm-company-period').innerHTML = `<option value="">전체 기간</option>` +
    [...X.YEARS].reverse().map((y) => `<option value="y:${y}">${y}년</option>`).join('') +
    [...X.MONTHS].reverse().map((m) => `<option value="m:${m}">${X.monthLabel(m)}</option>`).join('');
  $('rm-month').addEventListener('change', (e) => { cfg.month = e.target.value; sync(); });
  $('rm-year').addEventListener('change', (e) => { cfg.year = e.target.value; sync(); });
  $('rm-company').addEventListener('change', (e) => { cfg.company = e.target.value; sync(); });
  $('rm-company-search').addEventListener('input', () => { cfg.company = null; sync(); });
  $('rm-company-period').addEventListener('change', (e) => { cfg.cperiod = e.target.value; sync(); });
  $('rm-detail').addEventListener('change', (e) => { cfg.detail = e.target.checked; });
  $('btn-report').addEventListener('click', openModal);
  $('report-modal').addEventListener('click', (e) => { if (e.target.id === 'report-modal' || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('report-modal').hidden) closeModal();
    else if (!$('report-root').hidden) closeReport();
  });
  $('rm-go').addEventListener('click', () => {
    if (cfg.type === 'company' && cfg.company == null) { X.toast('보고서를 만들 업체를 선택해 주세요.'); return; }
    closeModal();
    openReport();
  });

  // ── 범위 계산 ────────────────────────────────
  const EMPTY_FILTER = { consignee: [], notify: [], companyMode: 'and', items: [], cargo: [], bt: [], ts: 'all', ex: 'all', ft: 'all', rf: 'all' };

  function reportScope() {
    let s, title, kind;
    if (cfg.type === 'month') {
      s = { ...EMPTY_FILTER, ...X.monthRange(cfg.month) };
      title = `${X.monthLabel(cfg.month)} 월간 물류 보고서`; kind = '월간 보고서';
    } else if (cfg.type === 'year') {
      s = { ...EMPTY_FILTER, ...X.yearRange(cfg.year) };
      title = `${cfg.year}년 연간 물류 보고서`; kind = '연간 보고서';
    } else if (cfg.type === 'company') {
      const range = cfg.cperiod.startsWith('y:') ? X.yearRange(cfg.cperiod.slice(2))
        : cfg.cperiod.startsWith('m:') ? X.monthRange(cfg.cperiod.slice(2)) : { from: '', to: '' };
      s = { ...EMPTY_FILTER, ...range, [cfg.basis]: cfg.company == null ? [] : [cfg.company] };
      title = `${cfg.company == null ? '' : X.companyName(cfg.basis, cfg.company)} 물류 실적 보고서`; kind = `업체별 보고서 (${cfg.basis === 'notify' ? 'Notify' : 'Consignee'} 기준)`;
    } else {
      s = structuredClone(X.state);
      title = '물류 현황 보고서'; kind = '조회 조건 보고서';
    }
    return { s, title, kind };
  }

  // ── 렌더링 도우미 ─────────────────────────────
  const reportCharts = [];
  function table(cols, rows, footRow) {
    return `<table class="rpt"><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}">${c.l}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => `<tr>${cols.map((c) => `<td class="${c.r ? 'r' : ''}">${c.v(r, i)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}">해당 데이터 없음</td></tr>`}</tbody>
      ${footRow ? `<tfoot><tr>${cols.map((c, i) => `<td class="${c.r ? 'r' : ''}">${i === 0 ? '합계' : c.foot ? c.foot(footRow) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table>`;
  }
  const n = (l, key, f = fmt.int) => ({ l, r: true, v: (g) => f(g[key]), foot: (t) => f(t[key]) });
  const share = (t, key = 'teu', l = 'TEU 비중') => ({ l, r: true, v: (g) => fmt.pct(g[key], t[key]), foot: () => (t[key] ? '100.0%' : '–') });
  const volumeCols = (t) => [n('B/L', 'bl'), n('TEU', 'teu'), n('중량(톤)', 'weight', fmt.ton), n('CBM', 'cbm', fmt.one), n('총 청구액(백만원)', 'total', fmt.mil), share(t)];
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  function deltaCell(cur, prev, cmp) {
    if (!cmp || !cmp.available || prev == null) return '';
    if (!prev) return `<div class="d">${esc(cmp.label)} 비교값 0</div>`;
    const d = ((cur - prev) / prev) * 100;
    const cls = Math.abs(d) < 0.05 ? '' : d > 0 ? 'up' : 'down';
    return `<div class="d ${cls}">${esc(cmp.label)} ${cls === 'up' ? '▲' : cls === 'down' ? '▼' : ''} ${fmt.one(Math.abs(d))}%</div>`;
  }

  function chartBlock(id) { return `<div class="rpt-chart" id="${id}"></div>`; }
  function mountChart(id, option, height = 240) {
    const el = $(id);
    if (!el) return;
    el.style.height = height + 'px';
    const c = echarts.init(el, null, { renderer: 'svg', width: el.clientWidth || 680, height });
    delete option._keys;
    delete option._monthInterval;
    c.setOption({ ...option, animation: false });
    reportCharts.push(c);
  }

  // ── 보고서 본문 ──────────────────────────────
  let reportSeq = 0;
  async function openReport() {
    const { s, title, kind } = reportScope();
    const cmp = X.compareRange(s.from, s.to);
    const my = ++reportSeq;
    X.setLoading(true);
    X.toast('보고서를 준비하고 있습니다…');
    let S, prev, list;
    try {
      [S, prev, list] = await Promise.all([
        X.fetchSummary(s),
        cmp && cmp.available ? X.fetchTotals(s, cmp) : null,
        cfg.detail ? X.fetchDetail(s, { sort: 'date', dir: 'asc', limit: 100000, offset: 0 }).then((r) => r.rows) : null,
      ]);
    } catch (e) {
      X.toast('보고서를 만들지 못했습니다: ' + e.message);
      return;
    } finally {
      X.setLoading(false);
    }
    if (my !== reportSeq) return;

    const { t, groups } = S;
    const months = groups.month.filter((g) => g.key !== X.NONE);
    const trendMode = months.length > 1 ? 'month' : 'voyage';
    const now = new Date();
    const printed = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const conds = X.describeFilters(s);
    let sec = 0;
    const H = (label) => `<h2>${++sec}. ${label}</h2>`;
    const html = [];

    html.push(`<header class="rpt-head">
      <div class="rpt-org"><span>${esc(X.vesselLabel())} · 선사 물류 실적</span><span>${esc(kind)}</span></div>
      <h1>${esc(title)}</h1>
      <dl class="rpt-meta">
        <dt>대상 기간</dt><dd>${esc(X.periodLabel(s.from, s.to))}</dd>
        <dt>출력 일시</dt><dd>${printed}</dd>
        <dt>조회 조건</dt><dd>${conds.length ? conds.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' / ') : '전체 업체 · 전체 화물'}</dd>
        <dt>데이터 기준</dt><dd>클라우드 동기화 데이터 · ${esc(X.META.dateMin)} ~ ${esc(X.META.dateMax)} (최근 반영 ${esc(X.META.syncedAt)})</dd>
        <dt>산정 기준</dt><dd>TEU = 20'×1 + 40'×2 + 45'×2 · 금액은 Collect 기준</dd>
      </dl>
    </header>`);

    if (!t.bl) {
      html.push('<section class="rpt-sec"><p>선택한 조건에 해당하는 B/L이 없습니다.</p></section>');
    } else {
      // 1. 요약
      html.push(`<section class="rpt-sec">${H('실적 요약')}<div class="rpt-kpis">${X.kpiList(t, trendMode).map((k) => `
        <div class="rpt-kpi"><div class="l">${k.label}</div><div class="v">${k.value}${k.unit ? `<small>${k.unit}</small>` : ''}</div>
        ${deltaCell(k.raw, prev ? k.get(prev) : null, cmp)}<div class="d">${k.sub}</div></div>`).join('')}</div>
        ${cmp && !cmp.available ? `<p class="rpt-note">${esc(cmp.label)} 비교: 비교 기간의 데이터가 없어 증감을 표시하지 않았습니다.</p>` : ''}</section>`);

      // 2. 추이
      const tg = (trendMode === 'month' ? months : groups.voyage.filter((g) => g.key !== X.NONE)).sort(byDate);
      html.push(`<section class="rpt-sec flow">${H(trendMode === 'month' ? '월별 실적 추이' : '항차별 실적')}${chartBlock('rc-trend')}
        ${table([
          trendMode === 'month' ? { l: '월', v: (g) => X.monthLabel(g.key) } : { l: '항차', v: (g) => esc(g.key) },
          ...(trendMode === 'voyage' ? [{ l: '입항일', v: (g) => g.date || '' }] : []),
          n("20'", 'c20'), n("40'", 'c40'), n("45'", 'c45'), ...volumeCols(t),
        ], tg, t)}</section>`);

      // 3. 업체
      if (cfg.type === 'company') {
        const other = cfg.basis === 'consignee' ? 'notify' : 'consignee';
        const og = X.topCompanies(groups[other], other, 'teu', 15, true);
        html.push(`<section class="rpt-sec">${H(`${other === 'notify' ? 'Notify' : 'Consignee'}별 구성`)}
          ${table([{ l: '업체', v: (g) => esc(g.full) }, ...volumeCols(t)], og)}</section>`);
      } else {
        const tc = X.topCompanies(groups.consignee, 'consignee', 'teu', 15);
        const tn = X.topCompanies(groups.notify, 'notify', 'teu', 10);
        html.push(`<section class="rpt-sec">${H('Consignee 상위 15 (TEU 기준)')}
          ${table([{ l: '순위', r: true, v: (g, i) => i + 1 }, { l: 'Consignee', v: (g) => esc(g.full) }, { l: '사업자번호', v: (g) => esc(X.consigneeCode(g.key)) }, ...volumeCols(t)], tc)}
          <p class="rpt-note">조회 대상 Consignee ${fmt.int(t.companies)}곳 중 상위 15곳. 상위 15곳 합계 TEU 비중 ${fmt.pct(tc.reduce((a, g) => a + g.teu, 0), t.teu)}.</p></section>`);
        html.push(`<section class="rpt-sec">${H('Notify 상위 10 (TEU 기준)')}
          ${table([{ l: '순위', r: true, v: (g, i) => i + 1 }, { l: 'Notify', v: (g) => esc(g.full) }, ...volumeCols(t)], tn)}
          <p class="rpt-note">Notify가 지정되지 않은 B/L ${fmt.int(t.bl - t.withNotify)}건은 제외했습니다.</p></section>`);
      }

      // 4. ITEM · 화물 종류
      const ig = [...groups.item].sort((a, b) => b.teu - a.teu || b.bl - a.bl);
      const cg = [...groups.cargo].sort((a, b) => b.bl - a.bl);
      html.push(`<section class="rpt-sec">${H('ITEM · 화물 종류별 실적')}<div class="rpt-two">
        ${table([{ l: 'ITEM', v: (g) => esc(g.key || '(없음)') }, n('B/L', 'bl'), n('TEU', 'teu'), n('중량(톤)', 'weight', fmt.ton), share(t)], ig, t)}
        <div>${table([{ l: '화물 종류', v: (g) => `${X.CARGO[g.key] || g.key || '(없음)'} (${esc(g.key)})` }, n('B/L', 'bl'), n('TEU', 'teu'), share(t, 'bl', 'B/L 비중')], cg, t)}
        ${chartBlock('rc-cargo')}</div></div></section>`);

      // 냉동 (선어 · 활어 포함): 구성 + Consignee 상위 10
      const rfT = X.reeferSummary(S, 'teu'), rfB = X.reeferSummary(S, 'bl');
      const rfTop = X.reeferTop(S);
      if (rfB.reefer) {
        const rfRows = rfT.parts.map((p) => ({ name: p.name, bl: p.bl, teu: p.teu }));
        const rfSum = { bl: rfB.reefer, teu: rfT.reefer };
        html.push(`<section class="rpt-sec">${H('냉동 화물 (선어 · 활어 포함)')}<div class="rpt-two">
          <div>${table([{ l: '구분', v: (g) => g.name }, n('B/L', 'bl'), share(rfSum, 'bl', 'B/L 비중'), n('TEU', 'teu'), share(rfSum, 'teu', 'TEU 비중')], rfRows, rfSum)}
          <p class="rpt-note">전체 대비 냉동 비중: TEU ${fmt.int(rfT.reefer)} / ${fmt.int(t.teu)} (${fmt.pct(rfT.reefer, t.teu)}) · B/L ${fmt.int(rfB.reefer)} / ${fmt.int(t.bl)}건 (${fmt.pct(rfB.reefer, t.bl)}).
          B/L 번호에 E12 가 있으면 냉동, 그중 REMARK 에 선어 · 활어가 있으면 선어 · 활어로 나눴습니다.</p></div>
          ${chartBlock('rc-reefer')}</div></section>`);
        html.push(`<section class="rpt-sec">${H('냉동 Consignee 상위 10 (TEU 기준)')}${chartBlock('rc-reefer-top')}
          ${table([{ l: '순위', r: true, v: (g, i) => i + 1 }, { l: 'Consignee', v: (g) => esc(g.full) }, { l: '사업자번호', v: (g) => esc(X.consigneeCode(g.key)) },
            n('B/L', 'bl'), n('TEU', 'teu'), share(rfSum, 'teu', '냉동 TEU 비중')], rfTop)}
          <p class="rpt-note">냉동 Consignee ${fmt.int((S.groups.reeferConsignee || []).length)}곳 중 상위 10곳. 상위 10곳 합계 냉동 TEU 비중 ${fmt.pct(rfTop.reduce((a, g) => a + g.teu, 0), rfT.reefer)}.</p></section>`);
      } else {
        html.push(`<section class="rpt-sec">${H('냉동 화물 (선어 · 활어 포함)')}<p class="rpt-note">선택한 조건에 해당하는 냉동 B/L 이 없습니다.</p></section>`);
      }

      // 환적 · 특송: 월(항차)별 TEU · 점유율 + Consignee 상위 10
      const subRows = trendMode === 'month' ? months : groups.voyage.filter((g) => g.key !== X.NONE);
      Object.entries(X.SUBSETS).forEach(([k, d]) => {
        const subTeu = subRows.reduce((a, g) => a + (Number(g[d.teuKey]) || 0), 0);
        const subBl = subRows.reduce((a, g) => a + (Number(g[d.blKey]) || 0), 0);
        if (!subBl) {
          html.push(`<section class="rpt-sec">${H(`${d.name} 화물 (${d.note})`)}<p class="rpt-note">선택한 조건에 해당하는 ${d.name} B/L 이 없습니다.</p></section>`);
          return;
        }
        const pr = [...subRows].sort(byDate);
        const pct1 = (a, b) => (b ? `${fmt.one((a / b) * 100)}%` : '–');
        html.push(`<section class="rpt-sec flow">${H(`${d.name} 화물 (${d.note}) · ${trendMode === 'month' ? '월별' : '항차별'}`)}${chartBlock(`rc-${k}`)}
          ${table([
            trendMode === 'month' ? { l: '월', v: (g) => X.monthLabel(g.key) } : { l: '항차', v: (g) => esc(g.key) },
            ...(trendMode === 'voyage' ? [{ l: '입항일', v: (g) => g.date || '' }] : []),
            { l: `${d.name} B/L`, r: true, v: (g) => fmt.int(g[d.blKey]), foot: () => fmt.int(subBl) },
            { l: `${d.name} TEU`, r: true, v: (g) => fmt.int(g[d.teuKey]), foot: () => fmt.int(subTeu) },
            { l: '전체 TEU', r: true, v: (g) => fmt.int(g.teu), foot: () => fmt.int(t.teu) },
            { l: '점유율', r: true, v: (g) => pct1(Number(g[d.teuKey]) || 0, g.teu), foot: () => pct1(subTeu, t.teu) },
          ], pr, t)}
          <p class="rpt-note">점유율 = 그 ${trendMode === 'month' ? '월' : '항차'}의 전체 TEU 중 ${d.name} TEU.</p></section>`);
        const top = X.subsetTop(S, d.dim);
        html.push(`<section class="rpt-sec">${H(`${d.name} Consignee 상위 10 (TEU 기준)`)}${chartBlock(`rc-${k}-top`)}
          ${table([{ l: '순위', r: true, v: (g, i) => i + 1 }, { l: 'Consignee', v: (g) => esc(g.full) }, { l: '사업자번호', v: (g) => esc(X.consigneeCode(g.key)) },
            n('B/L', 'bl'), n('TEU', 'teu'), { l: `${d.name} TEU 비중`, r: true, v: (g) => fmt.pct(g.teu, subTeu) }], top)}
          <p class="rpt-note">${d.name} Consignee ${fmt.int((S.groups[d.dim] || []).length)}곳 중 상위 10곳. 상위 10곳 합계 ${d.name} TEU 비중 ${fmt.pct(top.reduce((a, g) => a + g.teu, 0), subTeu)}.</p></section>`);
      });

      // 5. 청구 항목
      const krw = X.KRW_CHARGES.map((k) => ({ k, v: t[k] })).sort((a, b) => b.v - a.v);
      const usd = X.USD_CHARGES.map((k) => ({ k, v: t[k] })).sort((a, b) => b.v - a.v);
      html.push(`<section class="rpt-sec">${H('청구 항목 구성 (Collect)')}<div class="rpt-two">
        ${table([{ l: '원화 항목', v: (x) => x.k }, { l: '금액(원)', r: true, v: (x) => fmt.won(x.v), foot: () => fmt.won(t.krw) }, { l: '비중', r: true, v: (x) => fmt.pct(x.v, t.krw), foot: () => '100.0%' }], krw, t)}
        ${table([{ l: '외화 항목', v: (x) => x.k }, { l: '금액(USD)', r: true, v: (x) => fmt.usd(x.v), foot: () => fmt.usd(t.usd) }, { l: '비중', r: true, v: (x) => fmt.pct(x.v, t.usd), foot: () => '100.0%' }], usd, t)}
        </div><p class="rpt-note">총 청구액 ${fmt.won(t.total)}원 = 원화 청구 ${fmt.won(t.krw)}원 + 외화 청구 ${fmt.usd(t.usd)}의 원화 환산액.</p></section>`);

      // 6. 운영 지표
      const pg = [...groups.place].sort((a, b) => b.bl - a.bl);
      html.push(`<section class="rpt-sec">${H('배정 장소 · 운영 지표')}<div class="rpt-two">
        ${table([{ l: '배정 장소', v: (g) => esc(X.placeName(g.key)) }, n('B/L', 'bl'), n('TEU', 'teu'), share(t, 'bl', 'B/L 비중')], pg)}
        ${table([{ l: '구분', v: (x) => x[0] }, { l: '건수', r: true, v: (x) => fmt.int(x[1]) }, { l: '비율', r: true, v: (x) => fmt.pct(x[1], t.bl) }], [
          ['환적 (T/S)', t.ts], ['비환적', t.bl - t.ts], ['특송', t.ex], ['비특송', t.bl - t.ex], ['운임 Prepaid', t.prepaid], ['운임 Collect', t.bl - t.prepaid],
          ['Notify 지정', t.withNotify],
        ])}</div></section>`);

      // 7. B/L 상세
      if (list) {
        html.push(`<section class="rpt-sec flow">${H(`B/L 상세 목록 (${fmt.int(list.length)}건)`)}
          ${table([
            { l: 'B/L NO', v: (r) => esc(r.bl) }, { l: '항차', v: (r) => esc(r.voy) }, { l: '입항일', v: (r) => r.date || '' },
            cfg.type === 'company' && cfg.basis === 'consignee' ? { l: 'Notify', v: (r) => (r.notify === X.NONE ? '–' : esc(X.notifyName(r.notify))) } : { l: 'Consignee', v: (r) => esc(X.consigneeName(r.consignee)) },
            { l: 'ITEM', v: (r) => esc(r.item) }, { l: '화물', v: (r) => X.CARGO[r.cargo] || esc(r.cargo) },
            { l: 'TEU', r: true, v: (r) => fmt.int(r.teu) }, { l: '중량(톤)', r: true, v: (r) => fmt.ton(r.weight) },
            { l: '총 청구액(원)', r: true, v: (r) => fmt.won(r.total) },
          ], list)}</section>`);
      }
    }

    disposeCharts();
    $('report-doc').innerHTML = html.join('');
    $('report-title').textContent = title;
    $('report-root').hidden = false;
    $('toast').hidden = true;
    document.body.classList.add('reporting');
    document.body.style.overflow = 'hidden';
    openReport.prevTitle = openReport.prevTitle || document.title;
    document.title = `${title} (${X.periodLabel(s.from, s.to).replace(/[()]/g, '')})`; // PDF 기본 파일명

    if (t.bl) {
      mountChart('rc-trend', X.chartOptions.trend(trendMode === 'month' ? groups.month : groups.voyage, trendMode, 'teu', { static: true }), trendMode === 'voyage' ? 300 : 230);
      const cargo = [...groups.cargo].sort((a, b) => b.bl - a.bl).map((g) => ({ name: `${X.CARGO[g.key] || g.key || '(없음)'}`, value: g.bl }));
      mountChart('rc-cargo', X.chartOptions.donut(cargo, { static: true }), 150);
      const rfT = X.reeferSummary(S, 'teu');
      if (X.reeferSummary(S, 'bl').reefer) {
        mountChart('rc-reefer', X.chartOptions.donut(rfT.parts.filter((p) => p.value > 0), { static: true, unit: 'TEU' }), 170);
        mountChart('rc-reefer-top', X.chartOptions.rankBar(X.reeferTop(S), 'teu', { static: true, labelWidth: 180 }), 260);
      }
      Object.keys(X.SUBSETS).forEach((k) => {
        mountChart(`rc-${k}`, X.chartOptions.shareTrend(trendMode === 'month' ? groups.month : groups.voyage, trendMode, k, { static: true }), 230);
        mountChart(`rc-${k}-top`, X.chartOptions.rankBar(X.subsetTop(S, X.SUBSETS[k].dim), 'teu', { static: true, labelWidth: 180 }), 260);
      });
    }
    $('report-root').scrollTop = 0;
  }

  function disposeCharts() { while (reportCharts.length) reportCharts.pop().dispose(); }
  function closeReport() {
    disposeCharts();
    $('report-root').hidden = true;
    $('report-doc').innerHTML = '';
    document.body.classList.remove('reporting');
    document.body.style.overflow = '';
    if (openReport.prevTitle) { document.title = openReport.prevTitle; openReport.prevTitle = null; }
  }
  $('report-close').addEventListener('click', closeReport);
  $('report-print').addEventListener('click', () => window.print());
});
