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
      if (!(my === hintSeq && t.bl)) return;
      const n = Math.min(t.bl, X.DETAIL_MAX);
      $('rm-detail-hint').textContent = t.bl > X.DETAIL_MAX
        ? `(${fmt.int(t.bl)}건 중 입항일 순 앞의 ${fmt.int(n)}건만, 약 ${Math.ceil(n / 38)}쪽 추가)`
        : `(${fmt.int(t.bl)}건, 약 ${Math.max(1, Math.ceil(n / 38))}쪽 추가)`;
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
  segInit($('rm-basis'), [['consignee', X.cAx()], ['notify', X.nAx()]], () => cfg.basis, (v) => { cfg.basis = v; cfg.company = null; });
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
  // dir = 화면에서 고른 수입 · 수출 · 전체를 그대로 따른다
  const EMPTY_FILTER = { consignee: [], notify: [], companyMode: 'and', items: [], cargo: [], bt: [], ts: 'all', ex: 'all', ft: 'all', rf: 'all', dir: X.state.dir };
  const IO = X.state.dir !== 'IN'; // 수출 · 전체 보고서
  const dirPrefix = IO ? `${X.DIRS[X.state.dir]} ` : '';

  function reportScope() {
    const r = reportScopeBase();
    r.title = dirPrefix + r.title;
    return r;
  }
  function reportScopeBase() {
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
      title = `${cfg.company == null ? '' : X.companyName(cfg.basis, cfg.company)} 물류 실적 보고서`; kind = `업체별 보고서 (${cfg.basis === 'notify' ? X.nAx() : X.cAx()} 기준)`;
    } else {
      s = structuredClone(X.state);
      title = '물류 현황 보고서'; kind = '조회 조건 보고서';
    }
    return { s, title, kind };
  }

  // ── 렌더링 도우미 ─────────────────────────────
  const reportCharts = [];
  function table(cols, rows, footRow, cls = '') {
    return `<table class="rpt ${cls}"><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}">${c.l}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => `<tr>${cols.map((c) => `<td class="${c.r ? 'r' : ''}">${c.v(r, i)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}">해당 데이터 없음</td></tr>`}</tbody>
      ${footRow ? `<tfoot><tr>${cols.map((c, i) => `<td class="${c.r ? 'r' : ''}">${i === 0 ? '합계' : c.foot ? c.foot(footRow) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table>`;
  }
  const n = (l, key, f = fmt.int) => ({ l, r: true, v: (g) => f(g[key]), foot: (t) => f(t[key]) });
  const share = (t, key = 'teu', l = 'TEU 비중') => ({ l, r: true, v: (g) => fmt.pct(g[key], t[key]), foot: () => (t[key] ? '100.0%' : '–') });
  // 실적 표 공통 칸 (중량 · CBM · 총 청구액은 넣지 않음, 사용자 확정). cntr = TEU 앞에 컨테이너 규격별 개수
  const cntrCols = () => X.cntrCols(X.state.dir).map(([l, f]) => ({ l, r: true, v: (g) => fmt.int(f(g)), foot: (x) => fmt.int(f(x)) }));
  const volumeCols = (t, cntr = false) => [n('B/L', 'bl'), ...(cntr ? cntrCols() : []), n('TEU', 'teu'), share(t)];
  // B/L 상세 목록의 업체명: 한 줄에 들어가도록 "주식회사 · (주)"를 빼고, 그래도 길면 … 으로 줄인다
  const cut = (name) => `<span class="cut">${esc(X.shortName(name))}</span>`;
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
        cfg.detail ? X.fetchDetail(s, { sort: 'date', dir: 'asc', limit: X.DETAIL_MAX, offset: 0 }) : null,
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
    // 기간 안의 데이터가 한 달 이하면 항차별(월별은 막대 1개뿐). 2개월 이상이면 현재 조회 화면 보고서는 화면의 물동량 추이 선택(월별 · 항차별), 나머지는 월별
    const trendMode = months.length <= 1 ? 'voyage' : cfg.type === 'current' && s.trend === 'voyage' ? 'voyage' : 'month';
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
        <dt>산정 기준</dt><dd>${IO
          ? "TEU = 20'×1 + 40'×2 + 45'×2 (수출은 20RF · 40RF 포함, B/L Type E 는 0) · 금액: 수입 Collect, 수출 Prepaid + Collect · 한국 금액 = 수입 CC + 수출 PP, 중국 금액 = 수출 CC (수입 PP 미집계)"
          : "TEU = 20'×1 + 40'×2 + 45'×2 · 금액은 Collect 기준"}</dd>
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
          ...cntrCols(),
          ...volumeCols(t),
          { l: `선복 대비 (${X.SHIP_CAP}TEU)`, r: true, v: (g) => X.capPct(g), foot: (x) => X.capPct(x) },
        ], tg, t)}
        <p class="rpt-note">${esc(X.trendNote(X.state.dir))} 선복 대비 = TEU ÷ (항차 수 × ${X.SHIP_CAP}TEU, 실무 최대 선적량 · 이론 313TEU).</p></section>`);

      // 3. 업체
      if (cfg.type === 'company') {
        const other = cfg.basis === 'consignee' ? 'notify' : 'consignee';
        const og = X.topCompanies(groups[other], other, 'teu', 15, true);
        html.push(`<section class="rpt-sec">${H(`${other === 'notify' ? X.nAx() : X.cAx()}별 구성`)}
          ${table([{ l: '업체', v: (g) => esc(g.full) }, ...volumeCols(t, true)], og)}</section>`);
      } else {
        const tc = X.topCompanies(groups.consignee, 'consignee', 'teu', 15);
        const tn = X.topCompanies(groups.notify, 'notify', 'teu', 10);
        const ca = X.cAx(), na = X.nAx();
        html.push(`<section class="rpt-sec">${H(`${ca} 상위 15 (TEU 기준)`)}
          ${table([{ l: '순위', r: true, v: (g, i) => i + 1 }, { l: ca, v: (g) => esc(g.full) }, { l: '사업자번호', v: (g) => esc(X.consigneeCode(g.key)) }, ...volumeCols(t, true)], tc)}
          <p class="rpt-note">조회 대상 ${ca} ${fmt.int(t.companies)}곳 중 상위 15곳. 상위 15곳 합계 TEU 비중 ${fmt.pct(tc.reduce((a, g) => a + g.teu, 0), t.teu)}.</p></section>`);
        html.push(`<section class="rpt-sec">${H(`${na} 상위 10 (TEU 기준)`)}
          ${table([{ l: '순위', r: true, v: (g, i) => i + 1 }, { l: na, v: (g) => esc(g.full) }, ...volumeCols(t, true)], tn)}
          <p class="rpt-note">${na}가 지정되지 않은 B/L ${fmt.int(t.bl - t.withNotify)}건은 제외했습니다.</p></section>`);
      }

      // 4. ITEM · 화물 종류
      const ig = [...groups.item].sort((a, b) => b.teu - a.teu || b.bl - a.bl);
      const cg = [...groups.cargo].sort((a, b) => b.teu - a.teu || b.bl - a.bl);
      html.push(`<section class="rpt-sec">${H('ITEM · 화물 종류별 실적')}<div class="rpt-two">
        ${table([{ l: 'ITEM', v: (g) => esc(g.key || '(없음)') }, n('B/L', 'bl'), n('TEU', 'teu'), share(t)], ig, t)}
        <div>${table([{ l: '화물 종류', v: (g) => `${X.CARGO[g.key] || g.key || '(없음)'} (${esc(g.key)})` }, n('B/L', 'bl'), n('TEU', 'teu'), share(t)], cg, t)}
        ${chartBlock('rc-cargo')}</div></div></section>`);

      // 냉동 (선어 · 활어 포함) · 환적 · 특송: 구성(도넛) → 월(항차)별 TEU · 증감률 · 점유율(막대) → Consignee 상위 10
      const subRows = (trendMode === 'month' ? months : groups.voyage.filter((g) => g.key !== X.NONE)).sort(byDate);
      const by = trendMode === 'month' ? '월별' : '항차별', prevWord = trendMode === 'month' ? '전월' : '직전 항차';
      const pct1 = (a, b) => (b ? `${fmt.one((a / b) * 100)}%` : '–');
      const rfT = X.reeferSummary(S, 'teu'), rfB = X.reeferSummary(S, 'bl');
      const KINDS = [
        { k: 'rf', name: '냉동', note: X.rfNote(), bl: rfB.reefer, teu: rfT.reefer, top: X.reeferTop(S), dim: 'reeferConsignee',
          parts: rfT.parts.map((p) => ({ name: p.name, bl: p.bl, teu: p.teu })),
          cols: [...X.RF_TEU.map(([key, l]) => ({ l, get: (g) => Number(g[key]) || 0 })), { l: '냉동 합계', get: (g) => X.RF_TEU.reduce((a, [key]) => a + (Number(g[key]) || 0), 0) }],
          remark: { IN: 'B/L 번호에 E12 가 있으면 냉동, 그중 REMARK 에 선어 · 활어가 있으면 선어 · 활어로 나눴습니다.',
            OUT: '수출은 20RF · 40RF 수량이 있는 B/L 을 냉동으로 봅니다.',
            ALL: '수입은 B/L 번호 E12(REMARK 선어 · 활어 구분), 수출은 20RF · 40RF 수량이 있는 B/L 을 냉동으로 봅니다.' }[X.state.dir] },
        ...Object.entries(X.SUBSETS).filter(([k]) => !(k === 'ex' && X.state.dir === 'OUT')).map(([k, d]) => {
          const ps = X.subsetParts(k, t); // 특송 = 도착지 4곳 (예전 SQL 이면 null → 특송 · 비특송)
          return {
            k, name: d.name, note: d.note, bl: Number(t[d.blKey]) || 0, teu: Number(t[d.teuKey]) || 0, top: X.subsetTop(S, d.dim), dim: d.dim,
            parts: ps
              ? ps.map(([key, name]) => ({ name, bl: Number(t[`${key}Bl`]) || 0, teu: Number(t[key]) || 0 }))
              : [{ name: d.name, bl: Number(t[d.blKey]) || 0, teu: Number(t[d.teuKey]) || 0 }, { name: `비${d.name}`, bl: t.bl - (Number(t[d.blKey]) || 0), teu: t.teu - (Number(t[d.teuKey]) || 0) }],
            cols: ps
              ? [...ps.map(([key, l]) => ({ l, get: (g) => Number(g[key]) || 0 })), { l: `${d.name} 합계`, get: (g) => ps.reduce((a, [key]) => a + (Number(g[key]) || 0), 0) }]
              : [{ l: `${d.name} B/L`, get: (g) => Number(g[d.blKey]) || 0 }, { l: `${d.name} TEU`, get: (g) => Number(g[d.teuKey]) || 0 }],
            remark: ps ? '도착지: REMARK 에 인천 · 부산이 있으면 그곳, ACT 자가 장치장 목록에 있으면 ACT자가, 나머지는 평택으로 나눴습니다.' : '',
          };
        }),
      ];
      KINDS.forEach((c) => {
        if (!c.bl) {
          html.push(`<section class="rpt-sec">${H(`${c.name} 화물 (${c.note})`)}<p class="rpt-note">선택한 조건에 해당하는 ${c.name} B/L 이 없습니다.</p></section>`);
          return;
        }
        // 구성: 냉동은 냉동 · 선어 · 활어, 특송은 도착지 4곳 안의 비중, 환적은 전체 중 환적 · 비환적 비중
        const pSum = { bl: c.parts.reduce((a, p) => a + p.bl, 0), teu: c.parts.reduce((a, p) => a + p.teu, 0) };
        html.push(`<section class="rpt-sec">${H(`${c.name} 화물 (${c.note}) · 구성`)}<div class="rpt-two">
          <div>${table([{ l: '구분', v: (g) => g.name }, n('B/L', 'bl'), share(pSum, 'bl', 'B/L 비중'), n('TEU', 'teu'), share(pSum, 'teu', 'TEU 비중')], c.parts, pSum)}
          <p class="rpt-note">전체 대비 ${c.name} 비중: TEU ${fmt.int(c.teu)} / ${fmt.int(t.teu)} (${fmt.pct(c.teu, t.teu)}) · B/L ${fmt.int(c.bl)} / ${fmt.int(t.bl)}건 (${fmt.pct(c.bl, t.bl)}).
          ${c.remark}</p></div>
          ${chartBlock(`rc-${c.k}-donut`)}</div></section>`);
        // 월(항차)별: 증감률 · 점유율 기준은 해당 TEU (마지막 열)
        const val = c.cols[c.cols.length - 1].get;
        const subSum = (f) => subRows.reduce((a, g) => a + f(g), 0);
        html.push(`<section class="rpt-sec flow">${H(`${c.name} 화물 · ${by} TEU · 점유율`)}${chartBlock(`rc-${c.k}`)}
          ${table([
            trendMode === 'month' ? { l: '월', v: (g) => X.monthLabel(g.key) } : { l: '항차', v: (g) => esc(g.key) },
            ...(trendMode === 'voyage' ? [{ l: '입항일', v: (g) => g.date || '' }] : []),
            ...c.cols.map((col) => ({ l: col.l, r: true, v: (g) => fmt.int(col.get(g)), foot: () => fmt.int(subSum(col.get)) })),
            { l: '전체 TEU', r: true, v: (g) => fmt.int(g.teu), foot: () => fmt.int(t.teu) },
            { l: `증감률 (${prevWord} 대비)`, r: true, v: (g, i) => X.rate(val(g), i ? val(subRows[i - 1]) : null) },
            { l: '점유율', r: true, v: (g) => pct1(val(g), g.teu), foot: () => pct1(subSum(val), t.teu) },
          ], subRows, t)}
          <p class="rpt-note">증감률 = ${c.name} TEU 의 ${prevWord} 대비 증감. 점유율 = 그 ${trendMode === 'month' ? '월' : '항차'}의 전체 TEU 중 ${c.name} TEU.</p></section>`);
        html.push(`<section class="rpt-sec">${H(`${c.name} ${X.cAx()} 상위 10 (TEU 기준)`)}${chartBlock(`rc-${c.k}-top`)}
          ${table([{ l: '순위', r: true, v: (g, i) => i + 1 }, { l: X.cAx(), v: (g) => esc(g.full) }, { l: '사업자번호', v: (g) => esc(X.consigneeCode(g.key)) },
            n('B/L', 'bl'), n('TEU', 'teu'), { l: `${c.name} TEU 비중`, r: true, v: (g) => fmt.pct(g.teu, c.teu) }], c.top)}
          <p class="rpt-note">${c.name} ${X.cAx()} ${fmt.int((S.groups[c.dim] || []).length)}곳 중 상위 10곳. 상위 10곳 합계 ${c.name} TEU 비중 ${fmt.pct(c.top.reduce((a, g) => a + g.teu, 0), c.teu)}.</p></section>`);
      });

      // 5. 청구 항목 (수출이 섞이면 원화에 CFS 포함)
      const krw = (IO ? [...X.KRW_CHARGES, 'CFS'] : X.KRW_CHARGES).map((k) => ({ k, v: t[k] || 0 })).sort((a, b) => b.v - a.v);
      const usd = X.USD_CHARGES.map((k) => ({ k, v: t[k] })).sort((a, b) => b.v - a.v);
      const chargeBasis = { IN: 'Collect', OUT: 'Prepaid · Collect', ALL: '수입 Collect + 수출 Prepaid · Collect' }[X.state.dir];
      html.push(`<section class="rpt-sec">${H(`청구 항목 구성 (${chargeBasis})`)}<div class="rpt-two">
        ${table([{ l: '원화 항목', v: (x) => x.k }, { l: '금액(원)', r: true, v: (x) => fmt.won(x.v), foot: () => fmt.won(t.krw) }, { l: '비중', r: true, v: (x) => fmt.pct(x.v, t.krw), foot: () => '100.0%' }], krw, t)}
        ${table([{ l: '외화 항목', v: (x) => x.k }, { l: '금액(USD)', r: true, v: (x) => fmt.usd(x.v), foot: () => fmt.usd(t.usd) }, { l: '비중', r: true, v: (x) => fmt.pct(x.v, t.usd), foot: () => '100.0%' }], usd, t)}
        </div><p class="rpt-note">총 청구액 ${fmt.won(t.total)}원 = 원화 청구 ${fmt.won(t.krw)}원 + 외화 청구 ${fmt.usd(t.usd)}의 원화 환산액.</p></section>`);

      // 수출 · 전체: 한국 · 중국 금액, 공컨 이송
      if (IO) {
        const kr = (g) => (g.krIn || 0) + (g.krOut || 0);
        const m = (key) => ({ l: '', r: true, v: (g) => fmt.mil(g[key]), foot: (x) => fmt.mil(x[key]) });
        html.push(`<section class="rpt-sec flow">${H(`한국 · 중국 금액 (${by})`)}${chartBlock('rc-money')}
          ${table([
            trendMode === 'month' ? { l: '월', v: (g) => X.monthLabel(g.key) } : { l: '항차', v: (g) => esc(g.key) },
            { ...m('krIn'), l: '한국 · 수입 CC' }, { ...m('krOut'), l: '한국 · 수출 PP' },
            { l: '한국 합계', r: true, v: (g) => fmt.mil(kr(g)), foot: (x) => fmt.mil(kr(x)) }, { ...m('cnOut'), l: '중국 · 수출 CC' },
          ], subRows, t)}
          <p class="rpt-note">금액 단위 백만원. 한국 금액 = 수입 Collect + 수출 Prepaid, 중국 금액 = 수출 Collect (수입 Prepaid 는 저장하지 않아 미집계).</p></section>`);
        // 공컨 이송: 종류 · 사이즈별로 쌓은 막대(위 = 총 TEU, 점선 = 평균) + 기간 · 컨테이너 종류 · TEU · 증감률 표
        const mtRowsBy = X.mtGroups(trendMode === 'month' ? groups.month : groups.voyage, trendMode);
        if (t.mtTeu > 0) {
          const types = X.MT_TYPES; // 수량이 0 인 종류도 열은 보여 준다
          const mtPrev = trendMode === 'month' ? '전월' : '직전 항차';
          html.push(`<section class="rpt-sec flow">${H(`공컨 이송 (${by})`)}${chartBlock('rc-mt')}
            ${table([
              trendMode === 'month' ? { l: '월', v: (g) => X.monthLabel(g.key) } : { l: '항차', v: (g) => esc(g.key) },
              ...(trendMode === 'voyage' ? [{ l: '입항일', v: (g) => g.date || '' }] : []),
              ...types.map(([k, name]) => n(name.replace(' (냉동)', ''), k)),
              { l: 'TEU', r: true, v: (g) => `<b>${fmt.int(g.mtTeu)}</b>`, foot: (x) => fmt.int(x.mtTeu) },
              { l: `증감률 (${mtPrev} 대비)`, r: true, v: (g, i) => X.rate(g.mtTeu, i ? mtRowsBy[i - 1].mtTeu : null) },
            ], mtRowsBy, t)}
            <p class="rpt-note">공컨 이송 = 수출 B/L Type E · 끝 번호 1000 (물동량 TEU 에는 미포함) · B/L ${fmt.int(t.mtBl)}건 · 컨테이너 ${fmt.int(t.mtCntr)}개.
            TEU = 20' · 20RF ×1 + 40' · 40RF · 45' ×2. 점선 = 기간 평균 TEU.</p></section>`);
        }
        // 공컨 이송 종류 · 사이즈별 구성
        const mtRows = X.MT_TYPES.map(([k, name, w]) => ({ name, cnt: t[k] || 0, teu: (t[k] || 0) * w })); // 0 인 종류도 줄은 보여 준다
        if (t.mtTeu > 0) {
          const mtSum = { cnt: mtRows.reduce((a, r) => a + r.cnt, 0), teu: t.mtTeu };
          html.push(`<section class="rpt-sec">${H('공컨 이송 · 컨테이너 종류 · 사이즈별 구성')}<div class="rpt-two">
            ${table([{ l: '종류 · 사이즈', v: (r) => r.name }, n('개수', 'cnt'), n('TEU', 'teu'), { l: 'TEU 비율', r: true, v: (r) => fmt.pct(r.teu, mtSum.teu), foot: () => '100.0%' }], mtRows, mtSum)}
            ${chartBlock('rc-mt-donut')}</div></section>`);
        }
      }

      // 6. 운영 지표 (배정 장소는 수입만)
      const pg = [...groups.place].sort((a, b) => b.bl - a.bl);
      html.push(`<section class="rpt-sec">${H(IO ? '운영 지표' : '배정 장소 · 운영 지표')}<div class="rpt-two">
        ${IO ? '' : table([{ l: '배정 장소', v: (g) => esc(X.placeName(g.key)) }, n('B/L', 'bl'), n('TEU', 'teu'), share(t, 'bl', 'B/L 비중')], pg)}
        ${table([{ l: '구분', v: (x) => x[0] }, { l: '건수', r: true, v: (x) => fmt.int(x[1]) }, { l: '비율', r: true, v: (x) => fmt.pct(x[1], t.bl) }], [
          ['환적 (T/S)', t.ts], ['비환적', t.bl - t.ts], ...(X.state.dir === 'OUT' ? [] : [['특송', t.ex], ['비특송', t.bl - t.ex]]), ['운임 Prepaid', t.prepaid], ['운임 Collect', t.bl - t.prepaid],
          [`${X.nAx()} 지정`, t.withNotify],
        ])}</div></section>`);

      // 7. B/L 상세
      if (list) {
        const cutNote = list.total > list.rows.length
          ? `<p class="rpt-note">전체 ${fmt.int(list.total)}건 중 입항일 순으로 앞의 ${fmt.int(list.rows.length)}건만 수록했습니다. 나머지는 기간을 나눠 보고서를 만드세요.</p>` : '';
        html.push(`<section class="rpt-sec flow">${H(`B/L 상세 목록 (${fmt.int(list.rows.length)}건${list.total > list.rows.length ? ` / 전체 ${fmt.int(list.total)}건` : ''})`)}${cutNote}
          ${table([
            { l: 'No', r: true, v: (r, i) => fmt.int(i + 1) },
            { l: '입항일', v: (r) => r.date || '' }, { l: 'B/L NO', v: (r) => esc(r.bl) },
            ...(X.state.dir === 'ALL' ? [{ l: '구분', v: (r) => (r.io === 'OUT' ? '수출' : '수입') }] : []),
            { l: X.cAx(), v: (r) => cut(X.consigneeName(r.consignee)) },
            { l: X.nAx(), v: (r) => (r.notify === X.NONE ? '–' : cut(X.notifyName(r.notify))) },
            { l: 'ITEM', v: (r) => esc(r.item) },
            { l: "20'", r: true, v: (r) => fmt.int(r.c20) }, { l: "40'", r: true, v: (r) => fmt.int(r.c40) }, { l: "45'", r: true, v: (r) => fmt.int(r.c45) },
            { l: 'TEU', r: true, v: (r) => fmt.int(r.teu) },
            { l: '총 청구액(원)', r: true, v: (r) => fmt.won(r.total) },
          ], list.rows, null, 'detail')}
          <p class="rpt-note">업체명은 "주식회사 · (주)"를 빼고, 길면 줄여서 표시했습니다.</p></section>`);
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
      // 화물 종류 도넛 = TEU 구성 (표의 TEU 비중과 같음, TEU 0 인 종류는 뺌)
      const cargo = [...groups.cargo].sort((a, b) => b.teu - a.teu).filter((g) => g.teu > 0).map((g) => ({ name: `${X.CARGO[g.key] || g.key || '(없음)'}`, value: g.teu }));
      mountChart('rc-cargo', X.chartOptions.donut(cargo, { static: true, unit: 'TEU' }), 150);
      // 냉동 · 환적 · 특송: 도넛 · 막대 · 상위 10 (해당 B/L 이 없으면 본문에 차트 자리가 없어 그리지 않는다)
      const rfParts = X.reeferSummary(S, 'teu').parts;
      if (IO) mountChart('rc-money', X.chartOptions.money(trendMode === 'month' ? groups.month : groups.voyage, trendMode, { static: true }), 230);
      if (IO) {
        mountChart('rc-mt', X.chartOptions.empties(trendMode === 'month' ? groups.month : groups.voyage, trendMode, { static: true }), 230);
        const mt = X.MT_TYPES.filter(([k]) => t[k] > 0);
        mountChart('rc-mt-donut', X.chartOptions.donut(mt.map(([k, name, w]) => ({ name, value: t[k] * w })), { static: true, unit: 'TEU', colors: mt.map((x) => x[3]) }), 170);
      }
      [['rf', rfParts, X.RF_TEU.map((x) => x[2])],
        ...Object.keys(X.SUBSETS).filter((k) => !(k === 'ex' && X.state.dir === 'OUT')).map((k) => { const dn = X.subsetDonut(S, k); return [k, dn.entries, dn.colors]; }),
      ].forEach(([k, parts, colors]) => {
        // 색은 항목에 붙인 뒤 0 인 항목을 뺀다 (색 순서가 어긋나지 않게)
        const entries = parts.map((p, i) => ({ ...p, itemStyle: { color: colors[i] } })).filter((p) => p.value > 0);
        mountChart(`rc-${k}-donut`, X.chartOptions.donut(entries, { static: true, unit: 'TEU', colors }), 170);
        mountChart(`rc-${k}`, X.chartOptions.shareTrend(trendMode === 'month' ? groups.month : groups.voyage, trendMode, k, { static: true }), 230);
        mountChart(`rc-${k}-top`, X.chartOptions.rankBar(k === 'rf' ? X.reeferTop(S) : X.subsetTop(S, X.SUBSETS[k].dim), 'teu', { static: true, labelWidth: 180 }), 260);
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
