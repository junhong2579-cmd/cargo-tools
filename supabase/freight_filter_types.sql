-- =====================================================================
-- 운임 필터 [운임 종류] 보기: 검색 결과를 같은 운임끼리 묶어 가장 최근 1건만 보냅니다.
--   화물 도구(cargo-tool.html) 운임 필터의 [전체 기록 | 운임 종류] 전환 중 [운임 종류]가 씁니다.
--   [전체 기록]은 지금처럼 freight_records 를 직접 조회(최대 500건)하며 이 파일과 상관없습니다.
--
--   같은 운임 = 아래 26칸이 모두 같음 (사용자 확정 2026-10-23)
--     글자: cargo, bt, consignee_code, consignee, notify, actual_shipper, a_shipper_code, item, remark
--           (앞뒤 공백 · 겹친 공백 · 대소문자 무시, 빈칸 = 없음)
--     숫자: twenty, forty, forty_five, ts, crs_c, lss_c, pss_c, frt_c, esc, caf, baf_c, thc, ccf, doc, wfg, tsf, psc
--           ('0' · '0.00' · '' 은 모두 0 으로 같게 봄)
--   화면의 예비 계산(freightTypeKey, cargo-tool.html)도 같은 기준이어야 합니다. 기준을 바꾸면 두 곳을 함께 고치고
--   scripts/dash-test/freight_types.mjs 로 같은지 확인합니다.
--
--   검색 조건 p (jsonb) = { col: 검색 칸(아래 목록), q: 검색어(부분 일치, 대소문자 무시), from: 'YYYY-MM-DD' 이후 입항만(없으면 전체),
--                          limit: 최대 운임 종류 수(기본 500) }
--   freight_filter_types(p)     → { rows: [운임 종류마다 가장 최근 B/L 1건의 모든 칸 + same_count · first_date · last_date,
--                                          같은 운임 건수가 많은 순(같으면 최근 입항 순), 최대 limit 종류],
--                                    total: 합치기 전 B/L 수, types: 운임 종류 수 }
--   freight_filter_type_bls(p)  → p.bl 과 같은 운임인 B/L 목록 (같은 검색 조건 안에서, 최근 입항 순, 최대 1,000건)
--
--   로그인 사용자 권한(freight_records 의 RLS)을 그대로 따릅니다(security invoker).
--   입항일 해석 · 글자/숫자 정리는 대시보드와 같은 dash_date · dash_text · dash_num (supabase/dashboard.sql) 을 씁니다.
--
--   여러 번 실행해도 안전합니다. 기존 함수(운임 체크 get_past_freight_since 등)는 바꾸지 않습니다.
--   되돌리기:
--     drop function if exists public.freight_filter_type_bls(jsonb);
--     drop function if exists public.freight_filter_types(jsonb);
--     drop function if exists public.freight_type_key(public.freight_records);
-- =====================================================================

-- 같은 운임인지 가리는 기준 (26칸을 정리해 한 줄로 이음)
create or replace function public.freight_type_key(f public.freight_records) returns text
language sql immutable set search_path = public as $$
  select concat_ws(chr(31),
    upper(coalesce(public.dash_text(f.cargo::text), '')),
    upper(coalesce(public.dash_text(f.bt::text), '')),
    upper(coalesce(public.dash_text(f.consignee_code::text), '')),
    upper(coalesce(public.dash_text(f.consignee::text), '')),
    upper(coalesce(public.dash_text(f.notify::text), '')),
    upper(coalesce(public.dash_text(f.actual_shipper::text), '')),
    upper(coalesce(public.dash_text(f.a_shipper_code::text), '')),
    upper(coalesce(public.dash_text(f.item::text), '')),
    upper(coalesce(public.dash_text(f.remark::text), '')),
    trim_scale(public.dash_num(f.twenty::text))::text,
    trim_scale(public.dash_num(f.forty::text))::text,
    trim_scale(public.dash_num(f.forty_five::text))::text,
    trim_scale(public.dash_num(f.ts::text))::text,
    trim_scale(public.dash_num(f.crs_c::text))::text,
    trim_scale(public.dash_num(f.lss_c::text))::text,
    trim_scale(public.dash_num(f.pss_c::text))::text,
    trim_scale(public.dash_num(f.frt_c::text))::text,
    trim_scale(public.dash_num(f.esc::text))::text,
    trim_scale(public.dash_num(f.caf::text))::text,
    trim_scale(public.dash_num(f.baf_c::text))::text,
    trim_scale(public.dash_num(f.thc::text))::text,
    trim_scale(public.dash_num(f.ccf::text))::text,
    trim_scale(public.dash_num(f.doc::text))::text,
    trim_scale(public.dash_num(f.wfg::text))::text,
    trim_scale(public.dash_num(f.tsf::text))::text,
    trim_scale(public.dash_num(f.psc::text))::text)
$$;

-- 검색 칸은 화면 선택 목록(FREIGHT_FILTER_TO_DB_COL)과 같은 칸만 받습니다.
create or replace function public.freight_filter_types(p jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  col   text := coalesce(nullif(p ->> 'col', ''), 'consignee');
  q     text := btrim(coalesce(p ->> 'q', ''));
  dfrom date := nullif(p ->> 'from', '')::date;
  lim   int  := least(greatest(coalesce((p ->> 'limit')::int, 500), 1), 2000);
  res   jsonb;
begin
  if col not in ('consignee', 'bl_no', 'consignee_code', 'actual_shipper', 'a_shipper_code', 'io_date',
                 'voyage', 'notify', 'remark', 'item', 'description', 'shipper') then
    raise exception '검색할 수 없는 칸입니다: %', col;
  end if;
  if q = '' then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'types', 0);
  end if;
  -- 검색어는 화면의 [전체 기록](supabase .ilike('%검색어%'))과 같은 방식으로 찾습니다.
  execute format($sql$
    with t as (
      select f.*, public.dash_date(f.io_date::text) as d, public.freight_type_key(f) as k
      from public.freight_records f
      where f.%1$I::text ilike $1
        and ($2::date is null or public.dash_date(f.io_date::text) >= $2)
    ), g as (
      select k, count(*) as n, min(d) as first_d, max(d) as last_d from t group by k
    ), u as (
      -- 같은 운임 중 가장 최근 입항 1건 (같은 날이면 B/L 번호가 큰 것)
      select distinct on (k) * from t order by k, d desc nulls last, bl_no desc
    ), top as (
      -- 많이 적용된 운임 종류 순 (같으면 최근 입항 순)
      select u.*, g.n as same_n, g.first_d, g.last_d
      from u join g using (k)
      order by g.n desc, u.d desc nulls last, u.bl_no desc limit $3
    )
    select jsonb_build_object(
      'total', (select count(*) from t),
      'types', (select count(*) from g),
      'rows', coalesce((select jsonb_agg((to_jsonb(top) - 'k' - 'd' - 'same_n' - 'first_d' - 'last_d') || jsonb_build_object(
                  'same_count', top.same_n, 'first_date', top.first_d::text, 'last_date', top.last_d::text)
                order by top.same_n desc, top.d desc nulls last, top.bl_no desc)
                from top), '[]'::jsonb)
    )
  $sql$, col) into res using '%' || q || '%', dfrom, lim;
  return res;
end $$;

-- p = freight_filter_types 와 같은 검색 조건 + bl (그 운임 종류의 대표 B/L 번호)
create or replace function public.freight_filter_type_bls(p jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  col   text := coalesce(nullif(p ->> 'col', ''), 'consignee');
  q     text := btrim(coalesce(p ->> 'q', ''));
  dfrom date := nullif(p ->> 'from', '')::date;
  bl    text := btrim(coalesce(p ->> 'bl', ''));
  key   text;
  res   jsonb;
begin
  if col not in ('consignee', 'bl_no', 'consignee_code', 'actual_shipper', 'a_shipper_code', 'io_date',
                 'voyage', 'notify', 'remark', 'item', 'description', 'shipper') then
    raise exception '검색할 수 없는 칸입니다: %', col;
  end if;
  select public.freight_type_key(f) into key from public.freight_records f where f.bl_no = bl limit 1;
  if key is null or q = '' then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0);
  end if;
  execute format($sql$
    with t as (
      select f.bl_no, f.io_date, f.voyage, f.description, f.pkg, f.weight, f.measure, f.collect_ttl,
             public.dash_date(f.io_date::text) as d
      from public.freight_records f
      where f.%1$I::text ilike $1
        and ($2::date is null or public.dash_date(f.io_date::text) >= $2)
        and public.freight_type_key(f) = $3
    )
    select jsonb_build_object(
      'total', (select count(*) from t),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'd' order by x.d desc nulls last, x.bl_no desc)
                        from (select * from t order by d desc nulls last, bl_no desc limit 1000) x), '[]'::jsonb)
    )
  $sql$, col) into res using '%' || q || '%', dfrom, key;
  return res;
end $$;

revoke execute on function public.freight_type_key(public.freight_records), public.freight_filter_types(jsonb),
  public.freight_filter_type_bls(jsonb) from public, anon;
grant execute on function public.freight_type_key(public.freight_records), public.freight_filter_types(jsonb),
  public.freight_filter_type_bls(jsonb) to authenticated;

-- PostgREST 가 새 함수를 바로 인식하도록
notify pgrst, 'reload schema';
