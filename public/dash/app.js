/* 선사 물류 대시보드 — 조회 조건(state) → Supabase 집계(dash_summary) → 차트/표 렌더링의 단방향 흐름.
   집계는 서버(supabase/dashboard.sql)가 하고 화면은 결과만 그린다. 데이터가 몇 년 치로 늘어도 받는 양은 거의 같다.
   report.js 는 'dash:ready' 이벤트 뒤에 window.Dash 로 공개된 함수를 재사용한다. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = window.DashApi;

  // ── 상수 · 코드표 ─────────────────────────────
  const CARGO = { F: 'FCL', L: 'LCL', E: 'Empty', B: 'Bulk' };
  const BT = { C: '콘솔', S: '심플', X: '특송', E: '엠티' }; // B/L Type
  // Collect TTL = 원화 항목 + USD 항목 × 적용환율 (ESC 는 USD 항목)
  const KRW_CHARGES = ['THC', 'DOC', 'WFG', 'CCF', 'TSF', 'PSC'];
  const USD_CHARGES = ['FRT', 'BAF', 'CAF', 'CRS', 'LSS', 'PSS', 'ESC'];
  const SUM_KEYS = ['bl', 'c20', 'c40', 'c45', 'teu', 'cntr', 'pkg', 'weight', 'cbm', 'krw', 'usd', 'total', 'ts', 'ex', 'prepaid', 'withNotify'];
  const GROUP_DIMS = ['month', 'voyage', 'consignee', 'notify', 'item', 'cargo', 'place'];
  const NONE = ''; // 값 없음: (Notify 없음) · (미지정) 등
  const COLORS = {
    navy900: '#13243b', navy700: '#1f3a5f', navy500: '#456789', navy300: '#9fb3c8', navy100: '#e5ecf3',
    gold: '#a8842c', ink: '#1b2532', muted: '#5d6a79', faint: '#8995a2', line: '#dbe1e8',
  };
  const PALETTE = ['#1f3a5f', '#5b7fa6', '#a8842c', '#9fb3c8', '#6f7f8f', '#c9b27a', '#3d5a50', '#b9c4cf'];
  const FONT = '"Noto Sans KR", "Malgun Gothic", sans-serif';

  // dash_meta() · dash_options() 결과 (boot 에서 채움)
  let META = null;
  let MONTHS = [], YEARS = [];
  const COMPANIES = new Map(); // 사업자번호(키) → { code, name, n }
  let NOTIFIES = [];           // [[이름(''=없음), B/L 수]]

  const consigneeName = (k) => (k === NONE ? '(Consignee 없음)' : COMPANIES.get(k)?.name || k);
  const consigneeCode = (k) => (k === NONE ? '' : COMPANIES.get(k)?.code || '');
  const notifyName = (k) => (k === NONE ? '(Notify 없음)' : k);
  const companyName = (basis, k) => (basis === 'notify' ? notifyName(k) : consigneeName(k));
  const shortName = (n) => n.replace(/주식회사|\(주\)|㈜/g, '').replace(/\s+/g, ' ').trim() || n;
  const placeName = (k) => (k === NONE ? '(미지정)' : k);
  const btName = (k) => (k === NONE ? '(없음)' : BT[k] ? `${k} (${BT[k]})` : k);
  const vesselLabel = () => (META.vessels.length ? META.vessels.join(', ') : '선사');

  // ── 포맷 ────────────────────────────────────
  const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt = {
    int: (n) => nf0.format(n || 0),
    one: (n) => nf1.format(n || 0),
    ton: (kg) => nf1.format((kg || 0) / 1000),
    mil: (won) => nf1.format((won || 0) / 1e6),
    won: (n) => nf0.format(n || 0),
    usd: (n) => '$' + nf0.format(n || 0),
    pct: (a, b) => (b ? nf1.format((a / b) * 100) + '%' : '–'),
  };
  const METRICS = {
    teu: { label: 'TEU', unit: 'TEU', get: (t) => t.teu, fmt: fmt.int },
    bl: { label: 'B/L 건수', unit: '건', get: (t) => t.bl, fmt: fmt.int },
    weight: { label: '중량', unit: '톤', get: (t) => t.weight / 1000, fmt: fmt.one },
    total: { label: '총 청구액', unit: '백만원', get: (t) => t.total / 1e6, fmt: fmt.one },
  };

  // ── 날짜 ────────────────────────────────────
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monthRange = (ym) => { const [y, m] = ym.split('-').map(Number); return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }; };
  const yearRange = (y) => ({ from: `${y}-01-01`, to: `${y}-12-31` });
  const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${y}년 ${+m}월`; };
  /** 축 눈금: 한 해만 있으면 '4월', 여러 해면 '26.04' */
  const monthTicks = (keys) => {
    const oneYear = new Set(keys.map((k) => k.slice(0, 4))).size <= 1;
    return keys.map((k) => (oneYear ? `${+k.slice(5)}월` : `${k.slice(2, 4)}.${k.slice(5)}`));
  };

  function periodLabel(from, to) {
    if (!from && !to) return `전체 기간 (${META.dateMin} ~ ${META.dateMax})`;
    if (from && to) {
      const f = parse(from), t = parse(to);
      if (f.getDate() === 1 && addDays(t, 1).getDate() === 1) {
        if (from.slice(0, 7) === to.slice(0, 7)) return monthLabel(from.slice(0, 7));
        if (from.endsWith('-01-01') && to.endsWith('-12-31') && from.slice(0, 4) === to.slice(0, 4)) return `${from.slice(0, 4)}년`;
        return `${monthLabel(from.slice(0, 7))} ~ ${monthLabel(to.slice(0, 7))}`;
      }
    }
    return `${from || META.dateMin} ~ ${to || META.dateMax}`;
  }

  /** 비교 기간: 달 단위 범위면 직전 같은 개월 수, 아니면 직전 같은 일수. 데이터가 없는 구간이면 available=false. */
  function compareRange(from, to) {
    if (!from || !to) return null;
    const f = parse(from), t = parse(to);
    let range;
    if (f.getDate() === 1 && addDays(t, 1).getDate() === 1) {
      const months = (t.getFullYear() - f.getFullYear()) * 12 + t.getMonth() - f.getMonth() + 1;
      range = {
        from: iso(new Date(f.getFullYear(), f.getMonth() - months, 1)),
        to: iso(new Date(f.getFullYear(), f.getMonth(), 0)),
        label: months === 1 ? '전월 대비' : months === 12 ? '전년 대비' : `직전 ${months}개월 대비`,
      };
    } else {
      const days = Math.round((t - f) / 864e5) + 1;
      range = { from: iso(addDays(f, -days)), to: iso(addDays(f, -1)), label: `직전 ${days}일 대비` };
    }
    // 데이터 첫 입항일이 속한 달의 1일부터는 비교 가능한 것으로 본다(1일에 입항이 없었을 뿐 그 달 전체가 포함됨).
    range.available = !!META.dateMin && range.from >= META.dateMin.slice(0, 8) + '01';
    return range;
  }

  // ── 상태 ────────────────────────────────────
  const DEFAULT_STATE = {
    from: '', to: '', consignee: [], notify: [], companyMode: 'and',
    items: [], cargo: [], bt: [], ts: 'all', ex: 'all', ft: 'all',
    groupBy: 'consignee', metric: 'teu', trend: 'month', charge: 'krw', tab: 'company',
  };
  const state = loadHash();
  const view = { search: '', page: 1, sort: {}, qc: null };

  function loadHash() {
    const s = structuredClone(DEFAULT_STATE);
    try {
      const raw = decodeURIComponent(location.hash.slice(1));
      if (raw.startsWith('{')) {
        const h = JSON.parse(raw);
        for (const k of Object.keys(s)) {
          if (!(k in h) || typeof h[k] !== typeof s[k]) continue;
          s[k] = Array.isArray(s[k]) ? (Array.isArray(h[k]) ? h[k].filter((v) => typeof v === 'string') : s[k]) : h[k];
        }
      }
    } catch { /* 잘못된 해시는 무시 */ }
    return s;
  }
  function saveHash() {
    const diff = {};
    for (const k of Object.keys(DEFAULT_STATE)) {
      if (JSON.stringify(state[k]) !== JSON.stringify(DEFAULT_STATE[k])) diff[k] = state[k];
    }
    const h = Object.keys(diff).length ? '#' + encodeURIComponent(JSON.stringify(diff)) : ' ';
    history.replaceState(null, '', h === ' ' ? location.pathname + location.search : h);
  }

  // ── 서버 조회 ────────────────────────────────
  /** 조회 조건 → RPC 인자 f. range 를 주면 기간만 바꾼다(비교 기간). */
  function filterOf(s, range) {
    return {
      from: range ? range.from : s.from, to: range ? range.to : s.to,
      consignee: s.consignee, notify: s.notify, companyMode: s.companyMode,
      items: s.items, cargo: s.cargo, bt: s.bt, ts: s.ts, ex: s.ex, ft: s.ft,
    };
  }
  const zip = (fields, a) => { const o = {}; fields.forEach((f, i) => { o[f] = a[i]; }); return o; };
  function expandSummary(res) {
    const groups = {};
    GROUP_DIMS.forEach((d) => { groups[d] = (res.groups[d] || []).map((a) => zip(res.fields, a)); });
    return { t: res.totals, groups };
  }
  // 같은 조건을 다시 고르면(필터 해제 · 보고서) 서버에 다시 묻지 않는다.
  const cache = new Map();
  function cached(kind, f) {
    const key = kind + JSON.stringify(f);
    if (!cache.has(key)) {
      if (cache.size >= 40) cache.delete(cache.keys().next().value);
      const p = api[kind](f).then((r) => (kind === 'summary' ? expandSummary(r) : r));
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return cache.get(key);
  }
  const fetchSummary = (s) => cached('summary', filterOf(s));
  const fetchTotals = (s, range) => cached('totals', filterOf(s, range));
  async function fetchDetail(s, opt) {
    const res = await api.detail(filterOf(s), opt);
    return { total: res.total, rows: res.rows.map((a) => zip(res.fields, a)) };
  }

  /** 그룹 행 합계(표의 합계 줄) */
  function sumOf(rows) {
    const t = {};
    SUM_KEYS.forEach((k) => { t[k] = 0; });
    rows.forEach((r) => SUM_KEYS.forEach((k) => { t[k] += r[k] || 0; }));
    return t;
  }

  // ── 작은 UI 부품 ─────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function seg(el, options, get, set) {
    el.innerHTML = options.map(([v, l]) => `<button type="button" data-v="${esc(v)}">${esc(l)}</button>`).join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      set(b.dataset.v);
    });
    const sync = () => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === get()));
    sync();
    return sync;
  }

  function toggleIn(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  }

  function multiSelect(el, options, key) {
    el.innerHTML = `<input type="search" placeholder="이름 또는 사업자번호 검색" aria-label="${key} 검색" id="ms-${key}-q"><div class="msel-list"></div><div class="msel-foot"><span></span><span></span></div>`;
    const q = el.querySelector('input'), list = el.querySelector('.msel-list');
    const [footL, footR] = el.querySelectorAll('.msel-foot span');
    footR.textContent = `전체 ${fmt.int(options.length)}곳`;
    const render = () => {
      const term = q.value.trim().toLowerCase();
      const sel = new Set(state[key]);
      const shown = options
        .filter((o) => !term || o.search.includes(term))
        .sort((a, b) => (sel.has(b.value) - sel.has(a.value)) || b.count - a.count)
        .slice(0, 300);
      list.innerHTML = shown.length ? shown.map((o) => `
        <label class="msel-row${sel.has(o.value) ? ' checked' : ''}" title="${esc(o.label)}${o.sub ? ' · ' + esc(o.sub) : ''}">
          <input type="checkbox" value="${esc(o.value)}"${sel.has(o.value) ? ' checked' : ''}>
          <span class="name">${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</span>
          <span class="cnt">${fmt.int(o.count)}</span>
        </label>`).join('') : '<div class="msel-empty">일치하는 업체가 없습니다.</div>';
      footL.textContent = sel.size ? `${sel.size}곳 선택` : '선택 없음 = 전체';
    };
    q.addEventListener('input', render);
    list.addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      toggleIn(state[key], e.target.value);
      update();
    });
    return render;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  let loadingCount = 0;
  function setLoading(on) {
    loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
    $('loadbar').hidden = loadingCount === 0;
    $('main').classList.toggle('is-loading', loadingCount > 0);
  }

  /** 상단 안내: 오류 > 추가 컬럼 없는 B/L 안내 */
  function showNotice(err) {
    const el = $('notice');
    if (err) {
      el.className = 'notice error';
      el.innerHTML = `<b>데이터를 불러오지 못했습니다.</b> ${esc(err.message)} ${err.auth ? '' : '<button type="button" class="btn link" id="btn-retry">다시 시도</button>'}`;
      $('btn-retry')?.addEventListener('click', () => { cache.clear(); update(); });
    } else if (META.noExt) {
      el.className = 'notice';
      el.textContent = `대시보드 설정 이전에 동기화한 B/L ${fmt.int(META.noExt)}건은 중량·CBM·포장·배정장소·운임 지불(F/T)·발행일 정보가 비어 있습니다. ` +
        '운임 필터 탭에서 해당 기간 엑셀을 한 번 더 클라우드 동기화하면 채워집니다.';
    } else {
      el.hidden = true;
      return;
    }
    el.hidden = false;
  }

  function fatal(title, err) {
    $('main').innerHTML = `<div class="fatal"><b>${esc(title)}</b><p>${esc(err?.message || err || '')}</p></div>`;
  }

  // ── 조회 조건 패널 구성 ─────────────────────────
  const syncers = [];

  function buildFilters() {
    // 기간 프리셋: 연도 + (선택한 연도 또는 최근 연도의) 월
    const pe = $('period-presets');
    syncers.push(() => {
      const focus = (state.from || state.to || META.dateMax || '').slice(0, 4);
      const months = MONTHS.filter((m) => m.startsWith(focus));
      const btn = ([f, t, l]) => `<button type="button" data-from="${f}" data-to="${t}" aria-pressed="${f === state.from && t === state.to}">${l}</button>`;
      pe.innerHTML = [['', '', '전체 기간'], ...YEARS.map((y) => [yearRange(y).from, yearRange(y).to, `${y}년`])].map(btn).join('') +
        (YEARS.length > 1 && months.length ? `<span class="presets-label">${focus}년 월별</span>` : '') +
        months.map((m) => [monthRange(m).from, monthRange(m).to, `${+m.slice(5)}월`]).map(btn).join('');
    });
    pe.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.from = b.dataset.from; state.to = b.dataset.to; update();
    });
    const from = $('f-from'), to = $('f-to');
    from.min = to.min = META.dateMin; from.max = to.max = META.dateMax;
    from.addEventListener('change', () => { state.from = from.value; if (state.to && state.from > state.to) state.to = state.from; update(); });
    to.addEventListener('change', () => { state.to = to.value; if (state.from && state.from > state.to) state.from = state.to; update(); });
    syncers.push(() => { from.value = state.from; to.value = state.to; });

    // 업체
    const cOpts = [...COMPANIES].map(([v, c]) => ({ value: v, label: consigneeName(v), sub: c.code, count: c.n }));
    const nOpts = NOTIFIES.map(([v, n]) => ({ value: v, label: notifyName(v), sub: '', count: n }));
    [...cOpts, ...nOpts].forEach((o) => { o.search = (o.label + ' ' + o.sub).toLowerCase(); });
    syncers.push(multiSelect($('ms-consignee'), cOpts, 'consignee'));
    syncers.push(multiSelect($('ms-notify'), nOpts, 'notify'));
    document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { state[b.dataset.clear] = []; update(); }));
    syncers.push(seg($('company-mode'), [['and', '두 조건 모두 충족'], ['or', '하나라도 충족']], () => state.companyMode, (v) => { state.companyMode = v; update(); }));

    // ITEM · Cargo 칩
    const chips = (el, entries, key, label) => {
      el.innerHTML = entries.map(([v, c]) => `<button type="button" class="chip" data-v="${esc(v)}">${esc(label(v))}<span class="cnt">${fmt.int(c)}</span></button>`).join('');
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        toggleIn(state[key], b.dataset.v); update();
      });
      syncers.push(() => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', state[key].includes(b.dataset.v))));
    };
    chips($('f-items'), META.items, 'items', (v) => v || '(없음)');
    chips($('f-cargo'), META.cargos, 'cargo', (v) => (v ? `${CARGO[v] || v} (${v})` : '(없음)'));
    chips($('f-bt'), META.bts || [], 'bt', btName);

    syncers.push(seg($('f-ts'), [['all', '전체'], ['1', '환적'], ['0', '비환적']], () => state.ts, (v) => { state.ts = v; update(); }));
    syncers.push(seg($('f-ex'), [['all', '전체'], ['1', '특송'], ['0', '비특송']], () => state.ex, (v) => { state.ex = v; update(); }));
    syncers.push(seg($('f-ft'), [['all', '전체'], ['P', 'Prepaid'], ['C', 'Collect']], () => state.ft, (v) => { state.ft = v; update(); }));

    // 보기 옵션
    syncers.push(seg($('groupby'), [['consignee', 'Consignee'], ['notify', 'Notify']], () => state.groupBy, (v) => { state.groupBy = v; view.sort = {}; view.page = 1; update(); }));
    syncers.push(seg($('metric'), Object.entries(METRICS).map(([k, m]) => [k, m.label]), () => state.metric, (v) => { state.metric = v; update(); }));
    syncers.push(seg($('trend-mode'), [['month', '월별'], ['voyage', '항차별']], () => state.trend, (v) => { state.trend = v; update(); }));
    syncers.push(seg($('charge-cur'), [['krw', '원화 (KRW)'], ['usd', '외화 (USD)']], () => state.charge, (v) => { state.charge = v; update(); }));

    $('btn-reset').addEventListener('click', () => {
      Object.assign(state, structuredClone(DEFAULT_STATE), { groupBy: state.groupBy, metric: state.metric, trend: state.trend, charge: state.charge, tab: state.tab });
      view.qc = null; view.page = 1; update();
    });

    // 모바일 서랍
    const open = (v) => { $('filters').classList.toggle('open', v); $('scrim').hidden = !v; };
    $('btn-filter-open').addEventListener('click', () => open(true));
    $('btn-filter-close').addEventListener('click', () => open(false));
    $('scrim').addEventListener('click', () => open(false));

    $('btn-share').addEventListener('click', () => {
      const url = location.href;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => toast('현재 조회 조건이 담긴 링크를 복사했습니다.'))
        .catch(() => toast('주소창의 링크를 복사하면 같은 조회 화면을 열 수 있습니다.'));
    });
  }

  function activeFilterCount() {
    return (state.from || state.to ? 1 : 0) + state.consignee.length + state.notify.length +
      state.items.length + state.cargo.length + state.bt.length + (state.ts !== 'all') + (state.ex !== 'all') + (state.ft !== 'all');
  }

  function describeFilters(s = state) {
    const parts = [];
    if (s.consignee.length) parts.push(['Consignee', s.consignee.map(consigneeName).join(', ')]);
    if (s.notify.length) parts.push(['Notify', s.notify.map(notifyName).join(', ')]);
    if (s.consignee.length && s.notify.length) parts.push(['업체 조건', s.companyMode === 'or' ? '하나라도 충족' : '두 조건 모두 충족']);
    if (s.items.length) parts.push(['ITEM', s.items.join(', ')]);
    if (s.cargo.length) parts.push(['화물 종류', s.cargo.map((c) => CARGO[c] || c).join(', ')]);
    if (s.bt.length) parts.push(['B/L 타입', s.bt.map(btName).join(', ')]);
    if (s.ts !== 'all') parts.push(['환적', s.ts === '1' ? '환적만' : '비환적만']);
    if (s.ex !== 'all') parts.push(['특송', s.ex === '1' ? '특송만' : '비특송만']);
    if (s.ft !== 'all') parts.push(['운임 지불', s.ft === 'P' ? 'Prepaid' : 'Collect']);
    return parts;
  }

  function renderActiveChips() {
    const chips = [];
    if (state.from || state.to) chips.push({ label: '기간', text: periodLabel(state.from, state.to), clear: () => { state.from = state.to = ''; } });
    state.consignee.forEach((v) => chips.push({ label: 'Consignee', text: consigneeName(v), clear: () => toggleIn(state.consignee, v) }));
    state.notify.forEach((v) => chips.push({ label: 'Notify', text: notifyName(v), clear: () => toggleIn(state.notify, v) }));
    state.items.forEach((v) => chips.push({ label: 'ITEM', text: v, clear: () => toggleIn(state.items, v) }));
    state.cargo.forEach((v) => chips.push({ label: '화물', text: CARGO[v] || v, clear: () => toggleIn(state.cargo, v) }));
    state.bt.forEach((v) => chips.push({ label: 'B/L 타입', text: btName(v), clear: () => toggleIn(state.bt, v) }));
    if (state.ts !== 'all') chips.push({ label: '환적', text: state.ts === '1' ? '환적' : '비환적', clear: () => { state.ts = 'all'; } });
    if (state.ex !== 'all') chips.push({ label: '특송', text: state.ex === '1' ? '특송' : '비특송', clear: () => { state.ex = 'all'; } });
    if (state.ft !== 'all') chips.push({ label: '운임', text: state.ft === 'P' ? 'Prepaid' : 'Collect', clear: () => { state.ft = 'all'; } });
    const el = $('active-chips');
    el.innerHTML = chips.length
      ? '<span class="label">적용 중</span>' + chips.map((c, i) => `<span class="fchip"><span><b>${esc(c.label)}</b> ${esc(c.text)}</span><button type="button" data-i="${i}" aria-label="${esc(c.label)} 조건 해제">×</button></span>`).join('')
      : '<span class="label">적용 중인 조건 없음 · 전체 데이터</span>';
    el.onclick = (e) => { const b = e.target.closest('button[data-i]'); if (b) { chips[b.dataset.i].clear(); update(); } };
    const n = activeFilterCount();
    $('filter-count').textContent = n ? `(${n})` : '';
  }

  // ── KPI ─────────────────────────────────────
  function deltaHtml(cur, prev, cmp) {
    if (!cmp) return '';
    if (!cmp.available || prev == null) return `<span class="delta">${esc(cmp.label)} · 비교 데이터 없음</span>`;
    if (!prev) return `<span class="delta">${esc(cmp.label)} · 비교 기간 0</span>`;
    const d = ((cur - prev) / prev) * 100;
    const cls = Math.abs(d) < 0.05 ? '' : d > 0 ? 'up' : 'down';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '–';
    return `<span class="delta ${cls}">${arrow} ${nf1.format(Math.abs(d))}%<em>${esc(cmp.label)}</em></span>`;
  }

  /** KPI 카드. get(합계) 으로 값을 구하므로 비교 기간 합계에도 같은 식을 쓴다. trend: 'month' → 월 평균, 'voyage' → 항차 평균 */
  function kpiList(t, trend = state.trend) {
    const byVoyage = trend === 'voyage';
    const avg = (x) => { const n = byVoyage ? x.voyages : x.months; return n ? x.teu / n : 0; };
    const share = (v) => (t.teu ? ` · 비중 ${fmt.pct(v, t.teu)}` : '');
    return [
      { label: '물동량', unit: 'TEU', get: (x) => x.teu, f: fmt.int, sub: `20' ${fmt.int(t.c20)} · 40' ${fmt.int(t.c40)} · 45' ${fmt.int(t.c45)}` },
      byVoyage
        ? { label: '항차 평균', unit: 'TEU', get: avg, f: fmt.one, sub: `${fmt.int(t.voyages)}개 항차 기준` }
        : { label: '월 평균', unit: 'TEU', get: avg, f: fmt.one, sub: `${fmt.int(t.months)}개월 기준` },
      { label: 'B/L 건수', unit: '건', get: (x) => x.bl, f: fmt.int, sub: `Consignee ${fmt.int(t.companies)}곳` },
      { label: '특송', unit: 'TEU', get: (x) => x.exTeu, f: fmt.int, sub: `B/L ${fmt.int(t.ex)}건${share(t.exTeu)}` },
      { label: '환적', unit: 'TEU', get: (x) => x.tsTeu, f: fmt.int, sub: `B/L ${fmt.int(t.ts)}건${share(t.tsTeu)}` },
      { label: '총 청구액', unit: '백만원', get: (x) => x.total, f: fmt.mil, sub: '원화 + 외화(원 환산), Collect' },
    ].map((k) => ({ ...k, raw: k.get(t), value: k.f(k.get(t)) }));
  }

  function renderKpis(t, prev, cmp) {
    $('kpis').innerHTML = kpiList(t).map((k) => `
      <div class="kpi">
        <span class="k-label">${k.label}</span>
        <span class="k-value">${k.value}${k.unit ? `<small>${k.unit}</small>` : ''}</span>
        ${deltaHtml(k.raw, prev ? k.get(prev) : null, cmp)}
        <span class="k-sub">${k.sub}</span>
      </div>`).join('');
  }

  // ── 차트 ────────────────────────────────────
  const charts = {};
  const ro = new ResizeObserver((entries) => entries.forEach((e) => charts[e.target.id]?.resize()));
  function chart(id) {
    if (!charts[id]) {
      charts[id] = echarts.init($(id), null, { renderer: 'canvas' });
      ro.observe($(id));
    }
    return charts[id];
  }

  const baseOption = () => ({
    animationDuration: 300,
    color: PALETTE,
    textStyle: { fontFamily: FONT, color: COLORS.ink },
    tooltip: { backgroundColor: '#fff', borderColor: COLORS.line, textStyle: { color: COLORS.ink, fontSize: 12 }, confine: true },
  });
  const axisCommon = {
    axisLine: { lineStyle: { color: COLORS.line } }, axisTick: { show: false },
    axisLabel: { color: COLORS.muted, fontSize: 11 }, splitLine: { lineStyle: { color: '#edf0f4' } },
    nameTextStyle: { color: COLORS.faint, fontSize: 11 },
  };
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  /** 항차별 차트의 3단 가로축(위→아래: 항차 · 입항일 · 월). 같은 달의 항차는 월 칸 하나로 묶고 달 경계에 세로선을 긋는다.
      band = 막대 한 칸의 폭(px). 좁으면 항차 이름을 세로로 세운다. first = 처음 보이는 칸.
      반환: { axes, index, height, monthInterval(start, end) } */
  function voyageAxes(groups, labels, band, first = 0) {
    const dates = groups.map((g) => g.date || '');
    const ym = dates.map((d) => d.slice(0, 7));
    const years = new Set(ym.filter(Boolean).map((v) => v.slice(0, 4)));
    const monthText = (v) => (!v ? '' : years.size > 1 ? `${v.slice(2, 4)}년 ${+v.slice(5)}월` : `${+v.slice(5)}월`);
    // 달이 바뀌는 칸(경계)과 각 달의 가운데 칸
    const starts = ym.map((v, i) => i === 0 || v !== ym[i - 1]);
    // 화면에 보이는 칸(start~end) 안에서 각 달의 가운데 칸에만 월 이름을 쓴다(스크롤하면 다시 계산)
    const monthInterval = (start = 0, end = ym.length - 1) => {
      const mids = new Set();
      for (let i = Math.max(start, 0); i <= end;) {
        let j = i; while (j + 1 <= end && ym[j + 1] === ym[i]) j++;
        mids.add(Math.floor((i + j) / 2)); i = j + 1;
      }
      return (i) => mids.has(i);
    };
    const upright = band < 36;
    const h0 = upright ? 36 : 12;      // 항차 줄 높이
    const off1 = h0 + 10;              // 일 줄 위치
    const off2 = off1 + 20;            // 월 줄 위치(구분선 시작)
    const base = { type: 'category', position: 'bottom', axisTick: { show: false }, axisLine: { show: false }, splitLine: { show: false } };
    const lbl = { color: COLORS.muted, fontSize: 10, interval: 0 };
    return {
      index: [0, 1, 2],
      height: off2 + 22,
      monthInterval,
      axes: [
        { ...base, data: labels, axisLine: { show: true, lineStyle: { color: COLORS.line } },
          axisLabel: { ...lbl, color: COLORS.ink, rotate: upright ? 90 : 0, margin: 6 } },
        { ...base, data: dates.map((d) => d.slice(8)), offset: off1, axisLabel: { ...lbl, margin: 4 } },
        { ...base, data: ym.map(monthText), offset: off2,
          axisLine: { show: true, lineStyle: { color: COLORS.line } },
          axisTick: { show: true, inside: true, length: off2, interval: (i) => starts[i], lineStyle: { color: COLORS.line } },
          axisLabel: { ...lbl, color: COLORS.ink, fontSize: 11, fontWeight: 600, margin: 6, interval: monthInterval(first) } },
      ],
    };
  }

  /** 다른 화면(보고서)에서도 쓰는 차트 옵션 생성기. 인자는 dash_summary 의 그룹 배열. */
  const chartOptions = {
    trend(groupRows, mode, metricKey, opts = {}) {
      const m = METRICS[metricKey];
      const groups = groupRows.filter((g) => g.key !== NONE).sort(mode === 'voyage' ? byDate : byKey);
      const zoom = !opts.static && groups.length > 40; // 항차가 많으면 최근 40개를 보여 주고 스크롤
      const labels = mode === 'voyage' ? groups.map((g) => g.key) : monthTicks(groups.map((g) => g.key));
      // 막대 = 지표 값, 금색 선 = 누적 평균(조회된 첫 월·항차부터 해당 월·항차까지의 평균), 점선 = 조회 기간 전체 평균
      const vals = groups.map((g) => m.get(g));
      let run = 0;
      const cum = vals.map((v, i) => { run += v; return run / (i + 1); });
      const avg = vals.length ? run / vals.length : 0;
      const unitWord = mode === 'voyage' ? '항차' : '월';
      const vx = mode === 'voyage' ? voyageAxes(groups, labels, (opts.width || 700) / Math.max(zoom ? 40 : groups.length, 1), zoom ? groups.length - 40 : 0) : null;
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: mode === 'voyage'
          ? { left: 48, right: 8, top: 40, bottom: vx.height + (zoom ? 28 : 2) }
          : { left: 8, right: 8, top: 40, bottom: zoom ? 34 : 4, containLabel: true },
        legend: { top: 4, left: 'center', itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 }, data: [`${m.label} (${m.unit})`, `누적 평균 (${unitWord})`, `기간 평균 ${m.fmt(avg)}`] },
        tooltip: {
          ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => {
            const g = groups[ps[0].dataIndex];
            const head = mode === 'voyage' ? `${esc(g.key)} · ${g.date || '-'}` : monthLabel(g.key);
            const i = ps[0].dataIndex;
            return `<b>${head}</b><br>B/L ${fmt.int(g.bl)}건 · ${fmt.int(g.teu)} TEU<br>중량 ${fmt.ton(g.weight)}톤<br>총 청구액 ${fmt.mil(g.total)}백만원` +
              `<br><span style="color:${COLORS.gold}">누적 평균 ${fmt.one(cum[i])} ${m.unit}</span> · 기간 평균 ${fmt.one(avg)} ${m.unit}`;
          },
        },
        ...(zoom ? { dataZoom: [
          { type: 'inside', xAxisIndex: vx.index, startValue: groups.length - 40, endValue: groups.length - 1 },
          { type: 'slider', xAxisIndex: vx.index, height: 16, bottom: 6, startValue: groups.length - 40, endValue: groups.length - 1, showDetail: false, borderColor: COLORS.line },
        ] } : {}),
        xAxis: mode === 'voyage' ? vx.axes : { type: 'category', data: labels, ...axisCommon },
        yAxis: { type: 'value', name: m.unit, ...axisCommon },
        series: [
          { type: 'bar', name: `${m.label} (${m.unit})`, data: vals.map((v) => +v.toFixed(1)), barMaxWidth: 34, itemStyle: { color: COLORS.navy700, borderRadius: [2, 2, 0, 0] } },
          { type: 'line', name: `누적 평균 (${unitWord})`, data: cum.map((v) => +v.toFixed(1)), symbol: 'circle', symbolSize: 5, lineStyle: { color: COLORS.gold, width: 2 }, itemStyle: { color: COLORS.gold }, z: 3 },
          { type: 'line', name: `기간 평균 ${m.fmt(avg)}`, data: vals.map(() => +avg.toFixed(1)), symbol: 'none', lineStyle: { color: COLORS.navy300, width: 1.5, type: 'dashed' }, itemStyle: { color: COLORS.navy300 }, z: 2 },
          // 막대 값 표시: 선에 가리지 않도록 보이지 않는 점 계열에 흰 바탕 레이블로 맨 위에 그린다
          {
            type: 'scatter', name: '', data: vals.map((v) => +v.toFixed(1)), symbolSize: 0, silent: true, tooltip: { show: false }, zlevel: 1,
            label: { show: true, position: 'top', distance: 4, color: COLORS.ink, fontSize: mode === 'voyage' ? 9 : 11, formatter: (p) => m.fmt(p.value),
              backgroundColor: '#fff', padding: [1, 2], borderRadius: 2 },
            labelLayout: { hideOverlap: true },
          },
        ],
        _keys: groups.map((g) => g.key),
        _monthInterval: vx && vx.monthInterval,
      };
    },

    rankBar(entries, metricKey, opts = {}) {
      // entries: [{label, full, ...합계}] 이미 정렬된 상위 N
      const m = METRICS[metricKey];
      const rev = [...entries].reverse();
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
        tooltip: {
          ...baseOption().tooltip, trigger: 'item',
          formatter: (p) => { const g = rev[p.dataIndex]; return `<b>${esc(g.full)}</b><br>B/L ${fmt.int(g.bl)}건 · ${fmt.int(g.teu)} TEU<br>중량 ${fmt.ton(g.weight)}톤 · 총 청구액 ${fmt.mil(g.total)}백만원`; },
        },
        xAxis: { type: 'value', ...axisCommon, axisLabel: { show: false }, splitLine: { show: false } },
        yAxis: { type: 'category', data: rev.map((g) => g.label), ...axisCommon, axisLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, color: COLORS.ink, width: opts.labelWidth || 130, overflow: 'truncate' } },
        series: [{
          type: 'bar', data: rev.map((g) => +m.get(g).toFixed(1)), barMaxWidth: 18,
          itemStyle: { color: COLORS.navy700, borderRadius: [0, 2, 2, 0] },
          label: { show: true, position: 'right', color: COLORS.muted, fontSize: 11, formatter: (p) => m.fmt(p.value) },
          emphasis: { itemStyle: { color: COLORS.navy500 } },
        }],
      };
    },

    donut(entries, opts = {}) {
      // entries: [{name, value}]
      const sum = entries.reduce((a, e) => a + e.value, 0);
      return {
        ...baseOption(),
        animation: !opts.static,
        color: [COLORS.navy700, COLORS.gold, '#5b7fa6', COLORS.navy300, '#6f7f8f'],
        tooltip: { ...baseOption().tooltip, trigger: 'item', formatter: (p) => `<b>${esc(p.name)}</b><br>${fmt.int(p.value)}건 (${fmt.pct(p.value, sum)})` },
        legend: { orient: 'vertical', ...(opts.compact ? { left: 'center', bottom: 0 } : { right: 8, top: 'middle' }), itemWidth: 10, itemHeight: 10, textStyle: { color: COLORS.ink, fontSize: 12 },
          formatter: (n) => { const e = entries.find((x) => x.name === n); return `${n}   ${fmt.int(e.value)}건 · ${fmt.pct(e.value, sum)}`; } },
        series: [{
          type: 'pie', radius: opts.compact ? ['32%', '50%'] : ['48%', '72%'], center: opts.compact ? ['50%', '32%'] : ['30%', '50%'], avoidLabelOverlap: true,
          label: { show: false }, data: entries, itemStyle: { borderColor: '#fff', borderWidth: 2 },
        }],
      };
    },

    containers(monthGroups, opts = {}) {
      const groups = monthGroups.filter((g) => g.key !== NONE).sort(byKey);
      const s = (name, key, color) => ({ type: 'bar', name, stack: 'c', data: groups.map((g) => g[key]), itemStyle: { color }, barMaxWidth: 40 });
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 8, top: 36, bottom: 4, containLabel: true },
        legend: { top: 4, right: 4, itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 } },
        tooltip: { ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
        xAxis: { type: 'category', data: monthTicks(groups.map((g) => g.key)), ...axisCommon },
        yAxis: { type: 'value', name: '개', ...axisCommon },
        series: [s("20'", 'c20', COLORS.navy300), s("40'", 'c40', COLORS.navy700), s("45'", 'c45', COLORS.gold)],
      };
    },

    charges(t, cur, opts = {}) {
      const keys = cur === 'usd' ? USD_CHARGES : KRW_CHARGES;
      const vals = keys.map((k) => ({ k, v: t[k] })).sort((a, b) => b.v - a.v);
      const sum = vals.reduce((a, x) => a + x.v, 0);
      const f = cur === 'usd' ? fmt.usd : (v) => `${fmt.mil(v)}백만원`;
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 150, top: 8, bottom: 8, containLabel: true },
        tooltip: { ...baseOption().tooltip, trigger: 'item', formatter: (p) => `<b>${p.name}</b><br>${f(vals[vals.length - 1 - p.dataIndex].v)} (${fmt.pct(vals[vals.length - 1 - p.dataIndex].v, sum)})` },
        xAxis: { type: 'value', ...axisCommon, axisLabel: { show: false }, splitLine: { show: false } },
        yAxis: { type: 'category', data: vals.map((x) => x.k).reverse(), ...axisCommon, axisLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, color: COLORS.ink } },
        series: [{
          type: 'bar', data: vals.map((x) => x.v).reverse(), barMaxWidth: 16, itemStyle: { color: cur === 'usd' ? COLORS.gold : COLORS.navy700, borderRadius: [0, 2, 2, 0] },
          label: { show: true, position: 'right', color: COLORS.muted, fontSize: 11, formatter: (p) => `${f(p.value)} · ${fmt.pct(p.value, sum)}` },
        }],
      };
    },
  };

  function topCompanies(groupRows, basis, metricKey, n = 10, includeNone = false) {
    const m = METRICS[metricKey];
    return groupRows
      .filter((g) => includeNone || g.key !== NONE)
      .sort((a, b) => m.get(b) - m.get(a))
      .slice(0, n)
      .map((g) => ({ ...g, full: companyName(basis, g.key), label: shortName(companyName(basis, g.key)) }));
  }

  function renderCharts(S) {
    const { t, groups } = S;
    const m = METRICS[state.metric];
    const bn = state.groupBy === 'notify' ? 'Notify' : 'Consignee';

    $('trend-title').textContent = `물동량 추이 · ${state.trend === 'voyage' ? '항차별' : '월별'}`;
    const trendOpt = chartOptions.trend(state.trend === 'voyage' ? groups.voyage : groups.month, state.trend, state.metric, { width: $('ch-trend').clientWidth });
    const ct = chart('ch-trend');
    const { _keys: trendKeys, _monthInterval, ...trendChartOpt } = trendOpt;
    $('ch-trend').classList.toggle('voyage-axis', state.trend === 'voyage');
    ct.resize();
    ct.setOption(trendChartOpt, true);
    ct.off('click');
    ct.off('datazoom');
    // 항차를 스크롤하면 보이는 범위에 맞춰 월 이름 위치를 다시 잡는다
    if (_monthInterval) ct.on('datazoom', () => {
      const z = ct.getOption().dataZoom?.[0];
      if (z) ct.setOption({ xAxis: [{}, {}, { axisLabel: { interval: _monthInterval(Math.round(z.startValue), Math.round(z.endValue)) } }] });
    });
    if (state.trend === 'month') ct.on('click', (p) => { const r = monthRange(trendKeys[p.dataIndex]); state.from = r.from; state.to = r.to; update(); });

    $('top-title').innerHTML = `${bn} 상위 10 <small>${m.label} 기준</small>`;
    const tops = topCompanies(groups[state.groupBy], state.groupBy, state.metric);
    const cTop = chart('ch-top');
    cTop.setOption(chartOptions.rankBar(tops, state.metric), true);
    cTop.off('click');
    cTop.on('click', (p) => { const g = [...tops].reverse()[p.dataIndex]; if (!state[state.groupBy].includes(g.key)) state[state.groupBy].push(g.key); update(); });

    $('item-title').innerHTML = `ITEM별 물량 <small>${m.label} 기준</small>`;
    const items = [...groups.item].sort((a, b) => m.get(b) - m.get(a)).map((g) => ({ ...g, full: `ITEM ${g.key || '(없음)'}`, label: g.key || '(없음)' }));
    const cItem = chart('ch-item');
    cItem.setOption(chartOptions.rankBar(items, state.metric, { labelWidth: 50 }), true);
    cItem.off('click');
    cItem.on('click', (p) => { const g = [...items].reverse()[p.dataIndex]; if (!state.items.includes(g.key)) state.items.push(g.key); update(); });

    const cargo = [...groups.cargo].sort((a, b) => b.bl - a.bl).map((g) => ({ name: `${CARGO[g.key] || g.key || '(없음)'} (${g.key})`, value: g.bl, code: g.key }));
    const cCargo = chart('ch-cargo');
    cCargo.setOption(chartOptions.donut(cargo, { compact: $('ch-cargo').clientWidth < 480 }), true);
    cCargo.off('click');
    cCargo.on('click', (p) => { const code = cargo[p.dataIndex].code; if (!state.cargo.includes(code)) state.cargo.push(code); update(); });

    chart('ch-cntr').setOption(chartOptions.containers(groups.month), true);
    chart('ch-charge').setOption(chartOptions.charges(t, state.charge), true);

    $('place-title').innerHTML = `배정 장소 <small>${m.label} 기준</small>`;
    const places = [...groups.place].sort((a, b) => m.get(b) - m.get(a)).map((g) => ({ ...g, full: placeName(g.key), label: placeName(g.key) }));
    chart('ch-place').setOption(chartOptions.rankBar(places, state.metric, { labelWidth: 150 }), true);

    const ratio = (label, a, aL, bL) => `
      <div class="ratio">
        <div class="r-head"><span>${label}</span><span>${aL} ${fmt.pct(a, t.bl)} · ${bL} ${fmt.pct(t.bl - a, t.bl)}</span></div>
        <div class="r-bar"><span style="width:${t.bl ? (a / t.bl) * 100 : 0}%"></span><span style="flex:1"></span></div>
      </div>`;
    $('ratios').innerHTML = ratio('환적 (T/S)', t.ts, '환적', '비환적') + ratio('특송 (B/L Type X)', t.ex, '특송', '비특송') + ratio('운임 지불 (F/T)', t.prepaid, 'Prepaid', 'Collect') + ratio('Notify 지정', t.withNotify, '지정', '미지정');
  }

  // ── 표 ──────────────────────────────────────
  const C = (key, label, f, o = {}) => ({ key, label, f: f || ((v) => esc(v)), ...o });
  const numCols = [
    C('bl', 'B/L', fmt.int, { num: true }),
    C('c20', "20'", fmt.int, { num: true }), C('c40', "40'", fmt.int, { num: true }), C('c45', "45'", fmt.int, { num: true }),
    C('teu', 'TEU', fmt.int, { num: true }),
    C('weight', '중량(톤)', fmt.ton, { num: true, csv: (v) => ((v || 0) / 1000).toFixed(3) }),
    C('cbm', 'CBM', fmt.one, { num: true }),
    C('krw', '원화 청구(원)', fmt.won, { num: true }),
    C('usd', '외화 청구(USD)', fmt.int, { num: true }),
    C('total', '총 청구액(원)', fmt.won, { num: true }),
  ];
  const shareCol = (t) => C('share', 'TEU 비중', (v) => `<span class="share"><i style="width:${Math.round(v * 60)}px"></i>${nf1.format(v * 100)}%</span>`, {
    num: true, get: (r) => (t.teu ? r.teu / t.teu : 0), csv: (v) => (v * 100).toFixed(2),
  });

  // 점검 항목. 건수와 B/L 목록은 서버(dash_qc)가 같은 키로 계산한다.
  const QC = [
    { key: 'issue', title: '발행일(Issue Date) 누락', desc: 'B/L 발행일이 비어 있습니다.' },
    { key: 'place', title: '배정 장소 미지정', desc: '배정장소 명이 비어 있습니다.' },
    { key: 'weight', title: '중량 0 (Empty 제외)', desc: 'Empty 화물이 아닌데 중량이 0입니다.' },
    { key: 'cntr', title: '컨테이너 수량 0 (FCL·LCL)', desc: "FCL/LCL인데 20'·40'·45' 수량이 모두 0입니다." },
    { key: 'charge', title: '청구액 0', desc: '원화·외화 청구액이 모두 0입니다.' },
    { key: 'notify', title: 'Notify 미지정 (참고)', desc: 'Notify가 없는 B/L입니다. 오류가 아닐 수 있습니다.' },
  ];

  const TABLES = {
    company: {
      label: () => `${state.groupBy === 'notify' ? 'Notify' : 'Consignee'}별 집계`,
      rows: (S) => S.groups[state.groupBy].map((g) => ({ ...g, name: companyName(state.groupBy, g.key), code: state.groupBy === 'consignee' ? consigneeCode(g.key) : '' })),
      cols: (t) => [C('name', '업체명', esc, { cls: 'trunc' }), ...(state.groupBy === 'consignee' ? [C('code', '사업자번호')] : []), ...numCols, shareCol(t)],
      search: (r) => r.name + ' ' + r.code,
      sort: { key: 'teu', dir: -1 }, footer: true, paged: 100, unit: '곳',
    },
    voyage: {
      label: () => '항차별 집계',
      rows: (S) => S.groups.voyage.map((g) => ({ ...g, voy: g.key || '(항차 없음)', consignees: g.companies })),
      cols: (t) => [C('voy', '항차'), C('date', '입항일'), C('consignees', 'Consignee 수', fmt.int, { num: true }), ...numCols, shareCol(t)],
      search: (r) => r.voy + ' ' + r.date,
      sort: { key: 'date', dir: -1 }, footer: true, paged: 100, unit: '항차',
    },
    item: {
      label: () => 'ITEM별 집계',
      rows: (S) => S.groups.item.map((g) => ({ ...g, item: g.key || '(없음)' })),
      cols: (t) => [C('item', 'ITEM'), ...numCols, shareCol(t)],
      search: (r) => r.item,
      sort: { key: 'teu', dir: -1 }, footer: true, unit: '개',
    },
    detail: {
      label: () => 'B/L 상세',
      server: true, // 검색 · 정렬 · 페이지를 서버(dash_detail)에서 처리
      cols: () => [
        C('bl', 'B/L NO'), C('voy', '항차'), C('date', '입항일'),
        C('consignee', 'Consignee', (v) => esc(consigneeName(v)), { cls: 'trunc', csv: consigneeName }),
        C('notify', 'Notify', (v) => (v === NONE ? '<span class="muted">–</span>' : esc(notifyName(v))), { cls: 'trunc', csv: (v) => (v === NONE ? '' : notifyName(v)) }),
        C('item', 'ITEM'), C('cargo', '화물', (v) => esc(CARGO[v] || v)),
        C('c20', "20'", fmt.int, { num: true }), C('c40', "40'", fmt.int, { num: true }), C('c45', "45'", fmt.int, { num: true }),
        C('teu', 'TEU', fmt.int, { num: true }),
        C('weight', '중량(kg)', fmt.one, { num: true }), C('cbm', 'CBM', fmt.one, { num: true }),
        C('total', '총 청구액(원)', fmt.won, { num: true }),
        C('desc', '품명', esc, { cls: 'trunc' }),
      ],
      csvExtra: [
        ['Consignee 사업자번호', (r) => consigneeCode(r.consignee)], ['Actual Shipper', (r) => r.actualShipper ?? ''],
        ['Shipper', (r) => r.shipper ?? ''], ['B/L Type', (r) => r.bt ?? ''], ['T/S', (r) => r.ts], ['F/T', (r) => r.ft ?? ''],
        ['PKG', (r) => r.pkg], ['원화 청구', (r) => r.krw], ['외화 청구(USD)', (r) => r.usd],
        ...KRW_CHARGES.map((k) => [k, (r) => r[k]]), ...USD_CHARGES.map((k) => [k + '(USD)', (r) => r[k]]),
        ['배정장소', (r) => r.place ?? ''], ['발행일', (r) => r.issueDate ?? ''], ['REMARK', (r) => r.remark ?? ''],
      ],
      sort: { key: 'date', dir: -1 }, paged: 50, unit: '건',
    },
    quality: { label: () => '데이터 점검', unit: '' },
  };

  let current = null; // 최근 dash_summary 결과 { t, groups }
  let tableCache = { rows: [], cols: [], def: null };

  function buildTabs() {
    const el = $('tabs');
    const draw = () => {
      el.innerHTML = Object.entries(TABLES).map(([k, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${t.label()}</button>`).join('');
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.tab = b.dataset.tab; view.page = 1; view.search = ''; $('tbl-search').value = '';
      update();
    });
    syncers.push(draw);
    let searchTimer = null;
    $('tbl-search').addEventListener('input', (e) => {
      view.search = e.target.value.trim().toLowerCase(); view.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderTable, TABLES[state.tab].server ? 300 : 0);
    });
    $('btn-csv').addEventListener('click', exportCsv);
  }

  function sortRows(rows, cols, sort) {
    const col = cols.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = col.get || ((r) => r[col.key]);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }

  /** 표 그리기 (집계표 · B/L 상세 공통). total = 전체 행 수, rows = 이번 페이지 행 */
  function drawTable({ def, cols, rows, total, sort, sumRow, shareTotal, onSort }) {
    const wrap = $('tbl'), pager = $('pager');
    const numbered = !def.server;
    const pages = def.paged ? Math.max(1, Math.ceil(total / def.paged)) : 1;
    const offset = def.paged ? (view.page - 1) * def.paged : 0;
    const cell = (c, r) => { const v = c.get ? c.get(r) : r[c.key]; return `<td class="${c.num ? 'r' : ''} ${c.cls || ''}"${c.cls === 'trunc' ? ` title="${esc(c.csv ? c.csv(v) : v)}"` : ''}>${c.f(v)}</td>`; };

    wrap.innerHTML = `<table class="data">
      <thead><tr>${numbered ? '<th class="r">No</th>' : ''}${cols.map((c) => `<th class="sortable ${c.num ? 'r' : ''}" data-k="${c.key}">${c.label}<span class="arrow">${sort.key === c.key ? (sort.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => `<tr>${numbered ? `<td class="r muted">${offset + i + 1}</td>` : ''}${cols.map((c) => cell(c, r)).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length + 1}" class="muted">검색 결과가 없습니다.</td></tr>`}</tbody>
      ${sumRow && rows.length ? `<tfoot><tr><td></td>${cols.map((c, i) => {
        if (i === 0) return '<td>합계</td>';
        if (!c.num || c.key === 'consignees') return '<td></td>';
        const v = c.key === 'share' ? (shareTotal ? sumRow.teu / shareTotal : 0) : sumRow[c.key];
        return `<td class="r">${c.f(v)}</td>`;
      }).join('')}</tr></tfoot>` : ''}
    </table>`;
    wrap.querySelector('thead').onclick = (e) => {
      const th = e.target.closest('th[data-k]'); if (!th) return;
      const k = th.dataset.k;
      const isNum = cols.find((c) => c.key === k).num;
      view.sort[state.tab] = { key: k, dir: sort.key === k ? -sort.dir : isNum ? -1 : 1 };
      view.page = 1;
      onSort();
    };

    if (def.paged && pages > 1) {
      pager.innerHTML = `<button type="button" class="btn" data-p="${view.page - 1}"${view.page <= 1 ? ' disabled' : ''}>이전</button>
        <span>${fmt.int(view.page)} / ${fmt.int(pages)} 페이지</span>
        <button type="button" class="btn" data-p="${view.page + 1}"${view.page >= pages ? ' disabled' : ''}>다음</button>`;
      pager.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b && !b.disabled) { view.page = Number(b.dataset.p); onSort(); } };
    } else pager.innerHTML = '';
  }

  function renderTable() {
    if (!current) return;
    const def = TABLES[state.tab];
    const wrap = $('tbl'), pager = $('pager');
    $('tbl-search').hidden = $('btn-csv').hidden = state.tab === 'quality';
    $('tbl-search').placeholder = def.server ? 'B/L · 항차 · 업체 · 사업자번호 · 품명 검색' : '표 안에서 검색';
    if (state.tab === 'quality') {
      const t = current.t;
      $('tbl-count').textContent = `조회된 B/L ${fmt.int(t.bl)}건 기준`;
      wrap.innerHTML = `<div class="qc-list">${QC.map((q) => {
        const n = t.qc[q.key];
        return `<div class="qc-item"><div><h4>${q.title}</h4><p>${q.desc}</p></div>
          <span class="q-count ${n ? '' : 'ok'}">${fmt.int(n)}<small> 건</small></span>
          <button type="button" class="btn" data-qc="${q.key}"${n ? '' : ' disabled'}>B/L 보기</button></div>`;
      }).join('')}${t.noExt ? `<div class="qc-item"><div><p>추가 정보(발행일·배정장소·중량)가 없는 B/L ${fmt.int(t.noExt)}건은 위 발행일 · 배정 장소 · 중량 점검에서 제외했습니다.</p></div></div>` : ''}</div>`;
      wrap.onclick = (e) => { const b = e.target.closest('[data-qc]'); if (b) { view.qc = b.dataset.qc; state.tab = 'detail'; view.page = 1; view.search = ''; $('tbl-search').value = ''; update(); } };
      pager.innerHTML = '';
      return;
    }
    wrap.onclick = null;
    if (def.server) { renderDetail(); return; }

    const t = current.t;
    const cols = def.cols(t);
    const sort = view.sort[state.tab] || def.sort;
    let rows = def.rows(current);
    if (view.search) rows = rows.filter((r) => def.search(r).toLowerCase().includes(view.search));
    rows = sortRows(rows, cols, sort);
    tableCache = { rows, cols, def };
    $('tbl-count').innerHTML = `${fmt.int(rows.length)}${def.unit}`;
    const pages = def.paged ? Math.max(1, Math.ceil(rows.length / def.paged)) : 1;
    view.page = Math.min(view.page, pages);
    const shown = def.paged ? rows.slice((view.page - 1) * def.paged, view.page * def.paged) : rows;
    drawTable({ def, cols, rows: shown, total: rows.length, sort, sumRow: def.footer ? sumOf(rows) : null, shareTotal: t.teu, onSort: renderTable });
  }

  let detailSeq = 0;
  function detailOpt(sort) {
    return { qc: view.qc, q: view.search, sort: sort.key, dir: sort.dir > 0 ? 'asc' : 'desc' };
  }
  async function renderDetail() {
    const def = TABLES.detail;
    const cols = def.cols();
    const sort = view.sort.detail || def.sort;
    const my = ++detailSeq;
    setLoading(true);
    try {
      const res = await fetchDetail(state, { ...detailOpt(sort), limit: def.paged, offset: (view.page - 1) * def.paged });
      if (my !== detailSeq || state.tab !== 'detail') return;
      tableCache = { rows: null, cols, def };
      const qcNote = view.qc ? ` · 점검 항목 "${QC.find((q) => q.key === view.qc).title}" <button type="button" class="btn link" id="qc-clear">해제</button>` : '';
      $('tbl-count').innerHTML = `${fmt.int(res.total)}${def.unit}${qcNote}`;
      $('qc-clear')?.addEventListener('click', () => { view.qc = null; view.page = 1; renderDetail(); });
      drawTable({ def, cols, rows: res.rows, total: res.total, sort, onSort: renderDetail });
    } catch (e) {
      if (my === detailSeq) $('tbl').innerHTML = `<p class="notice error" style="margin:12px 16px">B/L 목록을 불러오지 못했습니다. ${esc(e.message)}</p>`;
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv() {
    let { rows, cols, def } = tableCache;
    if (!def) return;
    if (def.server) {
      toast('B/L 목록 전체를 내려받는 중입니다…');
      try {
        rows = (await fetchDetail(state, { ...detailOpt(view.sort.detail || def.sort), limit: 100000, offset: 0 })).rows;
      } catch (e) { toast('내보내기 실패: ' + e.message); return; }
    }
    const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = cols.map((c) => c.label).concat((def.csvExtra || []).map(([l]) => l));
    const lines = rows.map((r) => cols.map((c) => {
      const v = c.get ? c.get(r) : r[c.key];
      return q(c.csv ? c.csv(v) : v);
    }).concat((def.csvExtra || []).map(([, f]) => q(f(r)))).join(','));
    const csv = '﻿' + [header.map(q).join(','), ...lines].join('\r\n');
    const name = `${def.label().replace(/[\\/:*?"<>|\s]+/g, '_')}_${periodLabel(state.from, state.to).replace(/[\\/:*?"<>|\s()~]+/g, '_')}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`${name} 파일로 내보냈습니다.`);
  }

  // ── 갱신 ────────────────────────────────────
  let seq = 0;

  async function update() {
    view.page = 1;
    saveHash();
    syncers.forEach((f) => f());
    $('view-title').textContent = periodLabel(state.from, state.to);
    const parts = describeFilters();
    $('view-sub').textContent = parts.length ? parts.map(([k, v]) => `${k}: ${v}`).join(' · ') : `${vesselLabel()} 전 항차 · 전체 업체`;
    renderActiveChips();

    const my = ++seq;
    const cmp = compareRange(state.from, state.to);
    setLoading(true);
    try {
      const [S, prev] = await Promise.all([
        fetchSummary(state),
        cmp && cmp.available ? fetchTotals(state, cmp) : null,
      ]);
      if (my !== seq) return;
      current = S;
      showNotice();
      renderKpis(S.t, prev, cmp);
      $('kpi-note').textContent = cmp ? '' : '기간(월·연도)을 지정하면 직전 기간 대비 증감이 함께 표시됩니다.';
      const empty = S.t.bl === 0;
      $('empty').hidden = !empty;
      $('charts').hidden = empty;
      if (!empty) renderCharts(S);
      renderTable();
    } catch (e) {
      if (my === seq) showNotice(e);
    } finally {
      setLoading(false);
    }
  }

  // ── 시작 ────────────────────────────────────
  async function boot() {
    setLoading(true);
    let opts;
    try {
      [META, opts] = await Promise.all([api.meta(), api.options()]);
    } catch (e) {
      fatal('대시보드 데이터를 불러오지 못했습니다.', e);
      return;
    } finally {
      setLoading(false);
    }
    if (!META.rows) {
      fatal('아직 데이터가 없습니다.', '운임 필터 탭에서 운임 엑셀을 클라우드에 동기화한 뒤 새로고침하세요.');
      return;
    }
    MONTHS = META.months;
    YEARS = [...new Set(MONTHS.map((m) => m.slice(0, 4)))];
    opts.consignee.forEach(([k, code, name, n]) => COMPANIES.set(k, { code: code || '', name: name || k, n }));
    NOTIFIES = opts.notify;

    $('brand-mark').textContent = vesselLabel();
    $('data-meta').textContent = `${vesselLabel()} · 데이터 ${META.dateMin} ~ ${META.dateMax} · B/L ${fmt.int(META.rows)}건`;
    $('foot').innerHTML = `<span>원본: 운임 데이터 클라우드 동기화 (Supabase)</span><span>최근 반영: ${esc(META.syncedAt)}</span><span>TEU = 20'×1 + 40'×2 + 45'×2</span><span>금액은 모두 Collect 기준, 총 청구액 = 원화 + 외화(원 환산)</span>`;
    buildFilters();
    buildTabs();
    showNotice();

    window.Dash = {
      META, MONTHS, YEARS, CARGO, KRW_CHARGES, USD_CHARGES, NONE, METRICS, COLORS, QC,
      state, fmt, esc, fetchSummary, fetchTotals, fetchDetail, topCompanies, chartOptions,
      consigneeName, consigneeCode, notifyName, companyName, placeName, vesselLabel,
      companyList: (basis) => (basis === 'notify'
        ? NOTIFIES.filter(([k]) => k !== NONE).map(([k, n]) => ({ key: k, n, name: k, code: '' }))
        : [...COMPANIES].filter(([k]) => k !== NONE).map(([k, c]) => ({ key: k, n: c.n, name: c.name, code: c.code }))),
      periodLabel, compareRange, monthRange, yearRange, monthLabel, describeFilters, kpiList, toast, setLoading,
    };
    document.dispatchEvent(new Event('dash:ready'));

    update();
    window.addEventListener('hashchange', () => { Object.assign(state, loadHash()); update(); });
  }

  boot();
})();
