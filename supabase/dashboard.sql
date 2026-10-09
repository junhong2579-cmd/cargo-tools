-- =====================================================================
--  물류 대시보드 (기타 → 대시보드 탭) Supabase 설정
--
--  실행: Supabase 대시보드 → SQL Editor → 이 파일 전체를 붙여 넣고 Run.
--        여러 번 실행해도 안전합니다. 함수를 고친 뒤에도 전체를 다시 실행하면 됩니다.
--
--  구조
--    freight_records (엑셀 업로드 원본, 값이 모두 문자열)
--      └─ 트리거 ─▶ dash_rows (숫자·날짜로 정규화한 대시보드 전용 테이블)
--                      └─ RPC: dash_meta / dash_options / dash_summary / dash_totals / dash_detail
--    대시보드는 집계 결과만 받아 오므로 데이터가 몇 년 치로 늘어나도 브라우저 부담이 거의 같습니다.
--
--  업무 규칙: TEU = 20'×1 + 40'×2 + 45'×2, 금액은 Collect 기준, 업체는 사업자번호(Consignee Code)로 구분.
--            원화 = THC+DOC+WFG+CCF+TSF+PSC, USD = FRT+BAF+CAF+CRS+LSS+PSS+ESC (ESC 는 달러 항목).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) 엑셀 업로드에 대시보드용 컬럼 추가
--    (cargo-tool.html 의 운임 데이터 동기화가 이 컬럼들도 함께 저장합니다.
--     이 SQL 실행 이전에 올린 B/L 은 비어 있으므로, 해당 엑셀을 한 번 다시 동기화하세요.)
-- ---------------------------------------------------------------------
alter table public.freight_records
  add column if not exists vsl text,          -- VSL
  add column if not exists issue_date text,   -- Issue Date
  add column if not exists ft text,           -- F/T (Freight Type)
  add column if not exists pkg text,          -- PKG
  add column if not exists weight text,       -- Weight (kg)
  add column if not exists measure text,      -- Measure (CBM)
  add column if not exists place text;        -- 배정장소 명


-- ---------------------------------------------------------------------
-- 2) 문자열 → 값 변환 함수
--    SheetJS(raw:false)가 만든 화면 표시 문자열을 해석합니다. 날짜는 보통 '4/2/26'(M/D/YY) 형식입니다.
-- ---------------------------------------------------------------------
create or replace function public.dash_text(v text) returns text
language sql immutable as $$
  select nullif(btrim(regexp_replace(coalesce(v, ''), '\s+', ' ', 'g')), '')
$$;

create or replace function public.dash_num(v text) returns numeric
language plpgsql immutable as $$
declare
  s text := replace(replace(btrim(coalesce(v, '')), ',', ''), ' ', '');
begin
  if s ~ '^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$' then
    return s::numeric;
  end if;
  return 0;
end $$;

create or replace function public.dash_date(v text) returns date
language plpgsql immutable as $$
declare
  s text := btrim(coalesce(v, ''));
  p text[];
  a int; b int; c int; y int; m int; d int;
begin
  if s = '' then return null; end if;
  if s ~ '^\d{8}$' then                                  -- 20260402
    return make_date(left(s, 4)::int, substr(s, 5, 2)::int, right(s, 2)::int);
  end if;
  if s ~ '^\d{5}(\.\d+)?$' then                          -- 엑셀 날짜 일련번호 46114
    return date '1899-12-30' + floor(s::numeric)::int;
  end if;
  p := regexp_split_to_array(s, '[/.\-\s]+');
  if array_length(p, 1) < 3 or p[1] !~ '^\d+$' or p[2] !~ '^\d+$' or p[3] !~ '^\d+$' then
    return null;
  end if;
  a := p[1]::int; b := p[2]::int; c := p[3]::int;
  if a >= 1900 then                                      -- 2026-04-02, 2026/4/2
    y := a; m := b; d := c;
  else                                                   -- 4/2/26, 04-02-2026 (M/D/Y), 13/4/26 (D/M/Y)
    y := case when c >= 100 then c when c >= 70 then 1900 + c else 2000 + c end;
    if a > 12 and b <= 12 then d := a; m := b; else m := a; d := b; end if;
  end if;
  return make_date(y, m, d);
exception when others then
  return null;
end $$;


-- ---------------------------------------------------------------------
-- 3) 대시보드 전용 정규화 테이블
-- ---------------------------------------------------------------------
create table if not exists public.dash_rows (
  bl          text primary key,
  vsl         text,
  voyage      text,
  d           date,            -- I/O Date (입항일)
  issue_date  date,
  ckey        text not null,   -- 업체 구분 키 = 사업자번호(없으면 업체명)
  c_code      text,
  c_name      text,
  notify      text,            -- null = (Notify 없음)
  shipper     text,
  a_shipper   text,
  item        text,
  cargo       text,            -- F=FCL, L=LCL, E=Empty, B=Bulk
  bt          text,            -- B/L Type (X = 특송)
  ts          numeric,
  ft          text,            -- P / C
  c20 numeric, c40 numeric, c45 numeric, teu numeric, cntr numeric,
  pkg numeric, weight numeric, cbm numeric,
  thc numeric, doc numeric, wfg numeric, ccf numeric, tsf numeric, psc numeric, esc numeric,
  frt numeric, baf numeric, caf numeric, crs numeric, lss numeric, pss numeric,
  krw numeric,                 -- 원화 청구 = THC+DOC+WFG+CCF+TSF+PSC
  usd numeric,                 -- 외화 청구(USD) = FRT+BAF+CAF+CRS+LSS+PSS+ESC
  total numeric,               -- Collect TTL (총 청구액, 원)
  place       text,
  remark      text,
  descr       text,
  ext         boolean not null default false,  -- 1)의 추가 컬럼까지 업로드된 행인지
  synced_at   timestamptz not null default now()
);
create index if not exists dash_rows_d_idx on public.dash_rows (d);
create index if not exists dash_rows_ckey_idx on public.dash_rows (ckey);
create index if not exists dash_rows_notify_idx on public.dash_rows (notify);

create or replace function public.dash_transform(r public.freight_records) returns public.dash_rows
language plpgsql stable as $$
declare
  o public.dash_rows;
begin
  o.bl         := public.dash_text(r.bl_no::text);
  o.vsl        := public.dash_text(r.vsl::text);
  o.voyage     := public.dash_text(r.voyage::text);
  o.d          := public.dash_date(r.io_date::text);
  o.issue_date := public.dash_date(r.issue_date::text);
  o.c_code     := public.dash_text(r.consignee_code::text);
  o.c_name     := public.dash_text(r.consignee::text);
  o.ckey       := coalesce(o.c_code, o.c_name, '');
  o.notify     := public.dash_text(r.notify::text);
  o.shipper    := public.dash_text(r.shipper::text);
  o.a_shipper  := public.dash_text(r.actual_shipper::text);
  o.item       := upper(public.dash_text(r.item::text));
  o.cargo      := upper(public.dash_text(r.cargo::text));
  o.bt         := upper(public.dash_text(r.bt::text));
  o.ts         := public.dash_num(r.ts::text);
  o.ft         := upper(public.dash_text(r.ft::text));
  o.c20        := public.dash_num(r.twenty::text);
  o.c40        := public.dash_num(r.forty::text);
  o.c45        := public.dash_num(r.forty_five::text);
  o.teu        := o.c20 + 2 * o.c40 + 2 * o.c45;   -- 45' = 2 TEU
  o.cntr       := o.c20 + o.c40 + o.c45;
  o.pkg        := public.dash_num(r.pkg::text);
  o.weight     := public.dash_num(r.weight::text);
  o.cbm        := public.dash_num(r.measure::text);
  o.thc        := public.dash_num(r.thc::text);
  o.doc        := public.dash_num(r.doc::text);
  o.wfg        := public.dash_num(r.wfg::text);
  o.ccf        := public.dash_num(r.ccf::text);
  o.tsf        := public.dash_num(r.tsf::text);
  o.psc        := public.dash_num(r.psc::text);
  o.esc        := public.dash_num(r.esc::text);
  o.frt        := public.dash_num(r.frt_c::text);
  o.baf        := public.dash_num(r.baf_c::text);
  o.caf        := public.dash_num(r.caf::text);
  o.crs        := public.dash_num(r.crs_c::text);
  o.lss        := public.dash_num(r.lss_c::text);
  o.pss        := public.dash_num(r.pss_c::text);
  -- Collect TTL = 원화 항목 + USD 항목 × 적용환율 (엑셀의 원화발생금액(C) 컬럼은 일부 행에서 0이라 쓰지 않음)
  o.krw        := o.thc + o.doc + o.wfg + o.ccf + o.tsf + o.psc;
  o.usd        := o.frt + o.baf + o.caf + o.crs + o.lss + o.pss + o.esc;
  o.total      := public.dash_num(r.collect_ttl::text);
  o.place      := replace(public.dash_text(r.place::text), 'cfs', 'CFS');  -- '동방 cfs' → '동방 CFS'
  o.remark     := public.dash_text(r.remark::text);
  o.descr      := public.dash_text(r.description::text);
  o.ext        := r.ft is not null;
  o.synced_at  := now();
  return o;
end $$;

-- freight_records 가 바뀔 때마다 dash_rows 를 맞춰 줍니다 (업로드 · 정정 · 삭제 모두).
create or replace function public.dash_rows_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'TRUNCATE' then
    delete from public.dash_rows;
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.dash_rows where bl = public.dash_text(old.bl_no::text);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and public.dash_text(new.bl_no::text) is not null then
    delete from public.dash_rows where bl = public.dash_text(new.bl_no::text);
    insert into public.dash_rows select * from public.dash_transform(new);
  end if;
  return null;
end $$;

drop trigger if exists dash_rows_sync on public.freight_records;
create trigger dash_rows_sync
  after insert or update or delete on public.freight_records
  for each row execute function public.dash_rows_sync();

drop trigger if exists dash_rows_truncate on public.freight_records;
create trigger dash_rows_truncate
  after truncate on public.freight_records
  for each statement execute function public.dash_rows_sync();

-- 이미 올라가 있는 데이터를 한 번에 채웁니다.
delete from public.dash_rows;
insert into public.dash_rows
select t.*
from public.freight_records f
cross join lateral public.dash_transform(f) t
where t.bl is not null
on conflict (bl) do nothing;


-- ---------------------------------------------------------------------
-- 4) 권한: 로그인 + 승인된 사용자만 조회 (도구의 승인 규칙과 같음)
-- ---------------------------------------------------------------------
create or replace function public.dash_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false)
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and (p.is_approved is true or p.is_admin is true)
      )
$$;

create or replace function public.dash_assert() returns void
language plpgsql stable as $$
begin
  if not public.dash_can_read() then
    raise exception '대시보드 조회 권한이 없습니다. (로그인 · 관리자 승인 필요)' using errcode = '42501';
  end if;
end $$;

alter table public.dash_rows enable row level security;
revoke all on public.dash_rows from anon, authenticated;
grant select on public.dash_rows to authenticated;
drop policy if exists dash_rows_read on public.dash_rows;
create policy dash_rows_read on public.dash_rows
  for select to authenticated using ((select public.dash_can_read()));


-- ---------------------------------------------------------------------
-- 5) 조회 조건 · 점검 항목
--    f (조회 조건 JSON) = { from, to, consignee:[사업자번호], notify:[이름, ''=(Notify 없음)],
--                          companyMode:'and'|'or', items:[], cargo:[], bt:[], ts:'all'|'1'|'0', ex:'all'|'1'|'0',
--                          ft:'all'|'P'|'C' }   (ex = 특송: B/L Type 이 X 인 B/L)
-- ---------------------------------------------------------------------
create or replace function public.dash_filter(f jsonb) returns setof public.dash_rows
language sql stable set search_path = public as $$
  with p as (
    select nullif(f ->> 'from', '')::date as dfrom,
           nullif(f ->> 'to', '')::date   as dto,
           array(select jsonb_array_elements_text(coalesce(f -> 'consignee', '[]'))) as cs,
           array(select jsonb_array_elements_text(coalesce(f -> 'notify', '[]')))    as ns,
           coalesce(f ->> 'companyMode', 'and') = 'or' as any_company,
           array(select jsonb_array_elements_text(coalesce(f -> 'items', '[]')))     as its,
           array(select jsonb_array_elements_text(coalesce(f -> 'cargo', '[]')))     as cg,
           array(select jsonb_array_elements_text(coalesce(f -> 'bt', '[]')))        as bts,
           coalesce(f ->> 'ts', 'all') as ts,
           coalesce(f ->> 'ex', 'all') as ex,
           coalesce(f ->> 'ft', 'all') as ft
  )
  select r.*
  from public.dash_rows r, p
  where (p.dfrom is null or r.d >= p.dfrom)
    and (p.dto is null or r.d <= p.dto)
    and case
          when cardinality(p.cs) > 0 and cardinality(p.ns) > 0 then
            case when p.any_company
                 then r.ckey = any(p.cs) or coalesce(r.notify, '') = any(p.ns)
                 else r.ckey = any(p.cs) and coalesce(r.notify, '') = any(p.ns) end
          when cardinality(p.cs) > 0 then r.ckey = any(p.cs)
          when cardinality(p.ns) > 0 then coalesce(r.notify, '') = any(p.ns)
          else true
        end
    and (cardinality(p.its) = 0 or coalesce(r.item, '') = any(p.its))
    and (cardinality(p.cg) = 0 or coalesce(r.cargo, '') = any(p.cg))
    and (cardinality(p.bts) = 0 or coalesce(r.bt, '') = any(p.bts))
    and (p.ts = 'all' or (p.ts = '1' and r.ts > 0) or (p.ts = '0' and r.ts = 0))
    and (p.ex = 'all' or (p.ex = '1') = (r.bt is not distinct from 'X'))
    and (p.ft = 'all' or r.ft = p.ft)
$$;

-- 데이터 점검 항목. 화면(app.js 의 QC)과 같은 키를 씁니다.
-- 발행일·배정장소·중량은 추가 컬럼이 있는 행(ext)만 점검합니다.
create or replace function public.dash_qc(r public.dash_rows, k text) returns boolean
language sql immutable as $$
  select case k
    when 'issue'  then r.ext and r.issue_date is null
    when 'place'  then r.ext and r.place is null
    when 'weight' then r.ext and r.weight = 0 and r.cargo is distinct from 'E'
    when 'cntr'   then r.cntr = 0 and r.cargo in ('F', 'L')
    when 'charge' then r.total = 0
    when 'notify' then r.notify is null
    else false
  end
$$;


-- ---------------------------------------------------------------------
-- 6) 대시보드 RPC
-- ---------------------------------------------------------------------

-- 데이터 범위 · 기간 · ITEM/Cargo/B/L Type 목록 (화면을 처음 열 때 1회)
create or replace function public.dash_meta() returns jsonb
language plpgsql stable set search_path = public as $$
declare
  res jsonb;
begin
  perform public.dash_assert();
  select jsonb_build_object(
    'rows',     count(*),
    'dateMin',  min(d)::text,
    'dateMax',  max(d)::text,
    'vessels',  coalesce(jsonb_agg(distinct vsl) filter (where vsl is not null), '[]'::jsonb),
    'noExt',    count(*) filter (where not ext),
    'noDate',   count(*) filter (where d is null),
    'syncedAt', to_char(max(synced_at) at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'),
    'months',   (select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
                 from (select distinct to_char(d, 'YYYY-MM') as m from public.dash_rows where d is not null) t),
    'items',    (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc), '[]'::jsonb)
                 from (select coalesce(item, '') as k, count(*) as n from public.dash_rows group by 1) t),
    'cargos',   (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc), '[]'::jsonb)
                 from (select coalesce(cargo, '') as k, count(*) as n from public.dash_rows group by 1) t),
    'bts',      (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc), '[]'::jsonb)
                 from (select coalesce(bt, '') as k, count(*) as n from public.dash_rows group by 1) t)
  ) into res
  from public.dash_rows;
  return res;
end $$;

-- 업체 선택 목록: consignee [키, 사업자번호, 최근 업체명, B/L 수], notify [이름(''=없음), B/L 수]
create or replace function public.dash_options() returns jsonb
language plpgsql stable set search_path = public as $$
declare
  res jsonb;
begin
  perform public.dash_assert();
  select jsonb_build_object(
    'consignee', (select coalesce(jsonb_agg(jsonb_build_array(ckey, code, name, n) order by n desc), '[]'::jsonb)
                  from (select ckey, max(c_code) as code,
                               (array_agg(c_name order by d desc nulls last))[1] as name, count(*) as n
                        from public.dash_rows group by ckey) t),
    'notify',    (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc), '[]'::jsonb)
                  from (select coalesce(notify, '') as k, count(*) as n from public.dash_rows group by 1) t)
  ) into res;
  return res;
end $$;

-- 조건에 맞는 B/L 전체 합계 (KPI · 청구 항목 · 비율 · 점검 건수)
create or replace function public.dash_totals(f jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  res jsonb;
begin
  perform public.dash_assert();
  select jsonb_build_object(
    'bl', count(*),
    'c20', coalesce(sum(c20), 0), 'c40', coalesce(sum(c40), 0), 'c45', coalesce(sum(c45), 0),
    'teu', coalesce(sum(teu), 0), 'cntr', coalesce(sum(cntr), 0),
    'pkg', coalesce(sum(pkg), 0), 'weight', coalesce(sum(weight), 0), 'cbm', coalesce(sum(cbm), 0),
    'krw', coalesce(sum(krw), 0), 'usd', coalesce(sum(usd), 0), 'total', coalesce(sum(total), 0),
    'ts', coalesce(sum(ts), 0),
    'ex', count(*) filter (where bt = 'X'),
    'THC', coalesce(sum(thc), 0), 'DOC', coalesce(sum(doc), 0), 'WFG', coalesce(sum(wfg), 0),
    'CCF', coalesce(sum(ccf), 0), 'TSF', coalesce(sum(tsf), 0), 'PSC', coalesce(sum(psc), 0),
    'ESC', coalesce(sum(esc), 0),
    'FRT', coalesce(sum(frt), 0), 'BAF', coalesce(sum(baf), 0), 'CAF', coalesce(sum(caf), 0),
    'CRS', coalesce(sum(crs), 0), 'LSS', coalesce(sum(lss), 0), 'PSS', coalesce(sum(pss), 0),
    'companies',  count(distinct ckey),
    'prepaid',    count(*) filter (where ft = 'P'),
    'withNotify', count(notify),
    'noExt',      count(*) filter (where not ext),
    'qc', jsonb_build_object(
      'issue',  count(*) filter (where public.dash_qc(r, 'issue')),
      'place',  count(*) filter (where public.dash_qc(r, 'place')),
      'weight', count(*) filter (where public.dash_qc(r, 'weight')),
      'cntr',   count(*) filter (where public.dash_qc(r, 'cntr')),
      'charge', count(*) filter (where public.dash_qc(r, 'charge')),
      'notify', count(*) filter (where public.dash_qc(r, 'notify'))
    )
  ) into res
  from public.dash_filter(f) r;
  return res;
end $$;

-- 합계 + 월 · 항차 · Consignee · Notify · ITEM · Cargo · 배정장소별 집계 (화면 갱신마다 1회)
-- groups.<축> = [[키, ...fields 순서의 값]] (키 ''=값 없음)
create or replace function public.dash_summary(f jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  res jsonb;
begin
  perform public.dash_assert();
  with r as (
    select x.*, to_char(x.d, 'YYYY-MM') as m from public.dash_filter(f) x
  ), g as (
    select
      case when grouping(m) = 0 then 'month'
           when grouping(voyage) = 0 then 'voyage'
           when grouping(ckey) = 0 then 'consignee'
           when grouping(notify) = 0 then 'notify'
           when grouping(item) = 0 then 'item'
           when grouping(cargo) = 0 then 'cargo'
           else 'place' end as dim,
      jsonb_build_array(
        coalesce(case when grouping(m) = 0 then m
                      when grouping(voyage) = 0 then voyage
                      when grouping(ckey) = 0 then ckey
                      when grouping(notify) = 0 then notify
                      when grouping(item) = 0 then item
                      when grouping(cargo) = 0 then cargo
                      else place end, ''),
        count(*), sum(c20), sum(c40), sum(c45), sum(teu), sum(cntr),
        sum(pkg), sum(weight), sum(cbm), sum(krw), sum(usd), sum(total),
        sum(ts), count(*) filter (where bt = 'X'), count(*) filter (where ft = 'P'), count(notify), count(distinct ckey), min(d)::text
      ) as a
    from r
    group by grouping sets ((m), (voyage), (ckey), (notify), (item), (cargo), (place))
  )
  select jsonb_build_object(
    'fields', '["key","bl","c20","c40","c45","teu","cntr","pkg","weight","cbm","krw","usd","total","ts","ex","prepaid","withNotify","companies","date"]'::jsonb,
    'groups', coalesce((select jsonb_object_agg(dim, rows) from (select dim, jsonb_agg(a) as rows from g group by dim) x), '{}'::jsonb)
  ) into res;
  return res || jsonb_build_object('totals', public.dash_totals(f));
end $$;

-- B/L 상세 목록 (페이지 · 검색 · 정렬 · 점검 항목). CSV · 보고서는 limit 을 크게 줘서 전체를 받습니다.
-- opt = { qc, q, sort, dir:'asc'|'desc', limit, offset }
create or replace function public.dash_detail(f jsonb, opt jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  qc   text := nullif(opt ->> 'qc', '');
  q    text := nullif(btrim(coalesce(opt ->> 'q', '')), '');
  col  text := case coalesce(opt ->> 'sort', 'date')
                 when 'bl' then 'bl' when 'voy' then 'voyage' when 'date' then 'd'
                 when 'consignee' then 'c_name' when 'notify' then 'notify'
                 when 'item' then 'item' when 'cargo' then 'cargo'
                 when 'c20' then 'c20' when 'c40' then 'c40' when 'c45' then 'c45' when 'teu' then 'teu'
                 when 'weight' then 'weight' when 'cbm' then 'cbm' when 'total' then 'total'
                 when 'desc' then 'descr'
                 else 'd' end;
  dir  text := case when opt ->> 'dir' = 'asc' then 'asc' else 'desc' end;
  lim  int  := least(greatest(coalesce((opt ->> 'limit')::int, 50), 1), 100000);
  off  int  := greatest(coalesce((opt ->> 'offset')::int, 0), 0);
  res  jsonb;
begin
  perform public.dash_assert();
  if q is not null then
    q := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  execute format($sql$
    with r as (
      select x.* from public.dash_filter($1) x
      where ($2::text is null or public.dash_qc(x, $2))
        and ($3::text is null or concat_ws(' ', x.bl, x.voyage, x.c_name, x.c_code, x.notify, x.item, x.descr, x.shipper) ilike $3)
    ), page as (
      select r.*, row_number() over (order by %1$I %2$s nulls last, bl) as rn from r
      order by rn limit $4 offset $5
    )
    select jsonb_build_object(
      'total',  (select count(*) from r),
      'fields', '["bl","voy","date","consignee","notify","item","cargo","c20","c40","c45","teu","weight","cbm","total","desc","bt","ts","ft","pkg","krw","usd","THC","DOC","WFG","CCF","TSF","PSC","ESC","FRT","BAF","CAF","CRS","LSS","PSS","place","issueDate","remark","shipper","actualShipper"]'::jsonb,
      'rows', coalesce((select jsonb_agg(jsonb_build_array(
                  bl, voyage, d::text, ckey, coalesce(notify, ''), item, cargo, c20, c40, c45, teu, weight, cbm, total, descr,
                  bt, ts, ft, pkg, krw, usd, thc, doc, wfg, ccf, tsf, psc, esc, frt, baf, caf, crs, lss, pss,
                  place, issue_date::text, remark, shipper, a_shipper) order by rn)
                from page), '[]'::jsonb)
    )
  $sql$, col, dir) into res using f, qc, q, lim, off;
  return res;
end $$;


-- ---------------------------------------------------------------------
-- 7) 함수 실행 권한: 로그인 사용자만 (anon 차단)
-- ---------------------------------------------------------------------
revoke execute on function
  public.dash_meta(), public.dash_options(), public.dash_totals(jsonb), public.dash_summary(jsonb),
  public.dash_detail(jsonb, jsonb), public.dash_filter(jsonb), public.dash_can_read(), public.dash_assert()
  from public, anon;
grant execute on function
  public.dash_meta(), public.dash_options(), public.dash_totals(jsonb), public.dash_summary(jsonb),
  public.dash_detail(jsonb, jsonb), public.dash_filter(jsonb), public.dash_can_read(), public.dash_assert()
  to authenticated;

-- PostgREST 가 새 함수를 바로 인식하도록
notify pgrst, 'reload schema';
