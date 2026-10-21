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
  const RF = { R: '냉동', S: '선어', L: '활어' }; // 냉동 구분 (B/L 번호 E12, REMARK 선어 · 활어)
  // Collect TTL = 원화 항목 + USD 항목 × 적용환율 (ESC 는 USD 항목)
  const KRW_CHARGES = ['THC', 'DOC', 'WFG', 'CCF', 'TSF', 'PSC'];
  const USD_CHARGES = ['FRT', 'BAF', 'CAF', 'CRS', 'LSS', 'PSS', 'ESC'];
  const SUM_KEYS = ['bl', 'c20', 'c40', 'c45', 'teu', 'cntr', 'pkg', 'weight', 'cbm', 'krw', 'usd', 'total', 'ts', 'ex', 'prepaid', 'withNotify'];
  const GROUP_DIMS = ['month', 'voyage', 'consignee', 'notify', 'item', 'cargo', 'place', 'reefer', 'reeferConsignee', 'tsConsignee', 'exConsignee'];
  // 환적 · 특송 카드: 묶음 안의 해당 TEU(tsTeu · exTeu), 해당 B/L 수(ts · ex), Consignee 집계 축
  const SUBSETS = {
    ts: { name: '환적', note: 'T/S', teuKey: 'tsTeu', blKey: 'ts', dim: 'tsConsignee' },
    ex: { name: '특송', note: 'B/L Type X', teuKey: 'exTeu', blKey: 'ex', dim: 'exConsignee' },
  };
  // CSV · 보고서 B/L 상세 목록 최대 건수 (한 번에 내려받는 양 제한. 1,000건 ≈ 0.3MB)
  const DETAIL_MAX = 1000;
  // 수입 · 수출 · 전체 (조회 조건 dir). 업체 축 이름: 수입 Consignee/Notify, 수출 Shipper/Forwarder
  const DIRS = { IN: '수입', OUT: '수출', ALL: '수출입 전체' };
  const AXIS = { IN: ['Consignee', 'Notify'], OUT: ['Shipper', 'Forwarder'], ALL: ['업체', 'Notify · Forwarder'] };
  const cAx = () => AXIS[state.dir][0];
  const nAx = () => AXIS[state.dir][1];
  const NONE = ''; // 값 없음: (Notify 없음) · (미지정) 등
  const COLORS = {
    navy900: '#13243b', navy700: '#1f3a5f', navy500: '#456789', navy300: '#9fb3c8', navy100: '#e5ecf3',
    gold: '#a8842c', ink: '#1b2532', muted: '#5d6a79', faint: '#8995a2', line: '#dbe1e8',
  };
  // 냉동 카드: dash_summary 의 냉동 · 선어 · 활어 TEU 필드와 색 (금색은 점유율 선이 쓰므로 뺀다)
  const RF_TEU = [['rTeu', '냉동', COLORS.navy700], ['sTeu', '선어', '#5b7fa6'], ['lTeu', '활어', COLORS.navy300]];
  // 선복량: 이론 313 TEU, 실무 최대 304 TEU → 선복 대비 = TEU ÷ (항차 수 × 304)
  const SHIP_CAP = 304;
  const capPct = (g) => fmt.pct(g.teu || 0, (g.voyages || 0) * SHIP_CAP);
  // 공컨 이송 컨테이너 종류 · 사이즈: [dash_summary 필드(개수), 이름, TEU 배수, 색]
  const MT_TYPES = [['mt20', "20'", 1, COLORS.navy300], ['mt40', "40'", 2, COLORS.navy700], ['mt45', "45'", 2, COLORS.gold],
    ['mtR20', '20RF (냉동)', 1, '#5b7fa6'], ['mtR40', '40RF (냉동)', 2, '#3d5a50']];
  /** 공컨 이송 차트 · 표의 월 · 항차: 수출이 있는 것만 (전체 보기의 수입만 있는 달 · 수입 항차는 뺌) */
  const mtGroups = (groupRows, mode) => groupRows
    .filter((g) => g.key !== NONE && (g.mtTeu > 0 || g.bl - (g.inBl || 0) > 0))
    .sort(mode === 'voyage' ? byDate : byKey);
  const PALETTE = ['#1f3a5f', '#5b7fa6', '#a8842c', '#9fb3c8', '#6f7f8f', '#c9b27a', '#3d5a50', '#b9c4cf'];
  const FONT = '"Noto Sans KR", "Malgun Gothic", sans-serif';

  // dash_meta() · dash_options() 결과 (boot 에서 채움)
  let META = null;
  let MONTHS = [], YEARS = [];
  const COMPANIES = new Map(); // 사업자번호(키) → { code, name, n }
  let NOTIFIES = [];           // [[이름(''=없음), B/L 수]]

  const consigneeName = (k) => (k === NONE ? `(${cAx()} 없음)` : COMPANIES.get(k)?.name || k);
  const consigneeCode = (k) => (k === NONE ? '' : COMPANIES.get(k)?.code || '');
  const notifyName = (k) => (k === NONE ? `(${nAx()} 없음)` : k);
  const companyName = (basis, k) => (basis === 'notify' ? notifyName(k) : consigneeName(k));
  const shortName = (n) => n.replace(/주식회사|\(주\)|㈜/g, '').replace(/\s+/g, ' ').trim() || n;
  const placeName = (k) => (k === NONE ? '(미지정)' : k);
  /** 수출 보기: 냉동 컨테이너(20RF · 40RF)를 20' · 40' 에서 떼어 따로 보여 준다 (c20 · c40 은 stripE 로 B/L Type E 를 이미 뺀 값)
      → 20' + 20RF + (40' + 40RF + 45') × 2 = TEU */
  const dry = (g) => ({ c20: (g.c20 || 0) - (g.rf20 || 0), c40: (g.c40 || 0) - (g.rf40 || 0), c45: g.c45 || 0 });
  /** 표 · 차트의 컨테이너 칸: 수출 = 20' · 40' · 45' · 20RF · 40RF, 수입 · 전체 = 20' · 40' · 45' (수출 RF 포함) */
  const cntrCols = (dir) => (dir === 'OUT'
    ? [["20'", (g) => dry(g).c20], ["40'", (g) => dry(g).c40], ["45'", (g) => dry(g).c45], ['20RF', (g) => g.rf20 || 0], ['40RF', (g) => g.rf40 || 0]]
    : [["20'", (g) => g.c20], ["40'", (g) => g.c40], ["45'", (g) => g.c45]]);
  // 냉동 기준: 수입 = B/L 번호 E12(선어 · 활어 포함), 수출 = 20RF · 40RF 수량
  const rfNote = () => ({ IN: '선어 · 활어 포함', OUT: '20RF · 40RF', ALL: '수입 선어 · 활어 포함 · 수출 RF' })[state.dir];
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
  // getIn = 수입분 (전체 보기에서 수입 · 수출로 나눠 쌓을 때. 수출분 = get - getIn)
  const METRICS = {
    teu: { label: 'TEU', unit: 'TEU', get: (t) => t.teu, getIn: (t) => t.inTeu || 0, fmt: fmt.int },
    bl: { label: 'B/L 건수', unit: '건', get: (t) => t.bl, getIn: (t) => t.inBl || 0, fmt: fmt.int },
    weight: { label: '중량', unit: '톤', get: (t) => t.weight / 1000, getIn: (t) => (t.inWeight || 0) / 1000, fmt: fmt.one },
    total: { label: '총 청구액', unit: '백만원', get: (t) => t.total / 1e6, getIn: (t) => (t.inTotal || 0) / 1e6, fmt: fmt.one },
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
    items: [], cargo: [], bt: [], ts: 'all', ex: 'all', ft: 'all', rf: 'all',
    groupBy: 'consignee', metric: 'teu', trend: 'month', charge: 'krw', rfView: 'bar', tsView: 'bar', exView: 'bar', tab: 'company',
    view: 'volume', // 보기 전환: volume(물동량) | customers(고객 변화, 실험)
    dir: 'IN',      // 수입 IN · 수출 OUT · 전체 ALL (바꾸면 목록을 다시 받으려고 새로고침)
    mtView: 'bar',  // 공컨 이송 카드: 막대 · 도넛 · 표
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
    if (!DIRS[s.dir]) s.dir = 'IN';
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
      items: s.items, cargo: s.cargo, bt: s.bt, ts: s.ts, ex: s.ex, ft: s.ft, rf: s.rf || 'all', dir: s.dir || 'IN',
    };
  }
  const zip = (fields, a) => { const o = {}; fields.forEach((f, i) => { o[f] = a[i]; }); return o; };
  /** 물동량 화면의 컨테이너 수에서 B/L Type E(공컨 · 수화물 · 샤시 등 화물 없음) 컨테이너를 뺀다 (TEU 도 0 이므로).
      → 표 · 카드 · 차트 · 보고서의 20' + (40' + 45') × 2 = TEU. 수출 공컨은 공컨 이송(mtTeu)에서만 센다. B/L 상세는 B/L 원래 값 */
  function stripE(o) {
    if (!o || o.e20 === undefined) return o; // 예전 SQL (e20 없음)
    const e20 = o.e20 || 0, e40 = o.e40 || 0, e45 = o.e45 || 0;
    return { ...o, c20: o.c20 - e20, c40: o.c40 - e40, c45: o.c45 - e45, cntr: o.cntr - e20 - e40 - e45 };
  }
  function expandSummary(res) {
    const groups = {};
    GROUP_DIMS.forEach((d) => { groups[d] = (res.groups[d] || []).map((a) => stripE(zip(res.fields, a))); });
    return { t: stripE(res.totals), groups, notifyOf: res.notifyOf || {} };
  }
  // 같은 조건을 다시 고르면(필터 해제 · 보고서) 서버에 다시 묻지 않는다.
  const cache = new Map();
  function cached(kind, f, opt) {
    const key = kind + JSON.stringify(f) + (opt ? JSON.stringify(opt) : '');
    if (!cache.has(key)) {
      if (cache.size >= 40) cache.delete(cache.keys().next().value);
      const p = api[kind](f, opt).then((r) => (kind === 'summary' ? expandSummary(r) : kind === 'totals' ? stripE(r) : r));
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
    syncers.push(seg($('f-rf'), [['all', '전체'], ['1', '냉동'], ['0', '비냉동']], () => state.rf, (v) => { state.rf = v; update(); }));
    syncers.push(seg($('f-ft'), [['all', '전체'], ['P', 'Prepaid'], ['C', 'Collect']], () => state.ft, (v) => { state.ft = v; update(); }));

    // 보기 옵션
    syncers.push(seg($('groupby'), [['consignee', cAx()], ['notify', nAx()]], () => state.groupBy, (v) => { state.groupBy = v; view.sort = {}; view.page = 1; update(); }));
    syncers.push(seg($('metric'), Object.entries(METRICS).map(([k, m]) => [k, m.label]), () => state.metric, (v) => { state.metric = v; update(); }));
    syncers.push(seg($('trend-mode'), [['month', '월별'], ['voyage', '항차별']], () => state.trend, (v) => { state.trend = v; update(); }));
    syncers.push(seg($('charge-cur'), [['krw', '원화 (KRW)'], ['usd', '외화 (USD)']], () => state.charge, (v) => { state.charge = v; update(); }));
    ['rf', 'ts', 'ex', 'mt'].forEach((k) => {
      syncers.push(seg($(`${k}-view`), [['bar', '막대'], ['donut', '도넛'], ['table', '표']], () => state[`${k}View`], (v) => { state[`${k}View`] = v; update(); }));
    });

    $('btn-reset').addEventListener('click', () => {
      Object.assign(state, structuredClone(DEFAULT_STATE), { groupBy: state.groupBy, metric: state.metric, trend: state.trend, charge: state.charge, rfView: state.rfView, tsView: state.tsView, exView: state.exView, mtView: state.mtView, tab: state.tab, view: state.view, dir: state.dir });
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
      state.items.length + state.cargo.length + state.bt.length + (state.ts !== 'all') + (state.ex !== 'all') + (state.ft !== 'all') + (state.rf !== 'all');
  }

  function describeFilters(s = state) {
    const parts = [];
    if (s.dir && s.dir !== 'IN') parts.push(['구분', DIRS[s.dir]]);
    if (s.consignee.length) parts.push([cAx(), s.consignee.map(consigneeName).join(', ')]);
    if (s.notify.length) parts.push([nAx(), s.notify.map(notifyName).join(', ')]);
    if (s.consignee.length && s.notify.length) parts.push(['업체 조건', s.companyMode === 'or' ? '하나라도 충족' : '두 조건 모두 충족']);
    if (s.items.length) parts.push(['ITEM', s.items.join(', ')]);
    if (s.cargo.length) parts.push(['화물 종류', s.cargo.map((c) => CARGO[c] || c).join(', ')]);
    if (s.bt.length) parts.push(['B/L 타입', s.bt.map(btName).join(', ')]);
    if (s.ts !== 'all') parts.push(['환적', s.ts === '1' ? '환적만' : '비환적만']);
    if (s.ex !== 'all') parts.push(['특송', s.ex === '1' ? '특송만' : '비특송만']);
    if (s.ft !== 'all') parts.push(['운임 지불', s.ft === 'P' ? 'Prepaid' : 'Collect']);
    if (s.rf && s.rf !== 'all') parts.push(['냉동', s.rf === '1' ? '냉동만 (선어 · 활어 포함)' : '비냉동만']);
    return parts;
  }

  function renderActiveChips() {
    const chips = [];
    if (state.from || state.to) chips.push({ label: '기간', text: periodLabel(state.from, state.to), clear: () => { state.from = state.to = ''; } });
    state.consignee.forEach((v) => chips.push({ label: cAx(), text: consigneeName(v), clear: () => toggleIn(state.consignee, v) }));
    state.notify.forEach((v) => chips.push({ label: nAx(), text: notifyName(v), clear: () => toggleIn(state.notify, v) }));
    state.items.forEach((v) => chips.push({ label: 'ITEM', text: v, clear: () => toggleIn(state.items, v) }));
    state.cargo.forEach((v) => chips.push({ label: '화물', text: CARGO[v] || v, clear: () => toggleIn(state.cargo, v) }));
    state.bt.forEach((v) => chips.push({ label: 'B/L 타입', text: btName(v), clear: () => toggleIn(state.bt, v) }));
    if (state.ts !== 'all') chips.push({ label: '환적', text: state.ts === '1' ? '환적' : '비환적', clear: () => { state.ts = 'all'; } });
    if (state.ex !== 'all') chips.push({ label: '특송', text: state.ex === '1' ? '특송' : '비특송', clear: () => { state.ex = 'all'; } });
    if (state.ft !== 'all') chips.push({ label: '운임', text: state.ft === 'P' ? 'Prepaid' : 'Collect', clear: () => { state.ft = 'all'; } });
    if (state.rf !== 'all') chips.push({ label: '냉동', text: state.rf === '1' ? '냉동' : '비냉동', clear: () => { state.rf = 'all'; } });
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
    const avgCard = byVoyage
      ? { label: '항차 평균', unit: 'TEU', get: avg, f: fmt.one, sub: `${fmt.int(t.voyages)}개 항차 기준` }
      : { label: '월 평균', unit: 'TEU', get: avg, f: fmt.one, sub: `${fmt.int(t.months)}개월 기준` };
    if (state.dir !== 'IN') {
      const all = state.dir === 'ALL';
      const kr = (x) => (x.krIn || 0) + (x.krOut || 0);
      return [
        { label: '물동량', unit: 'TEU', get: (x) => x.teu, f: fmt.int,
          sub: all ? `수입 ${fmt.int(t.inTeu)} · 수출 ${fmt.int(t.outTeu)}`
            : `20' ${fmt.int(dry(t).c20)} · 40' ${fmt.int(dry(t).c40)} · 45' ${fmt.int(dry(t).c45)} · RF ${fmt.int((t.rf20 || 0) + (t.rf40 || 0))}` },
        avgCard,
        { label: 'B/L 건수', unit: '건', get: (x) => x.bl, f: fmt.int,
          sub: all ? `수입 ${fmt.int(t.inBl)} · 수출 ${fmt.int(t.bl - t.inBl)}` : `Shipper ${fmt.int(t.companies)}곳` },
        { label: '공컨 이송', unit: 'TEU', get: (x) => x.mtTeu || 0, f: fmt.int, sub: `B/L ${fmt.int(t.mtBl)}건 · ${fmt.int(t.mtCntr)}개 · 물동량에는 미포함` },
        { label: '한국 금액', unit: '백만원', get: kr, f: fmt.mil,
          sub: all ? `수입 CC ${fmt.mil(t.krIn)} + 수출 PP ${fmt.mil(t.krOut)}` : 'Prepaid (한국 지불)' },
        { label: '중국 금액', unit: '백만원', get: (x) => x.cnOut || 0, f: fmt.mil, sub: all ? '수출 CC 집계 (수입 PP 는 미집계)' : 'Collect (중국 지불)' },
      ].map((k) => ({ ...k, raw: k.get(t), value: k.f(k.get(t)) }));
    }
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

  /** 그릴 값이 없을 때 차트 자리에 안내 문구만 보여 준다 */
  const emptyChart = (msg) => ({ ...baseOption(), title: { text: msg, left: 'center', top: 'middle', textStyle: { color: COLORS.faint, fontSize: 13, fontWeight: 400 } }, series: [] });

  /** 다른 화면(보고서)에서도 쓰는 차트 옵션 생성기. 인자는 dash_summary 의 그룹 배열. */
  const chartOptions = {
    trend(groupRows, mode, metricKey, opts = {}) {
      const m = METRICS[metricKey];
      const groups = groupRows.filter((g) => g.key !== NONE).sort(mode === 'voyage' ? byDate : byKey);
      const zoom = !opts.static && groups.length > 40; // 항차가 많으면 최근 40개를 보여 주고 스크롤
      const labels = mode === 'voyage' ? groups.map((g) => g.key) : monthTicks(groups.map((g) => g.key));
      // 막대 = 지표 값, 금색 선 = 직전 월·항차 대비 증감률(%, 보조축), 점선 = 조회 기간 전체 평균
      const vals = groups.map((g) => m.get(g));
      // 전체(수출입) 보기: 막대를 수입 · 수출로 나눠 쌓는다 (합계 · 증감률 · 평균은 그대로)
      const split = opts.split ?? state.dir === 'ALL';
      const ins = groups.map((g) => m.getIn(g));
      const rates = vals.map((v, i) => (i && vals[i - 1] ? ((v - vals[i - 1]) / vals[i - 1]) * 100 : null));
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      const rateName = `증감률 (${mode === 'voyage' ? '직전 항차' : '전월'} 대비)`;
      const pct = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${nf1.format(v)}%`);
      const vx = mode === 'voyage' ? voyageAxes(groups, labels, (opts.width || 700) / Math.max(zoom ? 40 : groups.length, 1), zoom ? groups.length - 40 : 0) : null;
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: mode === 'voyage'
          ? { left: 48, right: 48, top: 40, bottom: vx.height + (zoom ? 28 : 2) }
          : { left: 8, right: 8, top: 40, bottom: zoom ? 34 : 4, containLabel: true },
        legend: { top: 4, left: 'center', itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 },
          data: [...(split ? ['수입', '수출'] : [`${m.label} (${m.unit})`]), rateName, `기간 평균 ${m.fmt(avg)}`] },
        tooltip: {
          ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => {
            const g = groups[ps[0].dataIndex];
            const head = mode === 'voyage' ? `${esc(g.key)} · ${g.date || '-'}` : monthLabel(g.key);
            const i = ps[0].dataIndex;
            return `<b>${head}</b><br>B/L ${fmt.int(g.bl)}건 · ${fmt.int(g.teu)} TEU<br>중량 ${fmt.ton(g.weight)}톤<br>총 청구액 ${fmt.mil(g.total)}백만원` +
              (split ? `<br>· 수입 ${m.fmt(ins[i])} ${m.unit}<br>· 수출 ${m.fmt(vals[i] - ins[i])} ${m.unit}` : '') +
              `<br><span style="color:${COLORS.gold}">${rateName} ${pct(rates[i])}</span><br>기간 평균 ${fmt.one(avg)} ${m.unit}`;
          },
        },
        ...(zoom ? { dataZoom: [
          { type: 'inside', xAxisIndex: vx.index, startValue: groups.length - 40, endValue: groups.length - 1 },
          { type: 'slider', xAxisIndex: vx.index, height: 16, bottom: 6, startValue: groups.length - 40, endValue: groups.length - 1, showDetail: false, borderColor: COLORS.line },
        ] } : {}),
        xAxis: mode === 'voyage' ? vx.axes : { type: 'category', data: labels, ...axisCommon },
        yAxis: [
          { type: 'value', name: m.unit, ...axisCommon },
          { type: 'value', name: '증감률', ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => `${v}%` } },
        ],
        series: [
          ...(split ? [
            { type: 'bar', name: '수입', stack: 'io', data: ins.map((v) => +v.toFixed(1)), barMaxWidth: 34, itemStyle: { color: COLORS.navy700 } },
            { type: 'bar', name: '수출', stack: 'io', data: vals.map((v, i) => +(v - ins[i]).toFixed(1)), barMaxWidth: 34, itemStyle: { color: '#5b7fa6', borderRadius: [2, 2, 0, 0] } },
          ] : [
            { type: 'bar', name: `${m.label} (${m.unit})`, data: vals.map((v) => +v.toFixed(1)), barMaxWidth: 34, itemStyle: { color: COLORS.navy700, borderRadius: [2, 2, 0, 0] } },
          ]),
          { type: 'line', name: rateName, yAxisIndex: 1, data: rates.map((v) => (v == null ? null : +v.toFixed(1))), symbol: 'circle', symbolSize: 5, lineStyle: { color: COLORS.gold, width: 2 }, itemStyle: { color: COLORS.gold }, z: 3 },
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
      if (!entries.length) return emptyChart(opts.empty || '해당 데이터가 없습니다.');
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
      // entries: [{name, value}], opts.unit: 값 단위(기본 '건')
      const sum = entries.reduce((a, e) => a + e.value, 0);
      const unit = opts.unit || '건';
      if (!sum) return emptyChart(opts.empty || '해당 데이터가 없습니다.');
      return {
        ...baseOption(),
        animation: !opts.static,
        color: opts.colors || [COLORS.navy700, COLORS.gold, '#5b7fa6', COLORS.navy300, '#6f7f8f'],
        tooltip: { ...baseOption().tooltip, trigger: 'item', formatter: (p) => `<b>${esc(p.name)}</b><br>${fmt.int(p.value)}${unit} (${fmt.pct(p.value, sum)})` },
        legend: { orient: 'vertical', ...(opts.compact ? { left: 'center', bottom: 0 } : { right: 8, top: 'middle' }), itemWidth: 10, itemHeight: 10, textStyle: { color: COLORS.ink, fontSize: 12 },
          formatter: (n) => { const e = entries.find((x) => x.name === n); return `${n}   ${fmt.int(e.value)}${unit} · ${fmt.pct(e.value, sum)}`; } },
        series: [{
          type: 'pie', radius: opts.compact ? ['32%', '50%'] : ['48%', '72%'], center: opts.compact ? ['50%', '32%'] : ['30%', '50%'], avoidLabelOverlap: true,
          label: { show: false }, data: entries, itemStyle: { borderColor: '#fff', borderWidth: 2 },
        }],
      };
    },

    /** 냉동 · 환적 · 특송: 막대 = 해당 TEU(냉동은 냉동 · 선어 · 활어 누적), 막대 위 = 합계 TEU,
     *  금색 선(보조축) = 그 월 · 항차 전체 TEU 중 점유율(%, 소수 첫째 자리) */
    shareTrend(groupRows, mode, kind, opts = {}) {
      const d = kind === 'rf' ? { name: '냉동', blKey: null } : SUBSETS[kind];
      const groups = groupRows.filter((g) => g.key !== NONE).sort(mode === 'voyage' ? byDate : byKey);
      const stacks = kind === 'rf'
        ? RF_TEU.map(([key, name, color]) => ({ name, color, vals: groups.map((g) => Number(g[key]) || 0) }))
        : [{ name: `${d.name} TEU`, color: COLORS.navy700, vals: groups.map((g) => Number(g[d.teuKey]) || 0) }];
      const vals = groups.map((g, i) => stacks.reduce((a, st) => a + st.vals[i], 0));
      if (!vals.some((v) => v > 0)) return emptyChart(opts.empty || `조건에 맞는 ${d.name} B/L 이 없습니다.`);
      const shares = groups.map((g, i) => (g.teu ? +((vals[i] / g.teu) * 100).toFixed(1) : null));
      const labels = mode === 'voyage' ? groups.map((g) => g.key) : monthTicks(groups.map((g) => g.key));
      const show = Math.max(8, Math.floor((opts.width || 500) / 22)); // 항차가 많으면 최근 것부터 보여 주고 스크롤
      const zoom = !opts.static && groups.length > show;
      const lineName = '점유율 (%)';
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 8, top: 40, bottom: zoom ? 34 : 4, containLabel: true },
        legend: { top: 4, left: 'center', itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 }, data: [...stacks.map((st) => st.name), lineName] },
        tooltip: {
          ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => {
            const i = ps[0].dataIndex, g = groups[i];
            const head = mode === 'voyage' ? `${esc(g.key)} · ${g.date || '-'}` : monthLabel(g.key);
            const parts = stacks.length > 1 ? stacks.map((st) => `<br>· ${st.name} ${fmt.int(st.vals[i])} TEU`).join('') : '';
            return `<b>${head}</b><br>${d.name} ${fmt.int(vals[i])} TEU${d.blKey ? ` (B/L ${fmt.int(g[d.blKey])}건)` : ''}${parts}<br>전체 ${fmt.int(g.teu)} TEU` +
              `<br><span style="color:${COLORS.gold}">점유율 ${shares[i] == null ? '–' : nf1.format(shares[i]) + '%'}</span>`;
          },
        },
        ...(zoom ? { dataZoom: [
          { type: 'inside', startValue: groups.length - show, endValue: groups.length - 1 },
          { type: 'slider', height: 16, bottom: 6, startValue: groups.length - show, endValue: groups.length - 1, showDetail: false, borderColor: COLORS.line },
        ] } : {}),
        xAxis: { type: 'category', data: labels, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, ...(mode === 'voyage' ? { rotate: 90, fontSize: 10 } : {}) } },
        yAxis: [
          { type: 'value', name: 'TEU', ...axisCommon },
          { type: 'value', name: '점유율', min: 0, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => `${nf1.format(v)}%` } },
        ],
        series: [
          ...stacks.map((st, j) => ({ type: 'bar', name: st.name, stack: 'v', data: st.vals, barMaxWidth: 34,
            itemStyle: { color: st.color, borderRadius: j === stacks.length - 1 ? [2, 2, 0, 0] : 0 } })),
          { type: 'line', name: lineName, yAxisIndex: 1, data: shares, symbol: 'circle', symbolSize: 6, lineStyle: { color: COLORS.gold, width: 2 }, itemStyle: { color: COLORS.gold }, z: 3 },
          // 막대 위 합계 TEU: 선에 가리지 않도록 보이지 않는 점 계열에 흰 바탕 레이블로 맨 위에 그린다
          {
            type: 'scatter', name: '', data: vals, symbolSize: 0, silent: true, tooltip: { show: false }, zlevel: 1,
            label: { show: true, position: 'top', distance: 4, color: COLORS.ink, fontSize: mode === 'voyage' ? 9 : 11, formatter: (p) => (p.value ? fmt.int(p.value) : ''),
              backgroundColor: '#fff', padding: [1, 2], borderRadius: 2 },
            labelLayout: { hideOverlap: true },
          },
        ],
      };
    },

    /** 한국 · 중국 금액 (백만원): 한국 = 수입 CC + 수출 PP (두 색으로 쌓음), 중국 = 수출 CC. 수입 PP 는 저장하지 않아 미집계 */
    money(groupRows, mode, opts = {}) {
      const groups = groupRows.filter((g) => g.key !== NONE).sort(mode === 'voyage' ? byDate : byKey);
      const mil = (v) => +((v || 0) / 1e6).toFixed(1);
      const series = [
        { name: '한국 · 수입 CC', stack: 'kr', key: 'krIn', color: COLORS.navy700 },
        { name: '한국 · 수출 PP', stack: 'kr', key: 'krOut', color: '#5b7fa6' },
        { name: '중국 · 수출 CC', stack: 'cn', key: 'cnOut', color: COLORS.gold },
      ].filter((s) => groups.some((g) => g[s.key]));
      if (!series.length) return emptyChart('해당 금액이 없습니다.');
      const labels = mode === 'voyage' ? groups.map((g) => g.key) : monthTicks(groups.map((g) => g.key));
      const show = Math.max(8, Math.floor((opts.width || 500) / 26));
      const zoom = !opts.static && groups.length > show;
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 8, top: 40, bottom: zoom ? 34 : 4, containLabel: true },
        legend: { top: 4, left: 'center', itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 } },
        tooltip: {
          ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => {
            const g = groups[ps[0].dataIndex];
            const head = mode === 'voyage' ? `${esc(g.key)} · ${g.date || '-'}` : monthLabel(g.key);
            return `<b>${head}</b><br>한국 ${fmt.mil((g.krIn || 0) + (g.krOut || 0))}백만원` +
              `<br>· 수입 CC ${fmt.mil(g.krIn)} · 수출 PP ${fmt.mil(g.krOut)}<br><span style="color:${COLORS.gold}">중국 · 수출 CC ${fmt.mil(g.cnOut)}백만원</span>`;
          },
        },
        ...(zoom ? { dataZoom: [
          { type: 'inside', startValue: groups.length - show, endValue: groups.length - 1 },
          { type: 'slider', height: 16, bottom: 6, startValue: groups.length - show, endValue: groups.length - 1, showDetail: false, borderColor: COLORS.line },
        ] } : {}),
        xAxis: { type: 'category', data: labels, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, ...(mode === 'voyage' ? { rotate: 90, fontSize: 10 } : {}) } },
        yAxis: { type: 'value', name: '백만원', ...axisCommon },
        series: series.map((s) => ({ type: 'bar', name: s.name, stack: s.stack, data: groups.map((g) => mil(g[s.key])), barMaxWidth: 28, itemStyle: { color: s.color } })),
      };
    },

    /** 공컨 이송 TEU (수출 공컨 B/L: B/L Type E · 끝 번호 1000). 항차별이면 공컨이 있는 항차만 */
    /** 공컨 이송: 컨테이너 종류 · 사이즈별 TEU 를 쌓은 막대(범례), 막대 위 = 총 TEU, 점선 = 평균 TEU.
        수출이 있는 월 · 항차만 (전체 보기에서 수입만 있는 달은 빼고 평균) */
    empties(groupRows, mode, opts = {}) {
      const groups = mtGroups(groupRows, mode);
      if (!groups.some((g) => g.mtTeu > 0)) return emptyChart(opts.empty || '조건에 맞는 공컨 이송이 없습니다.');
      const types = MT_TYPES.filter(([k]) => groups.some((g) => g[k] > 0));
      const tot = groups.map((g) => g.mtTeu || 0);
      const avg = tot.reduce((a, b) => a + b, 0) / tot.length;
      const avgName = `평균 ${fmt.one(avg)} TEU`;
      const labels = mode === 'voyage' ? groups.map((g) => g.key) : monthTicks(groups.map((g) => g.key));
      const show = Math.max(8, Math.floor((opts.width || 500) / 26));
      const zoom = !opts.static && groups.length > show;
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 8, top: 40, bottom: zoom ? 34 : 4, containLabel: true },
        legend: { top: 4, left: 'center', itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 }, data: [...types.map((x) => x[1]), avgName] },
        tooltip: {
          ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => {
            const g = groups[ps[0].dataIndex];
            return `<b>${mode === 'voyage' ? `${esc(g.key)} · ${g.date || '-'}` : monthLabel(g.key)}</b><br>공컨 이송 ${fmt.int(g.mtTeu)} TEU`
              + types.map(([k, name, w]) => `<br>· ${name} ${fmt.int(g[k])}개 (${fmt.int((g[k] || 0) * w)} TEU)`).join('')
              + `<br><span style="color:${COLORS.faint}">${avgName}</span>`;
          },
        },
        ...(zoom ? { dataZoom: [
          { type: 'inside', startValue: groups.length - show, endValue: groups.length - 1 },
          { type: 'slider', height: 16, bottom: 6, startValue: groups.length - show, endValue: groups.length - 1, showDetail: false, borderColor: COLORS.line },
        ] } : {}),
        xAxis: { type: 'category', data: labels, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, ...(mode === 'voyage' ? { rotate: 90, fontSize: 10 } : {}) } },
        yAxis: { type: 'value', name: 'TEU', ...axisCommon },
        series: [
          ...types.map(([k, name, w, color], j) => ({ type: 'bar', name, stack: 'mt', data: groups.map((g) => (g[k] || 0) * w), barMaxWidth: 28,
            itemStyle: { color, borderRadius: j === types.length - 1 ? [2, 2, 0, 0] : 0 } })),
          { type: 'line', name: avgName, data: groups.map(() => +avg.toFixed(1)), symbol: 'none', lineStyle: { color: COLORS.navy300, width: 1.5, type: 'dashed' }, itemStyle: { color: COLORS.navy300 }, z: 2 },
          // 막대 위 = 총 TEU (선에 가리지 않도록 보이지 않는 점 계열에 흰 바탕 레이블)
          { type: 'scatter', name: '', data: tot, symbolSize: 0, silent: true, tooltip: { show: false }, zlevel: 1,
            label: { show: true, position: 'top', distance: 4, color: COLORS.ink, fontSize: mode === 'voyage' ? 9 : 11, formatter: (p) => (p.value ? fmt.int(p.value) : ''),
              backgroundColor: '#fff', padding: [1, 2], borderRadius: 2 },
            labelLayout: { hideOverlap: true } },
        ],
      };
    },

    containers(monthGroups, opts = {}) {
      const groups = monthGroups.filter((g) => g.key !== NONE).sort(byKey);
      const s = (name, key, color) => ({ type: 'bar', name, stack: 'c', data: groups.map((g) => (typeof key === 'function' ? key(g) : g[key])), itemStyle: { color }, barMaxWidth: 40 });
      // 화물이 실린 컨테이너만 (B/L Type E 제외). 수출은 20RF · 40RF 를 따로 쌓는다
      const colors = { "20'": COLORS.navy300, "40'": COLORS.navy700, "45'": COLORS.gold, '20RF': '#5b7fa6', '40RF': '#3d5a50' };
      const series = cntrCols(state.dir).map(([l, f]) => s(l, f, colors[l])).filter((x) => !['20RF', '40RF'].includes(x.name) || x.data.some((v) => v));
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 8, top: 36, bottom: 4, containLabel: true },
        legend: { top: 4, right: 4, itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 } },
        tooltip: { ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
        xAxis: { type: 'category', data: monthTicks(groups.map((g) => g.key)), ...axisCommon },
        yAxis: { type: 'value', name: '개', ...axisCommon },
        series,
      };
    },

    charges(t, cur, opts = {}) {
      // 수출이 섞이면 원화에 CFS 를 더한다 (수출 Prepaid 에 포함, 수입 Collect 에는 없음)
      const keys = cur === 'usd' ? USD_CHARGES : state.dir === 'IN' ? KRW_CHARGES : [...KRW_CHARGES, 'CFS'];
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

    /** [실험] 고객 변화: 월별 실적 고객 수. months = [[월, 활동, 신규, 전월에 이어, 다시 시작, 전월 대비 빠짐, TEU]]
     *  데이터가 시작된 달은 신규를 알 수 없으므로 한 색(데이터 시작 달)으로 그린다. 빠진 고객은 0 아래 빨간 막대. */
    custFlow(months, firstMonth, opts = {}) {
      const rows = months.map(([m, active, fresh, cont, back, dropped, teu]) => ({ m, active, fresh, cont, back, dropped, teu, base: m === firstMonth }));
      if (!rows.length) return emptyChart('해당 데이터가 없습니다.');
      const S = (name, color, get) => ({ type: 'bar', name, stack: 'c', data: rows.map(get), itemStyle: { color }, barMaxWidth: 40 });
      const series = [
        S('데이터 시작 달', COLORS.navy300, (r) => (r.base ? r.active : 0)),
        S('전월에 이어', COLORS.navy700, (r) => (r.base ? 0 : r.cont)),
        S('다시 시작', '#5b7fa6', (r) => (r.base ? 0 : r.back)),
        S('신규', COLORS.gold, (r) => (r.base ? 0 : r.fresh)),
        S('전월 대비 빠짐', '#a3403a', (r) => (r.base ? 0 : -r.dropped)),
      ].filter((s) => s.data.some((v) => v));
      return {
        ...baseOption(),
        animation: !opts.static,
        grid: { left: 8, right: 8, top: 40, bottom: 4, containLabel: true },
        legend: { top: 4, left: 'center', itemWidth: 12, itemHeight: 8, textStyle: { color: COLORS.muted, fontSize: 11 }, data: series.map((s) => s.name) },
        tooltip: {
          ...baseOption().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => {
            const r = rows[ps[0].dataIndex];
            return `<b>${monthLabel(r.m)}</b><br>실적 고객 ${fmt.int(r.active)}곳 · ${fmt.int(r.teu)} TEU` + (r.base
              ? `<br><span style="color:${COLORS.faint}">데이터가 시작된 달이라 신규 구분 없음</span>`
              : `<br>· 전월에 이어 ${fmt.int(r.cont)}곳<br>· 다시 시작 ${fmt.int(r.back)}곳<br>· 신규 ${fmt.int(r.fresh)}곳<br><span style="color:#a3403a">전월 대비 빠짐 ${fmt.int(r.dropped)}곳</span>`);
          },
        },
        xAxis: { type: 'category', data: monthTicks(rows.map((r) => r.m)), ...axisCommon },
        yAxis: { type: 'value', name: '곳', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.int(Math.abs(v)) } },
        series: [
          ...series,
          // 막대 위 숫자 = 그 달 실적 고객 수
          { type: 'scatter', name: '', data: rows.map((r) => r.active), symbolSize: 0, silent: true, tooltip: { show: false }, zlevel: 1,
            label: { show: true, position: 'top', distance: 4, color: COLORS.ink, fontSize: 11, formatter: (p) => fmt.int(p.value), backgroundColor: '#fff', padding: [1, 2], borderRadius: 2 } },
        ],
      };
    },
  };

  function topCompanies(groupRows, basis, metricKey, n = 10, includeNone = false) {
    const m = METRICS[metricKey];
    return groupRows
      .filter((g) => includeNone || g.key !== NONE)
      .sort((a, b) => m.get(b) - m.get(a) || b.bl - a.bl || byKey(a, b)) // 같으면 B/L · 키 순 (다시 열어도 순위가 같도록)
      .slice(0, n)
      .map((g) => ({ ...g, full: companyName(basis, g.key), label: shortName(companyName(basis, g.key)) }));
  }

  /** 직전 값 대비 증감률 칸 (▲ 빨강 · ▼ 파랑). 직전 값이 없거나 0 이면 – */
  function rate(cur, prev) {
    if (!prev) return '<span class="delta">–</span>';
    const d = ((cur - prev) / prev) * 100;
    const cls = Math.abs(d) < 0.05 ? '' : d > 0 ? 'up' : 'down';
    return `<span class="delta ${cls}">${cls === 'up' ? '▲' : cls === 'down' ? '▼' : ''} ${nf1.format(Math.abs(d))}%</span>`;
  }

  const trendNote = (dir) => ({
    IN: "20' · 40' · 45' = 화물이 실린 컨테이너 (B/L Type E 제외). TEU = 20' + (40' + 45') × 2.",
    OUT: "20' · 40' · 45' · 20RF · 40RF = 화물이 실린 컨테이너 (B/L Type E 공컨 · 수화물 · 샤시 제외). TEU = 20' + 20RF + (40' + 40RF + 45') × 2. 공컨 이송은 TEU 에 넣지 않고 따로 셉니다.",
    ALL: "20' · 40' · 45' = 화물이 실린 컨테이너 (수출 20RF · 40RF 포함, B/L Type E 제외). TEU = 20' + (40' + 45') × 2. 공컨 이송은 TEU 에 넣지 않고 따로 셉니다.",
  })[dir];

  /** 추이 차트 아래 표: 월(또는 항차)별 컨테이너 · TEU · 직전 월(항차) 대비 TEU 증감률 · 총 청구액 */
  function renderTrendTable(groupRows, mode, t) {
    const rows = groupRows.filter((g) => g.key !== NONE).sort(mode === 'voyage' ? byDate : byKey);
    const prevWord = mode === 'voyage' ? '직전 항차' : '전월';
    // 수출 · 전체: 20' · 40' · 45' 는 실화물(냉동 · B/L Type E 제외), 20RF · 40RF · 공컨 TEU 칸 추가 (전체는 수입 · 수출 TEU 도)
    const io = state.dir !== 'IN', all = state.dir === 'ALL';
    const cols = [
      ...cntrCols(state.dir),
      ...(all ? [['수입 TEU', (g) => g.inTeu || 0], ['수출 TEU', (g) => g.teu - (g.inTeu || 0)]] : []),
    ];
    const after = io ? [['공컨 TEU', (g) => g.mtTeu || 0]] : [];
    const td = (v) => `<td class="r">${fmt.int(v)}</td>`;
    $('trend-table').innerHTML = `<table class="data">
      <thead><tr>
        <th>${mode === 'voyage' ? '항차' : '월'}</th>${cols.map(([l]) => `<th class="r">${l}</th>`).join('')}<th class="r">TEU</th>
        <th class="r" title="TEU 기준, ${prevWord} 대비">증감률 <small>(${prevWord} 대비)</small></th>
        <th class="r" title="TEU ÷ (항차 수 × ${SHIP_CAP}TEU). 이론 선복량 313TEU, 실무 최대 ${SHIP_CAP}TEU 기준">선복 대비 <small>(${SHIP_CAP}TEU)</small></th>${after.map(([l]) => `<th class="r">${l}</th>`).join('')}<th class="r">${io ? '총 금액' : '총 청구액'} <small>(백만원)</small></th>
      </tr></thead>
      <tbody>${rows.map((g, i) => `<tr>
        <td>${mode === 'voyage' ? esc(g.key) : monthLabel(g.key)}</td>
        ${cols.map(([, f]) => td(f(g))).join('')}<td class="r"><b>${fmt.int(g.teu)}</b></td>
        <td class="r">${rate(g.teu, i ? rows[i - 1].teu : null)}</td>
        <td class="r" title="${fmt.int(g.voyages)}항차 × ${SHIP_CAP}TEU = ${fmt.int((g.voyages || 0) * SHIP_CAP)}TEU">${capPct(g)}</td>
        ${after.map(([, f]) => td(f(g))).join('')}<td class="r">${fmt.mil(g.total)}</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td>합계 (${fmt.int(rows.length)}${mode === 'voyage' ? '항차' : '개월'})</td>
        ${cols.map(([, f]) => td(f(t))).join('')}<td class="r">${fmt.int(t.teu)}</td><td class="r"></td>
        <td class="r" title="${fmt.int(t.voyages)}항차 × ${SHIP_CAP}TEU">${capPct(t)}</td>${after.map(([, f]) => td(f(t))).join('')}<td class="r">${fmt.mil(t.total)}</td>
      </tr></tfoot>
    </table>`;
    $('trend-note').hidden = false;
    $('trend-note').textContent = `${trendNote(state.dir)} 선복 대비 = TEU ÷ (항차 수 × ${SHIP_CAP}TEU, 실무 최대 선적량 · 이론 313TEU).`;
    const wrap = $('trend-table');
    const limit = mode === 'voyage' ? 14 : 12;
    const trs = wrap.querySelectorAll('tbody tr');
    wrap.style.maxHeight = trs.length > limit
      ? `${wrap.querySelector('thead').offsetHeight + wrap.querySelector('tfoot').offsetHeight + [...trs].slice(0, limit).reduce((h, r) => h + r.offsetHeight, 0) + 1}px`
      : '';
    wrap.scrollTop = 0;
  }

  function renderCharts(S) {
    const { t, groups } = S;
    const m = METRICS[state.metric];
    const bn = state.groupBy === 'notify' ? nAx() : cAx();

    $('trend-title').textContent = `물동량 추이 · ${state.trend === 'voyage' ? '항차별' : '월별'}`;
    const trendOpt = chartOptions.trend(state.trend === 'voyage' ? groups.voyage : groups.month, state.trend, state.metric, { width: $('ch-trend').clientWidth });
    const ct = chart('ch-trend');
    const { _keys: trendKeys, _monthInterval, ...trendChartOpt } = trendOpt;
    $('ch-trend').classList.toggle('voyage-axis', state.trend === 'voyage');
    ct.resize();
    ct.setOption(trendChartOpt, true);
    renderTrendTable(state.trend === 'voyage' ? groups.voyage : groups.month, state.trend, t);
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
    renderReefer(S);
    renderSubsets(S);
    chart('ch-charge').setOption(chartOptions.charges(t, state.charge), true);
    if (state.dir !== 'IN') renderIoCards(S);

    // 배정 장소는 수입만 있는 정보 (수출 · 전체에서는 운영 지표만)
    if (state.dir === 'IN') {
      $('place-title').innerHTML = `배정 장소 <small>${m.label} 기준</small>`;
      const places = [...groups.place].sort((a, b) => m.get(b) - m.get(a)).map((g) => ({ ...g, full: placeName(g.key), label: placeName(g.key) }));
      chart('ch-place').setOption(chartOptions.rankBar(places, state.metric, { labelWidth: 150 }), true);
    } else {
      $('place-title').innerHTML = '운영 지표 <small>배정 장소는 수입 보기에서</small>';
    }

    const ratio = (label, a, aL, bL) => `
      <div class="ratio">
        <div class="r-head"><span>${label}</span><span>${aL} ${fmt.pct(a, t.bl)} · ${bL} ${fmt.pct(t.bl - a, t.bl)}</span></div>
        <div class="r-bar"><span style="width:${t.bl ? (a / t.bl) * 100 : 0}%"></span><span style="flex:1"></span></div>
      </div>`;
    $('ratios').innerHTML = ratio('환적 (T/S)', t.ts, '환적', '비환적') + (state.dir === 'OUT' ? '' : ratio('특송 (B/L Type X)', t.ex, '특송', '비특송'))
      + ratio('운임 지불 (F/T)', t.prepaid, 'Prepaid', 'Collect') + ratio(`${nAx()} 지정`, t.withNotify, '지정', '미지정');
  }

  /** 수출 · 전체 보기 전용 카드: 한국 · 중국 금액, 공컨 이송 (월별 · 항차별은 물동량 추이 선택을 따름) */
  function renderIoCards(S) {
    const { t, groups } = S;
    const mode = state.trend, rows = mode === 'voyage' ? groups.voyage : groups.month;
    const kr = (t.krIn || 0) + (t.krOut || 0);
    $('money-title').innerHTML = `한국 · 중국 금액 <small>${mode === 'voyage' ? '항차별' : '월별'} · 백만원</small>`;
    const cm = chart('ch-money');
    cm.resize();
    cm.setOption(chartOptions.money(rows, mode, { width: $('ch-money').clientWidth }), true);
    $('money-sum').innerHTML = `<b>한국 ${fmt.mil(kr)}</b>백만원 (${state.dir === 'ALL' ? `수입 CC ${fmt.mil(t.krIn)} · ` : ''}수출 PP ${fmt.mil(t.krOut)})`
      + ` · <b>중국 ${fmt.mil(t.cnOut)}</b>백만원 (수출 CC)`;
    // 공컨 이송: 막대(월 · 항차별 TEU) · 도넛(종류 · 사이즈별 TEU 비율) · 표(월 · 항차별 종류 · 사이즈별 개수 · TEU)
    const v = state.mtView, by = mode === 'voyage' ? '항차별' : '월별';
    $('mt-title').innerHTML = `공컨 이송 <small>${v === 'donut' ? '종류 · 사이즈별 TEU' : `${by} ${v === 'table' ? '컨테이너 · TEU' : 'TEU'}`} · 수출 B/L Type E · 끝 번호 1000</small>`;
    $('ch-mt').hidden = v === 'table';
    $('mt-table').hidden = v !== 'table';
    if (v === 'table') renderMtTable(rows, mode, t);
    else {
      const ce = chart('ch-mt');
      ce.resize();
      ce.setOption(v === 'donut'
        ? chartOptions.donut(MT_TYPES.map(([k, name, w]) => ({ name: `${name} ${fmt.int(t[k] || 0)}개`, value: (t[k] || 0) * w })).filter((e) => e.value > 0),
          { unit: 'TEU', empty: '조건에 맞는 공컨 이송이 없습니다.', colors: MT_TYPES.filter(([k]) => t[k] > 0).map((x) => x[3]), compact: $('ch-mt').clientWidth < 480 })
        : chartOptions.empties(rows, mode, { width: $('ch-mt').clientWidth }), true);
    }
    const parts = MT_TYPES.filter(([k]) => t[k] > 0).map(([k, name]) => `${name} ${fmt.int(t[k])}개`).join(' · ');
    $('mt-sum').innerHTML = `공컨 이송 <b>${fmt.int(t.mtTeu)}</b> TEU · B/L ${fmt.int(t.mtBl)}건 · 컨테이너 ${fmt.int(t.mtCntr)}개${parts ? ` (${parts})` : ''}`
      + (t.teu ? ` · 물동량(${fmt.int(t.teu)} TEU) 대비 ${fmt.pct(t.mtTeu, t.teu)}` : '');
  }

  /** 공컨 이송 [표]: 월(항차)별 종류 · 사이즈별 개수 · 컨테이너 합계 · TEU · 증감률, 맨 아래 합계와 TEU 비율 */
  function renderMtTable(groupRows, mode, t) {
    const wrap = $('mt-table');
    const rows = mtGroups(groupRows, mode);
    if (!rows.some((g) => g.mtTeu > 0)) { wrap.innerHTML = '<p class="empty-state">조건에 맞는 공컨 이송이 없습니다.</p>'; return; }
    const types = MT_TYPES.filter(([k]) => t[k] > 0);
    const cnt = (g) => types.reduce((a, [k]) => a + (g[k] || 0), 0);
    const prevWord = mode === 'voyage' ? '직전 항차' : '전월';
    wrap.innerHTML = `<table class="data">
      <thead><tr><th>${mode === 'voyage' ? '항차' : '월'}</th>${types.map(([, name]) => `<th class="r">${name.replace(' (냉동)', '')}</th>`).join('')}
        <th class="r">합계(개)</th><th class="r">TEU</th><th class="r" title="${prevWord} 대비">증감률</th></tr></thead>
      <tbody>${rows.map((g, i) => `<tr><td>${mode === 'voyage' ? esc(g.key) : monthLabel(g.key)}</td>
        ${types.map(([k]) => `<td class="r">${fmt.int(g[k])}</td>`).join('')}<td class="r">${fmt.int(cnt(g))}</td>
        <td class="r"><b>${fmt.int(g.mtTeu)}</b></td><td class="r">${rate(g.mtTeu, i ? rows[i - 1].mtTeu : null)}</td></tr>`).join('')}</tbody>
      <tfoot>
        <tr><td>합계</td>${types.map(([k]) => `<td class="r">${fmt.int(t[k])}</td>`).join('')}<td class="r">${fmt.int(cnt(t))}</td><td class="r">${fmt.int(t.mtTeu)}</td><td class="r"></td></tr>
        <tr><td>TEU 비율</td>${types.map(([k, , w]) => `<td class="r">${fmt.pct(t[k] * w, t.mtTeu)}</td>`).join('')}<td class="r"></td><td class="r">100.0%</td><td class="r"></td></tr>
      </tfoot>
    </table>`;
    wrap.scrollTop = 0;
  }

  /** 냉동(선어 · 활어 포함) 요약: 전체 대비 비중 + 냉동 · 선어 · 활어 구성. metricKey = 'teu' | 'bl' */
  function reeferSummary(S, metricKey) {
    const m = METRICS[metricKey];
    const rows = (S.groups.reefer || []).filter((g) => RF[g.key]);
    const total = m.get(S.t), reefer = rows.reduce((a, g) => a + m.get(g), 0);
    const parts = Object.keys(RF).map((k) => {
      const g = rows.find((x) => x.key === k);
      return { key: k, name: RF[k], value: g ? m.get(g) : 0, bl: g ? g.bl : 0, teu: g ? g.teu : 0 };
    });
    return { m, total, reefer, parts, unit: metricKey === 'teu' ? 'TEU' : '건' };
  }
  /** 냉동 · 환적 · 특송 Consignee 상위 n (dim = reeferConsignee 등). TEU 기준, 같으면 B/L 많은 순. TEU 0 인 곳도 0 으로 순위에 넣는다 */
  function subsetTop(S, dim, n = 10) {
    return [...(S.groups[dim] || [])]
      .sort((a, b) => b.teu - a.teu || b.bl - a.bl || byKey(a, b))
      .slice(0, n)
      .map((g) => ({ ...g, full: consigneeName(g.key), label: shortName(consigneeName(g.key)) }));
  }
  const reeferTop = (S, n = 10) => subsetTop(S, 'reeferConsignee', n);

  /** 냉동 · 환적 · 특송 카드 위쪽: 막대(월 · 항차별 TEU + 점유율) · 도넛(구성) · 표 전환, 그 아래 전체 대비 비중 */
  function renderShareCard(S, k, donutEntries, colors) {
    const isRf = k === 'rf';
    const d = isRf ? null : SUBSETS[k];
    const name = isRf ? '냉동' : d.name;
    const sub = isRf ? rfNote() : d.note;
    const mode = state.trend, by = mode === 'voyage' ? '항차별' : '월별';
    const v = state[`${k}View`];
    const id = isRf ? 'ch-reefer' : `ch-${k}`;
    const empty = `조건에 맞는 ${name} B/L 이 없습니다.`;
    const rows = mode === 'voyage' ? S.groups.voyage : S.groups.month;
    $(`${k}-title`).innerHTML = `${name} 화물 <small>${sub} · ${v === 'donut' ? 'TEU 구성' : `${by} TEU · 점유율`}</small>`;
    $(`${k}-note`).textContent = v === 'donut'
      ? '조회 기간 전체의 TEU 구성입니다.'
      : `${v === 'bar' ? `막대 위 숫자 = ${name} TEU 합계, ` : ''}점유율 = 그 월(항차) 전체 TEU 중 ${name} TEU. 월별 · 항차별은 물동량 추이 선택을 따릅니다.`;
    $(id).hidden = v === 'table';
    $(`${k}-table`).hidden = v !== 'table';
    if (v === 'table') renderShareTable(rows, mode, k, empty);
    else {
      const c = chart(id);
      c.resize();
      c.setOption(v === 'donut'
        ? chartOptions.donut(donutEntries.filter((p) => p.value > 0), { unit: 'TEU', empty, colors, compact: $(id).clientWidth < 480 })
        : chartOptions.shareTrend(rows, mode, k, { width: $(id).clientWidth, empty }), true);
    }
    const total = S.t.teu, a = isRf ? donutEntries.reduce((x, p) => x + p.value, 0) : donutEntries[0].value, rest = total - a;
    $(`${k}-ratio`).innerHTML = `
      <div class="ratio">
        <div class="r-head"><span>전체 대비 ${name} 비중 (TEU)</span><span>${name} ${fmt.int(a)}TEU · ${fmt.pct(a, total)} · 그 외 ${fmt.pct(rest, total)}</span></div>
        <div class="r-bar"><span style="width:${total ? (a / total) * 100 : 0}%"></span><span style="flex:1"></span></div>
      </div>`;
  }

  /** 냉동 · 환적 · 특송 [표]: 월(항차)별 해당 TEU(냉동은 냉동 · 선어 · 활어) · 전체 TEU · 증감률(해당 TEU, 직전 월 · 항차 대비) · 점유율, 맨 아래 합계 */
  function renderShareTable(groupRows, mode, k, empty) {
    const isRf = k === 'rf', d = SUBSETS[k];
    const rows = groupRows.filter((g) => g.key !== NONE).sort(mode === 'voyage' ? byDate : byKey);
    const cols = isRf
      ? [...RF_TEU.map(([key, label]) => ({ label, get: (g) => Number(g[key]) || 0 })),
        { label: '냉동 합계', bold: true, get: (g) => RF_TEU.reduce((a, [key]) => a + (Number(g[key]) || 0), 0) }]
      : [{ label: `${d.name} B/L`, get: (g) => Number(g[d.blKey]) || 0 }, { label: `${d.name} TEU`, bold: true, get: (g) => Number(g[d.teuKey]) || 0 }];
    const val = cols[cols.length - 1].get; // 증감률 · 점유율 기준 = 해당 TEU 합계
    const name = isRf ? '냉동' : d.name, prevWord = mode === 'voyage' ? '직전 항차' : '전월';
    const wrap = $(`${k}-table`);
    if (!rows.some((g) => val(g) > 0)) { wrap.innerHTML = `<p class="empty-state">${empty}</p>`; return; }
    const sum = (f) => rows.reduce((a, g) => a + f(g), 0);
    const cell = (c, n) => `<td class="r">${c.bold ? `<b>${fmt.int(n)}</b>` : fmt.int(n)}</td>`;
    wrap.innerHTML = `<table class="data">
      <thead><tr><th>${mode === 'voyage' ? '항차' : '월'}</th>${cols.map((c) => `<th class="r">${c.label}</th>`).join('')}<th class="r">전체 TEU</th>
        <th class="r" title="${name} TEU 기준">증감률 <small>(${prevWord} 대비)</small></th><th class="r">점유율</th></tr></thead>
      <tbody>${rows.map((g, i) => `<tr><td>${mode === 'voyage' ? esc(g.key) : monthLabel(g.key)}</td>${cols.map((c) => cell(c, c.get(g))).join('')}<td class="r">${fmt.int(g.teu)}</td>
        <td class="r">${rate(val(g), i ? val(rows[i - 1]) : null)}</td><td class="r">${fmt.pct(val(g), g.teu)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>합계</td>${cols.map((c) => `<td class="r">${fmt.int(sum(c.get))}</td>`).join('')}<td class="r">${fmt.int(sum((g) => g.teu))}</td><td class="r"></td><td class="r">${fmt.pct(sum(val), sum((g) => g.teu))}</td></tr></tfoot>
    </table>`;
    wrap.scrollTop = 0;
  }

  /** Consignee 상위 10 표: 순위 · Consignee · B/L · TEU(칸 안 막대) · 비중 · 누적 비중. 비중 = 해당 화물(냉동 등) 전체 TEU 중. 줄을 누르면 그 업체로 조회 */
  function renderTopTable(k, tops, subsetTeu, empty) {
    const wrap = $(`${k}-top`);
    if (!tops.length) { wrap.innerHTML = `<p class="empty-state">${empty}</p>`; return; }
    const max = Math.max(...tops.map((g) => g.teu), 1);
    let acc = 0;
    wrap.innerHTML = `<table class="data">
      <thead><tr><th class="r">순위</th><th>${cAx()}</th><th class="r">B/L</th><th>TEU</th><th class="r">비중</th><th class="r">누적 비중</th></tr></thead>
      <tbody>${tops.map((g, i) => {
        acc += g.teu;
        return `<tr data-i="${i}" title="${esc(g.full)} · 누르면 이 업체로 조회">
          <td class="r muted">${i + 1}</td>
          <td class="trunc w-m">${esc(g.label)}</td>
          <td class="r">${fmt.int(g.bl)}</td>
          <td><span class="bar-cell"><i style="--w:${(g.teu / max).toFixed(3)}"></i><b>${fmt.int(g.teu)}</b></span></td>
          <td class="r">${fmt.pct(g.teu, subsetTeu)}</td>
          <td class="r">${fmt.pct(acc, subsetTeu)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
    wrap.onclick = (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const g = tops[+tr.dataset.i];
      if (!state.consignee.includes(g.key)) state.consignee.push(g.key);
      update();
    };
  }

  function renderReefer(S) {
    const r = reeferSummary(S, 'teu');
    renderShareCard(S, 'rf', r.parts, RF_TEU.map((x) => x[2]));
    renderTopTable('rf', reeferTop(S), r.reefer, '조건에 맞는 냉동 B/L 이 없습니다.');
  }

  /** 환적 · 특송 카드: 막대 · 도넛(환적 · 비환적 등) · 표 전환, Consignee 상위 10 표 */
  function renderSubsets(S) {
    Object.entries(SUBSETS).forEach(([k, d]) => {
      if (k === 'ex' && state.dir === 'OUT') return; // 수출에는 특송(B/L Type X)이 없음 (카드 숨김)
      const a = Number(S.t[d.teuKey]) || 0;
      renderShareCard(S, k, [{ name: d.name, value: a }, { name: `비${d.name}`, value: Math.max(S.t.teu - a, 0) }], [COLORS.navy700, COLORS.navy300]);
      renderTopTable(k, subsetTop(S, d.dim), a, `조건에 맞는 ${d.name} B/L 이 없습니다.`);
    });
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
  const shareCol = (t) => C('share', 'TEU 비중', (v) => `<span class="share"><i style="width:${Math.round(v * 40)}px"></i>${nf1.format(v * 100)}%</span>`, {
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

  // 업체별 집계 표는 중량 · CBM · 원화 · 외화 청구를 빼고 본다.
  const companyNumCols = numCols.filter((c) => !['weight', 'cbm', 'krw', 'usd'].includes(c.key));
  // Consignee 의 Notify: B/L 이 가장 많은 Notify 를 보여 주고, 여럿이면 "외 N" + 툴팁 · CSV 에 전체 목록
  const notifyList = (r) => (r.notifies || []).map(([k, n]) => `${notifyName(k)} (${fmt.int(n)}건)`).join(', ');
  const notifyCol = C('notify', nAx(), (v, r) => {
    const ns = r.notifies || [];
    if (!ns.length) return '';
    const main = ns[0][0] === NONE ? '<span class="muted">–</span>' : esc(notifyName(ns[0][0]));
    return ns.length > 1 ? `${main} <span class="muted">외 ${ns.length - 1}</span>` : main;
  }, { cls: 'trunc w-s', csv: (v, r) => notifyList(r) });

  // 누적 비중(파레토): 표 정렬 · 검색과 상관없이 TEU 많은 순으로 위에서부터 더한 TEU 비중
  const cumCol = C('cum', '누적 비중', (v) => `${nf1.format(v * 100)}%`, {
    num: true, noSum: true, csv: (v) => (v * 100).toFixed(2),
  });
  function withCumShare(rows, totalTeu) {
    let acc = 0;
    [...rows].sort((a, b) => b.teu - a.teu || b.bl - a.bl || String(a.name).localeCompare(String(b.name)))
      .forEach((r) => { acc += Number(r.teu) || 0; r.cum = totalTeu ? acc / totalTeu : 0; });
    return rows;
  }

  const TABLES = {
    company: {
      label: () => `${state.groupBy === 'notify' ? nAx() : cAx()}별 집계`,
      rows: (S) => withCumShare(S.groups[state.groupBy].map((g) => {
        const isC = state.groupBy === 'consignee';
        const notifies = isC ? (S.notifyOf[g.key] || []) : [];
        return { ...g, name: companyName(state.groupBy, g.key), code: isC ? consigneeCode(g.key) : '', notifies, notify: notifies.length ? notifyName(notifies[0][0]) : '' };
      }), S.t.teu),
      cols: (t) => [C('name', '업체명', esc, { cls: 'trunc w-m' }), ...(state.groupBy === 'consignee' ? [C('code', '사업자번호'), notifyCol] : []), ...companyNumCols, shareCol(t), cumCol],
      search: (r) => r.name + ' ' + r.code + ' ' + r.notifies.map(([k]) => k).join(' '),
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
        ...(state.dir === 'ALL' ? [C('io', '구분', (v) => (v === 'OUT' ? '수출' : '수입'), { csv: (v) => (v === 'OUT' ? '수출' : '수입') })] : []),
        C('bl', 'B/L NO'), C('voy', '항차'), C('date', '입항일'),
        C('consignee', cAx(), (v) => esc(consigneeName(v)), { cls: 'trunc', csv: consigneeName }),
        C('notify', nAx(), (v) => (v === NONE ? '<span class="muted">–</span>' : esc(notifyName(v))), { cls: 'trunc', csv: (v) => (v === NONE ? '' : notifyName(v)) }),
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
      // 수출 · 전체 보기에서 CSV 에 더하는 칸
      csvExtraIo: [
        ['중국 쪽 업체 (수입 Shipper · 수출 Consignee)', (r) => r.partner ?? ''], ['Prepaid TTL (수출)', (r) => r.pp ?? ''], ['Collect TTL', (r) => r.cc ?? ''],
        ['CFS', (r) => r.CFS ?? ''], ['20RF', (r) => r.rf20 ?? ''], ['40RF', (r) => r.rf40 ?? ''], ['공컨 TEU', (r) => r.mtTeu ?? ''],
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
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || byKey(a, b); // 같으면 키 순 (다시 열어도 순서가 같도록)
    });
  }

  /** 표 그리기 (집계표 · B/L 상세 공통). total = 전체 행 수, rows = 이번 페이지 행 */
  function drawTable({ def, cols, rows, total, sort, sumRow, shareTotal, onSort }) {
    const wrap = $('tbl'), pager = $('pager');
    const numbered = !def.server;
    const pages = def.paged ? Math.max(1, Math.ceil(total / def.paged)) : 1;
    const offset = def.paged ? (view.page - 1) * def.paged : 0;
    const cell = (c, r) => { const v = c.get ? c.get(r) : r[c.key]; return `<td class="${c.num ? 'r' : ''} ${c.cls || ''}"${/\btrunc\b/.test(c.cls || '') ? ` title="${esc(c.csv ? c.csv(v, r) : v)}"` : ''}>${c.f(v, r)}</td>`; };

    wrap.innerHTML = `<table class="data">
      <thead><tr>${numbered ? '<th class="r">No</th>' : ''}${cols.map((c) => `<th class="sortable ${c.num ? 'r' : ''}" data-k="${c.key}">${c.label}<span class="arrow">${sort.key === c.key ? (sort.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => `<tr>${numbered ? `<td class="r muted">${offset + i + 1}</td>` : ''}${cols.map((c) => cell(c, r)).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length + 1}" class="muted">검색 결과가 없습니다.</td></tr>`}</tbody>
      ${sumRow && rows.length ? `<tfoot><tr><td></td>${cols.map((c, i) => {
        if (i === 0) return '<td>합계</td>';
        if (!c.num || c.noSum || c.key === 'consignees') return '<td></td>';
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
      toast('B/L 목록을 내려받는 중입니다…');
      let total;
      try {
        ({ rows, total } = await fetchDetail(state, { ...detailOpt(view.sort.detail || def.sort), limit: DETAIL_MAX, offset: 0 }));
      } catch (e) { toast('내보내기 실패: ' + e.message); return; }
      if (total > DETAIL_MAX && !confirm(`B/L ${fmt.int(total)}건 중 현재 정렬 순서로 앞의 ${fmt.int(DETAIL_MAX)}건만 내보냅니다.
전체가 필요하면 기간 · 조건을 좁혀서 나눠 내보내세요.

계속할까요?`)) return;
    }
    const extra = [...(def.csvExtra || []), ...(state.dir !== 'IN' ? def.csvExtraIo || [] : [])];
    const header = cols.map((c) => c.label).concat(extra.map(([l]) => l));
    const lines = rows.map((r) => cols.map((c) => {
      const v = c.get ? c.get(r) : r[c.key];
      return c.csv ? c.csv(v, r) : v;
    }).concat(extra.map(([, f]) => f(r))));
    saveCsv((state.dir !== 'IN' ? `${DIRS[state.dir]} ` : '') + def.label(), header, lines);
  }

  /** CSV 파일 내려받기. rows = 값 배열의 배열, period = 파일 이름에 붙일 기간 */
  function saveCsv(label, header, rows, period = periodLabel(state.from, state.to)) {
    const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '﻿' + [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
    const name = `${label.replace(/[\\/:*?"<>|\s]+/g, '_')}_${period.replace(/[\\/:*?"<>|\s()~]+/g, '_')}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`${name} 파일로 내보냈습니다.`);
  }

  // ── [실험] 고객 변화 보기 (supabase/stats_customers.sql 의 dash_customers) ─────
  // 상태 정의는 SQL 머리말 참고. 기준일 = 조회 기간 끝과 데이터 마지막 입항일 중 이른 날.
  const CUST_ST = {
    new: { label: '신규', desc: '조회 기간에 첫 실적', color: COLORS.gold },
    back: { label: '재개', desc: '3개월 넘게 쉬다가 다시 실적', color: '#5b7fa6' },
    keep: { label: '유지', desc: '최근 1개월 안에 실적', color: COLORS.navy700 },
    warn: { label: '주의', desc: '1~3개월 실적 없음', color: '#c9a23a' },
    lost: { label: '이탈 의심', desc: '3개월 넘게 실적 없음', color: '#a3403a' },
    gone: { label: '장기 미거래', desc: '6개월 넘게 실적 없음', color: COLORS.faint },
  };
  const cust = { st: 'all', search: '', sort: { key: 'teu', dir: -1 }, data: null };
  const stBadge = (st) => `<span class="st-badge st-${st}">${CUST_ST[st]?.label || st}</span>`;
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt.int(Math.abs(n));

  function buildViewSwitch() {
    const el = $('view-switch');
    // [시험] 고객 변화 · Shipper 연결은 수입 기준으로 만든 화면이라 수입 보기에서만
    el.innerHTML = [['volume', '물동량'], ...(state.dir === 'IN' ? [['customers', '고객 변화', true], ['shippers', 'Shipper 연결', true]] : [])]
      .map(([v, l, exp]) => `<button type="button" role="tab" data-v="${v}">${l}${exp ? '<span class="exp">시험</span>' : ''}</button>`).join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.v === state.view) return;
      state.view = b.dataset.v; update();
    });
    syncers.push(() => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.v === state.view)));
  }

  /** 고객 변화의 조회 기간: 기간을 고르지 않았으면 데이터 마지막 달(최근 1개월) */
  function custRange(s = state) {
    if (s.from || s.to) return { from: s.from || META.dateMin, to: s.to || META.dateMax, auto: false };
    return { ...monthRange(MONTHS[MONTHS.length - 1]), auto: true };
  }
  async function fetchCustomers(s = state) {
    const range = custRange(s);
    const cmp = compareRange(range.from, range.to);
    const opt = { from: range.from, to: range.to, basis: s.groupBy, ...(cmp && cmp.available ? { cmpFrom: cmp.from, cmpTo: cmp.to } : {}) };
    const res = await cached('customers', filterOf(s, { from: '', to: '' }), opt);
    const list = res.rows.map((a) => {
      const o = zip(res.fields, a);
      o.name = companyName(s.groupBy, o.key);
      o.code = s.groupBy === 'consignee' ? consigneeCode(o.key) : '';
      o.diff = o.teu - o.teuC;
      o.avg = o.mon ? o.teuH / o.mon : 0;
      o.idle = Math.round((parse(res.asOf) - parse(o.last)) / 864e5);
      return o;
    });
    return { ...res, range, cmp: cmp && cmp.available ? cmp : null, basis: s.groupBy, list };
  }

  async function updateCustomers(my) {
    setLoading(true);
    try {
      const D = await fetchCustomers(state);
      if (my !== seq) return;
      showNotice();
      if (D.range.auto) $('view-title').textContent = `${monthLabel(D.range.from.slice(0, 7))} (최근 1개월)`;
      cust.data = D;
      renderCustomers(D);
    } catch (e) {
      if (my !== seq) return;
      if (e.code === 'PGRST202') e.message = 'Supabase 에 고객 변화 함수가 없습니다. 시험 기능이라 supabase/stats_customers.sql 을 실행해야 볼 수 있습니다.';
      showNotice(e);
    } finally {
      setLoading(false);
    }
  }

  function renderCustomers(D) {
    const L = D.list;
    const of = (st) => L.filter((o) => o.st === st);
    const teuOf = (a) => a.reduce((x, o) => x + o.teu, 0);
    const avgOf = (a) => a.reduce((x, o) => x + o.avg, 0);
    const active = L.filter((o) => o.bl > 0);
    const bn = D.basis === 'notify' ? 'Notify' : 'Consignee';

    // KPI 카드: 누르면 아래 고객 목록을 그 상태로 거른다
    const cards = [
      { st: 'all', label: '실적 고객', value: fmt.int(active.length), unit: '곳', sub: `TEU ${fmt.int(teuOf(active))} · ${bn} 기준`,
        delta: deltaHtml(active.length, D.cmp ? L.filter((o) => o.blC > 0).length : null, D.cmp || compareRange(D.range.from, D.range.to)) },
      { st: 'new', value: D.newKnown ? fmt.int(of('new').length) : '–', unit: D.newKnown ? '곳' : '',
        sub: D.newKnown ? `TEU ${fmt.int(teuOf(of('new')))} · ${CUST_ST.new.desc}` : '데이터가 시작된 달이라 구분할 수 없음' },
      { st: 'back', value: fmt.int(of('back').length), unit: '곳', sub: CUST_ST.back.desc },
      { st: 'keep', value: fmt.int(of('keep').length), unit: '곳', sub: `TEU ${fmt.int(teuOf(of('keep')))} · ${CUST_ST.keep.desc}` },
      { st: 'warn', value: fmt.int(of('warn').length), unit: '곳', sub: `${CUST_ST.warn.desc} · 월평균 합 ${fmt.one(avgOf(of('warn')))} TEU` },
      { st: 'lost', value: fmt.int(of('lost').length), unit: '곳', sub: `${CUST_ST.lost.desc} · 월평균 합 ${fmt.one(avgOf(of('lost')))} TEU` },
    ];
    $('cust-kpis').innerHTML = cards.map((k) => `
      <button type="button" class="kpi" data-st="${k.st}" aria-pressed="${cust.st === k.st}" title="누르면 아래 고객 목록을 이 상태로 거릅니다">
        <span class="k-label">${k.st === 'all' ? '' : `<i class="k-dot" style="background:${CUST_ST[k.st].color}"></i>`}${k.label || CUST_ST[k.st].label}</span>
        <span class="k-value">${k.value}${k.unit ? `<small>${k.unit}</small>` : ''}</span>
        ${k.delta || ''}
        <span class="k-sub">${k.sub}</span>
      </button>`).join('');

    const notes = [`기준일 ${D.asOf}`];
    if (D.range.auto) notes.push(`기간을 고르지 않아 최근 1개월(${monthLabel(D.range.from.slice(0, 7))}) 기준`);
    notes.push(`고객 = ${bn}`, 'B/L Type E(엠티) 제외', '기간 외 조회 조건(ITEM 등)은 그대로 적용');
    if (D.cmp) notes.push(`비교 = ${D.cmp.label} (${D.cmp.from} ~ ${D.cmp.to})`);
    if (!D.newKnown) notes.push('데이터가 시작된 달이 포함되어 신규 · 재개는 유지로 표시');
    $('cust-note').textContent = notes.join(' · ');

    // 월별 고객 흐름
    const flow = chart('ch-cust-flow');
    flow.resize();
    flow.setOption(chartOptions.custFlow(D.months, D.firstMonth), true);
    flow.off('click');
    flow.on('click', (p) => { const m = D.months[p.dataIndex]; if (!m) return; const r = monthRange(m[0]); state.from = r.from; state.to = r.to; update(); });

    // 늘어난 · 줄어든 고객 상위 10
    const name = (o) => `<td class="trunc w-m">${esc(shortName(o.name))}</td>`;
    const cmpWord = D.cmp ? D.cmp.label : '비교 기간 없음';
    $('cust-up-sub').textContent = `${cmpWord} · TEU 기준`;
    $('cust-down-sub').textContent = `${cmpWord} · TEU 기준`;
    const diffRows = (rows, cls) => rows.map((o) => `${name(o)}<td class="r">${fmt.int(o.teuC)}</td><td class="r">${fmt.int(o.teu)}</td><td class="r ${cls}"><b>${signed(o.diff)}</b></td>`);
    const diffHead = '<th>고객</th><th class="r">비교</th><th class="r">조회 기간</th><th class="r">증감</th>';
    const noCmp = '비교 기간 데이터가 없습니다. 월 단위로 조회하면 직전 기간과 비교합니다.';
    const ups = D.cmp ? L.filter((o) => o.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 10) : [];
    const downs = D.cmp ? L.filter((o) => o.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 10) : [];
    custMini('cust-up', ups, diffHead, diffRows(ups, 'up'), D.cmp ? '늘어난 고객이 없습니다.' : noCmp);
    custMini('cust-down', downs, diffHead, diffRows(downs, 'down'), D.cmp ? '줄어든 고객이 없습니다.' : noCmp);

    // 놓치면 아까운 고객: 주의 · 이탈 의심 중 월평균 TEU 큰 순
    const risk = L.filter((o) => o.st === 'warn' || o.st === 'lost').sort((a, b) => b.avg - a.avg || b.teuH - a.teuH).slice(0, 10);
    custMini('cust-risk', risk, '<th>고객</th><th>상태</th><th>마지막 실적</th><th class="r">월평균 TEU</th>',
      risk.map((o) => `${name(o)}<td>${stBadge(o.st)}</td><td>${o.last} <small class="muted">(${fmt.int(o.idle)}일 전)</small></td><td class="r"><b>${fmt.one(o.avg)}</b></td>`),
      '주의 · 이탈 의심 고객이 없습니다.');

    // 고객 등급 (ABC)
    const graded = L.filter((o) => o.grade);
    const total = teuOf(graded);
    $('cust-grade').innerHTML = graded.length ? `<table class="data">
      <thead><tr><th>등급</th><th class="r">고객 수</th><th class="r">TEU</th><th class="r">TEU 비중</th><th class="r">고객당 평균 TEU</th></tr></thead>
      <tbody>${['A', 'B', 'C'].map((g) => {
        const a = graded.filter((o) => o.grade === g), t = teuOf(a);
        return `<tr><td><b>${g}</b></td><td class="r">${fmt.int(a.length)}</td><td class="r">${fmt.int(t)}</td><td class="r">${fmt.pct(t, total)}</td><td class="r">${a.length ? fmt.one(t / a.length) : '–'}</td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td>합계</td><td class="r">${fmt.int(graded.length)}</td><td class="r">${fmt.int(total)}</td><td class="r">100.0%</td><td class="r">${fmt.one(total / graded.length)}</td></tr></tfoot>
    </table>` : '<p class="empty-state">조회 기간에 TEU 실적이 있는 고객이 없습니다.</p>';

    // 상태 칩
    const counts = { all: L.length };
    L.forEach((o) => { counts[o.st] = (counts[o.st] || 0) + 1; });
    $('cust-st').innerHTML = ['all', ...Object.keys(CUST_ST)].filter((k) => k === 'all' || k === cust.st || counts[k])
      .map((k) => `<button type="button" class="chip" data-st="${k}" aria-pressed="${cust.st === k}">${k === 'all' ? '전체' : CUST_ST[k].label}<span class="cnt">${fmt.int(counts[k] || 0)}</span></button>`).join('');
    renderCustTable();
  }

  /** 고객 변화의 작은 표(순위 + 칸들). 줄을 누르면 그 업체의 물동량 화면으로 */
  function custMini(id, rows, head, cells, empty, onRow = (o) => openCompany(o.key), hint = '누르면 이 업체의 물동량 화면으로 갑니다') {
    const wrap = $(id);
    if (!rows.length) { wrap.innerHTML = `<p class="empty-state">${esc(empty)}</p>`; wrap.onclick = null; return; }
    wrap.innerHTML = `<table class="data"><thead><tr><th class="r">순위</th>${head}</tr></thead><tbody>${rows.map((o, i) =>
      `<tr data-i="${i}" title="${esc(o.name)} · ${hint}"><td class="r muted">${i + 1}</td>${cells[i]}</tr>`).join('')}</tbody></table>`;
    wrap.onclick = (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) onRow(rows[+tr.dataset.i]); };
  }

  function openCompany(k) {
    const key = state.groupBy;
    if (!state[key].includes(k)) state[key].push(k);
    state.view = 'volume';
    update();
  }

  function custCols(D) {
    return [
      C('name', '업체명', esc, { cls: 'trunc w-m' }),
      ...(D.basis === 'consignee' ? [C('code', '사업자번호')] : []),
      C('st', '상태', stBadge, { csv: (v) => CUST_ST[v]?.label || v }),
      C('grade', '등급', (v) => esc(v || '–'), { csv: (v) => v }),
      C('teu', '기간 TEU', fmt.int, { num: true }),
      ...(D.cmp ? [C('teuC', '비교 TEU', fmt.int, { num: true }), C('diff', '증감', signed, { num: true, cls: (o) => (o.diff > 0 ? 'up' : o.diff < 0 ? 'down' : '') })] : []),
      C('bl', '기간 B/L', fmt.int, { num: true }),
      C('first', '첫 실적'), C('last', '마지막 실적'),
      C('idle', '경과일', fmt.int, { num: true }),
      C('avg', '월평균 TEU', fmt.one, { num: true, csv: (v) => v.toFixed(2) }),
      C('mon', '실적 개월', fmt.int, { num: true }),
    ];
  }

  function custFiltered() {
    const D = cust.data;
    let rows = cust.st === 'all' ? D.list : D.list.filter((o) => o.st === cust.st);
    if (cust.search) rows = rows.filter((o) => `${o.name} ${o.code} ${o.key}`.toLowerCase().includes(cust.search));
    return sortRows(rows, custCols(D), cust.sort);
  }

  function renderCustTable() {
    const D = cust.data;
    if (!D) return;
    const cols = custCols(D);
    const rows = custFiltered();
    const LIMIT = 500;
    $('cust-count').textContent = `${fmt.int(rows.length)}곳${rows.length > LIMIT ? ` · 앞 ${LIMIT}곳만 표시 (CSV 는 전체)` : ''}`;
    sortableTable('cust-tbl', cols, rows.slice(0, LIMIT), cust.sort, '해당하는 고객이 없습니다.', (o) => o.key);
  }

  /** 고객 · Shipper 목록 공통 표: 머리글 정렬 화살표, 줄마다 data-k(누르면 업체로 이동하는 키) */
  function sortableTable(id, cols, rows, sort, empty, keyOf) {
    const cell = (c, o) => { const v = o[c.key]; const cls = typeof c.cls === 'function' ? c.cls(o) : c.cls || ''; return `<td class="${c.num ? 'r' : ''} ${cls}"${/\btrunc\b/.test(cls) ? ` title="${esc(c.title ? c.title(o) : v)}"` : ''}>${c.f(v, o)}</td>`; };
    $(id).innerHTML = `<table class="data">
      <thead><tr><th class="r">No</th>${cols.map((c) => `<th class="sortable ${c.num ? 'r' : ''}" data-k="${c.key}">${c.label}<span class="arrow">${sort.key === c.key ? (sort.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.map((o, i) => `<tr data-k="${esc(keyOf(o))}"><td class="r muted">${i + 1}</td>${cols.map((c) => cell(c, o)).join('')}</tr>`).join('')
        : `<tr><td colspan="${cols.length + 1}" class="muted">${empty}</td></tr>`}</tbody>
    </table>`;
    $(id).scrollTop = 0;
  }

  function buildCustomers() {
    $('cust-kpis').addEventListener('click', (e) => {
      const b = e.target.closest('[data-st]'); if (!b || !cust.data) return;
      cust.st = cust.st === b.dataset.st ? 'all' : b.dataset.st;
      renderCustomers(cust.data);
    });
    $('cust-st').addEventListener('click', (e) => {
      const b = e.target.closest('[data-st]'); if (!b || !cust.data) return;
      cust.st = b.dataset.st;
      renderCustomers(cust.data);
    });
    $('cust-search').addEventListener('input', (e) => { cust.search = e.target.value.trim().toLowerCase(); renderCustTable(); });
    $('cust-tbl').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]');
      if (th) {
        const k = th.dataset.k, col = custCols(cust.data).find((c) => c.key === k);
        cust.sort = { key: k, dir: cust.sort.key === k ? -cust.sort.dir : col.num ? -1 : 1 };
        renderCustTable();
        return;
      }
      const tr = e.target.closest('tbody tr[data-k]');
      if (tr) openCompany(tr.dataset.k);
    });
    $('cust-csv').addEventListener('click', () => {
      const D = cust.data; if (!D) return;
      const cols = custCols(D);
      const rows = custFiltered().map((o) => cols.map((c) => (c.csv ? c.csv(o[c.key], o) : o[c.key])));
      const label = `고객변화_${cust.st === 'all' ? '전체' : CUST_ST[cust.st].label}`;
      saveCsv(label, cols.map((c) => c.label), rows, periodLabel(D.range.from, D.range.to));
    });
  }

  // ── [실험] Shipper 연결 보기 (supabase/stats_shippers.sql 의 dash_shippers) ─────
  // 연결 = Shipper × 상대편(Consignee 또는 Notify). 상태: new(첫 거래가 조회 기간 안) · keep(이어짐) · lost(비교 기간에만 있음)
  const PAIR_ST = { new: '새 연결', keep: '이어짐', lost: '끊긴 연결' };
  const pairBadge = (st) => `<span class="st-badge st-${st}">${PAIR_ST[st]}</span>`;
  const ship = { st: 'all', search: '', focus: '', sort: { key: 'teu', dir: -1 }, data: null };

  async function fetchShippers(s = state) {
    const range = custRange(s);
    const cmp = compareRange(range.from, range.to);
    const ok = !!(cmp && cmp.available);
    const opt = { from: range.from, to: range.to, basis: s.groupBy, ...(ok ? { cmpFrom: cmp.from, cmpTo: cmp.to } : {}) };
    const res = await cached('shippers', filterOf(s, { from: '', to: '' }), opt);
    const shippers = res.shippers.map((a) => zip(res.sFields, a));
    const byKey = new Map(shippers.map((o) => [o.key, o]));
    const pairs = res.pairs.map((a) => {
      const o = zip(res.pFields, a);
      o.sname = byKey.get(o.s)?.name || o.s;
      o.name = companyName(s.groupBy, o.k);
      o.code = s.groupBy === 'consignee' ? consigneeCode(o.k) : '';
      o.diff = o.teu - o.teuC;
      o.st = o.bl === 0 ? 'lost' : res.newKnown && o.first >= res.from ? 'new' : 'keep';
      return o;
    });
    return { ...res, range, cmp: ok ? cmp : null, basis: s.groupBy, shippers, pairs };
  }

  async function updateShippers(my) {
    setLoading(true);
    try {
      const D = await fetchShippers(state);
      if (my !== seq) return;
      showNotice();
      if (D.range.auto) $('view-title').textContent = `${monthLabel(D.range.from.slice(0, 7))} (최근 1개월)`;
      if (ship.focus && !D.shippers.some((o) => o.key === ship.focus)) ship.focus = '';
      ship.data = D;
      renderShippers(D);
    } catch (e) {
      if (my !== seq) return;
      if (e.code === 'PGRST202') e.message = 'Supabase 에 Shipper 연결 함수가 없습니다. 시험 기능이라 supabase/stats_shippers.sql 을 실행해야 볼 수 있습니다.';
      showNotice(e);
    } finally {
      setLoading(false);
    }
  }

  function renderShippers(D) {
    const bn = D.basis === 'notify' ? 'Notify' : 'Consignee';
    const sum = (a, k = 'teu') => a.reduce((x, o) => x + o[k], 0);
    const act = D.shippers.filter((o) => o.bl > 0);
    const total = sum(act);
    const tops = [...act].sort((a, b) => b.teu - a.teu || b.bl - a.bl).slice(0, 10);
    const one = act.filter((o) => o.n === 1);
    const hubs = act.filter((o) => o.n >= 3);
    const pNew = D.pairs.filter((p) => p.st === 'new'), pLost = D.pairs.filter((p) => p.st === 'lost');
    $('ship-side').textContent = bn;

    const cards = [
      { label: '실적 Shipper', value: fmt.int(act.length), unit: '곳', sub: `TEU ${fmt.int(total)} · 연결 ${fmt.int(D.pairs.length - pLost.length)}개`,
        delta: deltaHtml(act.length, D.cmp ? D.shippers.filter((o) => o.blC > 0).length : null, D.cmp || compareRange(D.range.from, D.range.to)) },
      { label: '상위 10곳 비중', value: fmt.pct(sum(tops), total), sub: 'TEU 기준 · 높을수록 소수에 집중' },
      { label: '1:1 거래 Shipper', value: fmt.pct(one.length, act.length), sub: `${fmt.int(one.length)}곳 · ${bn} 1곳에만 보냄` },
      { label: '허브 Shipper', value: fmt.int(hubs.length), unit: '곳', sub: `${bn} 3곳 이상 · TEU 비중 ${fmt.pct(sum(hubs), total)}` },
      { st: 'new', label: '새 연결', value: D.newKnown ? fmt.int(pNew.length) : '–', unit: D.newKnown ? '개' : '',
        sub: D.newKnown ? `TEU ${fmt.int(sum(pNew))} · 조회 기간에 첫 거래` : '데이터가 시작된 달이라 구분할 수 없음' },
      { st: 'lost', label: '끊긴 연결', value: D.cmp ? fmt.int(pLost.length) : '–', unit: D.cmp ? '개' : '',
        sub: D.cmp ? `비교 기간 TEU ${fmt.int(sum(pLost, 'teuC'))}` : '비교 기간 데이터 없음' },
    ];
    $('ship-kpis').innerHTML = cards.map((k) => {
      const tag = k.st ? 'button' : 'div';
      return `<${tag}${k.st ? ` type="button" data-st="${k.st}" aria-pressed="${ship.st === k.st}" title="누르면 아래 연결 목록을 이 상태로 거릅니다"` : ''} class="kpi">
        <span class="k-label">${k.label}</span>
        <span class="k-value">${k.value}${k.unit ? `<small>${k.unit}</small>` : ''}</span>
        ${k.delta || ''}
        <span class="k-sub">${k.sub}</span>
      </${tag}>`;
    }).join('');

    const notes = [`기준일 ${D.asOf}`];
    if (D.range.auto) notes.push(`기간을 고르지 않아 최근 1개월(${monthLabel(D.range.from.slice(0, 7))}) 기준`);
    notes.push(`상대편 = ${bn}`, '표기만 다른 Shipper 이름(띄어쓰기 · 점 · 대소문자)은 하나로 합침', 'B/L Type E(엠티) 제외');
    if (D.cmp) notes.push(`비교 = ${D.cmp.label} (${D.cmp.from} ~ ${D.cmp.to})`);
    $('ship-note').textContent = notes.join(' · ');

    // 연결 흐름(Sankey). 휴대폰처럼 좁으면 그리지 않고 아래 표를 보게 한다.
    const box = $('ch-ship-flow');
    const narrow = box.parentElement.clientWidth < 560;
    box.hidden = narrow;
    $('ship-flow-note').textContent = narrow
      ? '화면이 좁아 흐름도를 생략했습니다. 아래 허브 Shipper · 연결 목록을 보세요.'
      : `왼쪽 = Shipper(중국 측), 오른쪽 = ${bn}(한국 측), 선 굵기 = TEU. 상위 업체 외에는 "기타"로 묶었습니다. Shipper 를 누르면 아래 연결 목록을 그 Shipper 로 거릅니다.`;
    if (!narrow) {
      const c = chart('ch-ship-flow');
      c.resize();
      c.setOption(shipFlowOption(D, box.clientWidth), true);
      c.off('click');
      c.on('click', (p) => { if (p.dataType === 'node' && p.data.name.startsWith('S|')) focusShipper(p.data.name.slice(2)); });
    }

    // 허브 · 상위 10 · 새 연결 · 끊긴 연결
    const sCell = (n) => `<td class="trunc w-m" title="${esc(n)}">${esc(n)}</td>`;
    const cCell = (o) => `<td class="trunc w-m" title="${esc(o.name)}">${esc(shortName(o.name))}</td>`;
    const toFocus = (o) => focusShipper(o.key || o.s);
    const hubRows = [...act].sort((a, b) => b.n - a.n || b.teu - a.teu).filter((o) => o.n > 1).slice(0, 10);
    custMini('ship-hub', hubRows, `<th>Shipper</th><th class="r">${bn} 수</th><th class="r">TEU</th><th class="r">B/L</th>`,
      hubRows.map((o) => `${sCell(o.name)}<td class="r"><b>${fmt.int(o.n)}</b></td><td class="r">${fmt.int(o.teu)}</td><td class="r">${fmt.int(o.bl)}</td>`),
      `${bn} 여러 곳에 보낸 Shipper 가 없습니다.`, toFocus, '누르면 아래 연결 목록을 이 Shipper 로 거릅니다');
    custMini('ship-top', tops, `<th>Shipper</th><th class="r">${bn} 수</th><th class="r">TEU</th><th class="r">비중</th>${D.cmp ? '<th class="r">증감</th>' : ''}`,
      tops.map((o) => `${sCell(o.name)}<td class="r">${fmt.int(o.n)}</td><td class="r"><b>${fmt.int(o.teu)}</b></td><td class="r">${fmt.pct(o.teu, total)}</td>${D.cmp ? `<td class="r ${o.teu > o.teuC ? 'up' : o.teu < o.teuC ? 'down' : ''}">${signed(o.teu - o.teuC)}</td>` : ''}`),
      'Shipper 실적이 없습니다.', toFocus, '누르면 아래 연결 목록을 이 Shipper 로 거릅니다');
    const newRows = [...pNew].sort((a, b) => b.teu - a.teu || b.bl - a.bl).slice(0, 10).map((p) => ({ ...p, name: p.name }));
    custMini('ship-new', newRows, `<th>Shipper</th><th>${bn}</th><th class="r">TEU</th><th>첫 거래</th>`,
      newRows.map((p) => `${sCell(p.sname)}${cCell(p)}<td class="r"><b>${fmt.int(p.teu)}</b></td><td>${p.first}</td>`),
      D.newKnown ? '새 연결이 없습니다.' : '데이터가 시작된 달이라 새 연결을 구분할 수 없습니다.', toFocus, '누르면 아래 연결 목록을 이 Shipper 로 거릅니다');
    const lostRows = [...pLost].sort((a, b) => b.teuC - a.teuC || b.blC - a.blC).slice(0, 10);
    $('ship-lost-sub').textContent = D.cmp ? `${D.cmp.label} · 비교 기간에는 있었고 조회 기간에는 없음` : '비교 기간 데이터 없음';
    custMini('ship-lost', lostRows, `<th>Shipper</th><th>${bn}</th><th class="r">비교 TEU</th><th>마지막 거래</th>`,
      lostRows.map((p) => `${sCell(p.sname)}${cCell(p)}<td class="r"><b>${fmt.int(p.teuC)}</b></td><td>${p.last}</td>`),
      D.cmp ? '끊긴 연결이 없습니다.' : '비교 기간 데이터가 없습니다. 월 단위로 조회하면 직전 기간과 비교합니다.', toFocus, '누르면 아래 연결 목록을 이 Shipper 로 거릅니다');

    renderShipChips();
    renderShipTable();
  }

  /** Sankey: 상위 Shipper 12곳 → 상대편 상위 15곳(나머지는 '기타'). 노드 순서를 고정(layoutIterations 0)해 TEU 큰 순으로 위에서부터 */
  function shipFlowOption(D, width) {
    const bn = D.basis === 'notify' ? 'Notify' : 'Consignee';
    const top = D.shippers.filter((o) => o.teu > 0).sort((a, b) => b.teu - a.teu).slice(0, 12);
    if (!top.length) return emptyChart('조회 기간에 TEU 실적이 있는 Shipper 가 없습니다.');
    const topSet = new Set(top.map((o) => o.key));
    const links0 = D.pairs.filter((p) => topSet.has(p.s) && p.teu > 0);
    const side = new Map();
    links0.forEach((p) => side.set(p.k, (side.get(p.k) || 0) + p.teu));
    const sideTop = [...side].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k]) => k);
    const keep = new Set(sideTop);
    const nodes = [
      ...top.map((o) => ({ name: 'S|' + o.key, _t: o.name, itemStyle: { color: COLORS.navy700 }, label: { position: 'left' } })),
      ...sideTop.map((k) => ({ name: 'C|' + k, _t: shortName(companyName(D.basis, k)), itemStyle: { color: COLORS.gold }, label: { position: 'right' } })),
    ];
    const links = new Map();
    links0.forEach((p) => {
      const src = 'S|' + p.s, tgt = keep.has(p.k) ? 'C|' + p.k : 'C|*';
      const l = links.get(src + '>' + tgt) || { source: src, target: tgt, value: 0, bl: 0 };
      l.value += p.teu; l.bl += p.bl;
      links.set(src + '>' + tgt, l);
    });
    if ([...links.values()].some((l) => l.target === 'C|*')) nodes.push({ name: 'C|*', _t: `기타 ${bn}`, itemStyle: { color: COLORS.navy300 }, label: { position: 'right' } });
    const text = new Map(nodes.map((n) => [n.name, n._t]));
    const side1 = Math.min(230, Math.round(width * 0.28)), side2 = Math.min(190, Math.round(width * 0.24));
    return {
      ...baseOption(),
      tooltip: {
        ...baseOption().tooltip, trigger: 'item',
        formatter: (p) => (p.dataType === 'edge'
          ? `${esc(text.get(p.data.source))}<br>→ ${esc(text.get(p.data.target))}<br><b>${fmt.int(p.data.value)} TEU</b> · B/L ${fmt.int(p.data.bl)}건`
          : `<b>${esc(p.data._t)}</b><br>${fmt.int(p.value)} TEU`),
      },
      series: [{
        type: 'sankey', left: side1, right: side2, top: 8, bottom: 8, nodeWidth: 10, nodeGap: 6, layoutIterations: 0, draggable: false,
        emphasis: { focus: 'adjacency' },
        data: nodes, links: [...links.values()],
        lineStyle: { color: 'gradient', opacity: 0.3, curveness: 0.5 },
        label: { fontSize: 11, color: COLORS.ink, formatter: (p) => p.data._t, width: side1 - 12, overflow: 'truncate' },
      }],
    };
  }

  function focusShipper(key) {
    ship.focus = key; ship.st = 'all';
    renderShipChips(); renderShipTable();
    $('ship-tbl').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderShipChips() {
    const D = ship.data;
    const counts = { all: D.pairs.length };
    D.pairs.forEach((p) => { counts[p.st] = (counts[p.st] || 0) + 1; });
    const focus = ship.focus ? D.shippers.find((o) => o.key === ship.focus) : null;
    $('ship-st').innerHTML = ['all', 'new', 'keep', 'lost'].filter((k) => k === 'all' || k === ship.st || counts[k])
      .map((k) => `<button type="button" class="chip" data-st="${k}" aria-pressed="${ship.st === k}">${k === 'all' ? '전체' : PAIR_ST[k]}<span class="cnt">${fmt.int(counts[k] || 0)}</span></button>`).join('') +
      (focus ? ` <span class="fchip"><span><b>Shipper</b> ${esc(focus.name)}</span><button type="button" data-unfocus aria-label="Shipper 선택 해제">×</button></span>` : '');
    $('ship-kpis').querySelectorAll('[data-st]').forEach((b) => b.setAttribute('aria-pressed', ship.st === b.dataset.st));
  }

  function shipCols(D) {
    return [
      C('sname', 'Shipper', esc, { cls: 'trunc w-m' }),
      C('name', D.basis === 'notify' ? 'Notify' : 'Consignee', (v) => esc(shortName(v)), { cls: 'trunc w-m' }),
      ...(D.basis === 'consignee' ? [C('code', '사업자번호')] : []),
      C('st', '상태', pairBadge, { csv: (v) => PAIR_ST[v] }),
      C('teu', '기간 TEU', fmt.int, { num: true }),
      ...(D.cmp ? [C('teuC', '비교 TEU', fmt.int, { num: true }), C('diff', '증감', signed, { num: true, cls: (o) => (o.diff > 0 ? 'up' : o.diff < 0 ? 'down' : '') })] : []),
      C('bl', '기간 B/L', fmt.int, { num: true }),
      C('first', '첫 거래'), C('last', '마지막 거래'),
    ];
  }

  function shipFiltered() {
    const D = ship.data;
    let rows = D.pairs;
    if (ship.focus) rows = rows.filter((p) => p.s === ship.focus);
    if (ship.st !== 'all') rows = rows.filter((p) => p.st === ship.st);
    if (ship.search) rows = rows.filter((p) => `${p.sname} ${p.name} ${p.code}`.toLowerCase().includes(ship.search));
    return sortRows(rows, shipCols(D), ship.sort);
  }

  function renderShipTable() {
    const D = ship.data;
    if (!D) return;
    const rows = shipFiltered();
    const LIMIT = 500;
    $('ship-count').textContent = `${fmt.int(rows.length)}개 연결${rows.length > LIMIT ? ` · 앞 ${LIMIT}개만 표시 (CSV 는 전체)` : ''}`;
    sortableTable('ship-tbl', shipCols(D), rows.slice(0, LIMIT), ship.sort, '해당하는 연결이 없습니다.', (p) => p.k);
  }

  function buildShippers() {
    const setSt = (st) => { ship.st = ship.st === st && st !== 'all' ? 'all' : st; renderShipChips(); renderShipTable(); };
    $('ship-kpis').addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (b && ship.data) setSt(b.dataset.st); });
    $('ship-st').addEventListener('click', (e) => {
      if (!ship.data) return;
      if (e.target.closest('[data-unfocus]')) { ship.focus = ''; renderShipChips(); renderShipTable(); return; }
      const b = e.target.closest('[data-st]'); if (b) setSt(b.dataset.st);
    });
    $('ship-search').addEventListener('input', (e) => { ship.search = e.target.value.trim().toLowerCase(); renderShipTable(); });
    $('ship-tbl').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]');
      if (th) {
        const k = th.dataset.k, col = shipCols(ship.data).find((c) => c.key === k);
        ship.sort = { key: k, dir: ship.sort.key === k ? -ship.sort.dir : col.num ? -1 : 1 };
        renderShipTable();
        return;
      }
      const tr = e.target.closest('tbody tr[data-k]');
      if (tr) openCompany(tr.dataset.k);
    });
    $('ship-csv').addEventListener('click', () => {
      const D = ship.data; if (!D) return;
      const cols = shipCols(D);
      const rows = shipFiltered().map((o) => cols.map((c) => (c.csv ? c.csv(o[c.key], o) : o[c.key])));
      saveCsv(`Shipper연결_${ship.st === 'all' ? '전체' : PAIR_ST[ship.st]}`, cols.map((c) => c.label), rows, periodLabel(D.range.from, D.range.to));
    });
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
    $('view-volume').hidden = state.view !== 'volume';
    $('view-customers').hidden = state.view !== 'customers';
    $('view-shippers').hidden = state.view !== 'shippers';
    $('opt-metric').hidden = state.view !== 'volume';
    if (state.view === 'customers') { updateCustomers(my); return; }
    if (state.view === 'shippers') { updateShippers(my); return; }
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
    // 수출 · 전체: 기간 · 업체 · ITEM 목록을 그 구분의 것으로 바꾼다 (서버가 아직 이전 SQL 이면 수입으로)
    if (state.dir !== 'IN') {
      const m = META.byDir?.[state.dir], o = opts.byDir?.[state.dir];
      if (m && o) { Object.assign(META, m); opts = o; } else { state.dir = 'IN'; saveHash(); }
    }
    buildDirSwitch();
    if (!META.rows) {
      if (state.dir === 'OUT') fatal('아직 수출 데이터가 없습니다.', '관리자가 [수입] 보기의 [수출 데이터 올리기]로 수출 운임 엑셀을 올린 뒤 새로고침하세요.');
      else fatal('아직 데이터가 없습니다.', '운임 필터 탭에서 운임 엑셀을 클라우드에 동기화한 뒤 새로고침하세요.');
      return;
    }
    applyDirLabels();
    MONTHS = META.months;
    YEARS = [...new Set(MONTHS.map((m) => m.slice(0, 4)))];
    opts.consignee.forEach(([k, code, name, n]) => COMPANIES.set(k, { code: code || '', name: name || k, n }));
    NOTIFIES = opts.notify;

    $('brand-mark').textContent = vesselLabel();
    $('data-meta').textContent = `${state.dir !== 'IN' ? `${DIRS[state.dir]} · ` : ''}${vesselLabel()} · 데이터 ${META.dateMin} ~ ${META.dateMax} · B/L ${fmt.int(META.rows)}건`;
    $('foot').innerHTML = state.dir === 'IN'
      ? `<span>원본: 운임 데이터 클라우드 동기화 (Supabase)</span><span>최근 반영: ${esc(META.syncedAt)}</span><span>TEU = 20'×1 + 40'×2 + 45'×2</span><span>금액은 모두 Collect 기준, 총 청구액 = 원화 + 외화(원 환산)</span>`
      : `<span>원본: 수입 = 운임 데이터 클라우드 동기화, 수출 = 대시보드 수출 데이터 올리기 (Supabase)</span><span>최근 반영: ${esc(META.syncedAt)}</span>`
        + `<span>TEU = 20'×1 + 40'×2 + 45'×2 (수출은 20RF · 40RF 포함, B/L Type E 는 0)</span>`
        + `<span>총 청구액 = 수입 Collect + 수출 Prepaid · Collect. 한국 금액 = 수입 CC + 수출 PP, 중국 금액 = 수출 CC (수입 PP 미집계)</span>`;
    buildFilters();
    buildTabs();
    buildViewSwitch();
    buildCustomers();
    buildShippers();
    showNotice();

    window.Dash = {
      META, MONTHS, YEARS, CARGO, DETAIL_MAX, RF, KRW_CHARGES, USD_CHARGES, NONE, METRICS, COLORS, QC,
      state, fmt, esc, fetchSummary, fetchTotals, fetchDetail, topCompanies, reeferSummary, reeferTop, subsetTop, SUBSETS, RF_TEU, rate, shortName, chartOptions,
      consigneeName, consigneeCode, notifyName, companyName, placeName, vesselLabel, DIRS, cAx, nAx, rfNote, dry, cntrCols, trendNote, MT_TYPES, mtGroups, SHIP_CAP, capPct,
      companyList: (basis) => (basis === 'notify'
        ? NOTIFIES.filter(([k]) => k !== NONE).map(([k, n]) => ({ key: k, n, name: k, code: '' }))
        : [...COMPANIES].filter(([k]) => k !== NONE).map(([k, c]) => ({ key: k, n: c.n, name: c.name, code: c.code }))),
      periodLabel, compareRange, monthRange, yearRange, monthLabel, describeFilters, kpiList, toast, setLoading,
    };
    document.dispatchEvent(new Event('dash:ready'));

    update();
    window.addEventListener('hashchange', () => {
      const h = loadHash();
      if (h.dir !== state.dir) { location.reload(); return; } // 수입 · 수출 · 전체가 바뀌면 목록부터 다시
      Object.assign(state, h); update();
    });
  }

  /** 맨 위 수입 · 수출 · 전체 전환. 바꾸면 그 구분의 기간 · 업체 · ITEM 목록을 다시 받으려고 새로고침 */
  function buildDirSwitch() {
    const el = $('dir-switch');
    el.hidden = false;
    seg(el, Object.entries({ IN: '수입', OUT: '수출', ALL: '전체' }), () => state.dir, (v) => {
      if (v === state.dir) return;
      state.dir = v;
      state.notify = []; // 두 번째 업체 축(Notify ↔ Forwarder)의 뜻이 바뀌므로 해제
      state.view = 'volume';
      saveHash();
      location.reload();
    });
  }

  /** 수출 · 전체 보기의 화면 글자 · 숨김 (수입 보기는 그대로) */
  function applyDirLabels() {
    document.querySelectorAll('[data-ax="c"]').forEach((e) => { e.textContent = cAx(); });
    document.querySelectorAll('[data-ax="n"]').forEach((e) => { e.textContent = nAx(); });
    if (state.dir === 'IN') return;
    if (state.view !== 'volume') state.view = 'volume';
    METRICS.total.label = '총 금액';
    QC.find((q) => q.key === 'notify').title = `${nAx()} 미지정 (참고)`;
    QC.find((q) => q.key === 'notify').desc = `${nAx()}가 없는 B/L입니다. 오류가 아닐 수 있습니다.`;
    $('hint-company').textContent = `"하나라도"를 고르면 ${cAx()} 또는 ${nAx()} 중 한쪽만 맞아도 조회됩니다.`;
    $('rf-filter-note').textContent = rfNote();
    $('rf-top-note').textContent = `${rfNote()} · TEU 기준`;
    $('charge-note').textContent = state.dir === 'ALL' ? '수입 Collect + 수출 Prepaid · Collect' : 'Prepaid · Collect';
    ['card-money', 'card-mt'].forEach((id) => { $(id).hidden = false; });
    $('ch-place').hidden = true;
    if (state.dir === 'OUT') ['sec-ex', 'card-ex', 'card-ex-top'].forEach((id) => { $(id).hidden = true; });
  }

  boot();
})();
