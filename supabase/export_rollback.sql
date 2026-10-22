-- =====================================================================
--  수출 대시보드 되돌리기 → GitHub 이름표 before-export 시점의 Supabase 상태로
--
--  언제: 수출 대시보드 작업을 통째로 취소하고 수입 대시보드만 있던 때로 돌아갈 때.
--        (화면은 Vercel 에서 before-export 시점 배포로 되돌리거나, 코드를 before-export 로 되돌려 배포)
--  실행: Supabase → SQL Editor → 이 파일 전체를 붙여 넣고 Run. 한 번이면 됩니다.
--
--  하는 일
--    1) 수출 트리거 · 함수 · 권한을 지우고, 대시보드 집계표(dash_rows)에서 수출 행과 수출용 칸을 지웁니다.
--    2) before-export 시점의 dashboard.sql · stats_customers.sql · stats_shippers.sql 을 그대로 다시 실행합니다(아래에 포함).
--  그대로 남는 것
--    - freight_records(수입 원본) 의 모든 데이터 → 운임 필터 · 운임 체크 · 수입 대시보드 영향 없음
--    - export_records(수출 원본) 표와 데이터. 아무 화면도 읽지 않습니다. 완전히 지우려면 맨 아래 주석을 푸세요.
-- =====================================================================
begin;

do $$
begin
  if to_regclass('public.export_records') is not null then
    drop trigger if exists dash_export_sync on public.export_records;
    drop trigger if exists dash_export_truncate on public.export_records;
    drop policy if exists export_records_read on public.export_records;
    drop policy if exists export_records_insert on public.export_records;
    drop policy if exists export_records_update on public.export_records;
    drop policy if exists export_records_delete on public.export_records;
    revoke all on public.export_records from anon, authenticated;
    drop function if exists public.dash_transform_export(public.export_records);
  end if;
end $$;

drop function if exists public.dash_export_sync();
drop function if exists public.dash_is_admin();
drop function if exists public.dash_meta_of(text);
drop function if exists public.dash_options_of(text);

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'dash_rows' and column_name = 'dir') then
    delete from public.dash_rows where dir <> 'IN';
  end if;
end $$;

alter table if exists public.dash_rows
  drop column if exists dir,
  drop column if exists fwd,
  drop column if exists partner,
  drop column if exists rf20,
  drop column if exists rf40,
  drop column if exists cfs,
  drop column if exists pp,
  drop column if exists cc,
  drop column if exists mt_teu,
  drop column if exists part;  -- 파트 B/L 표시 (export-v1 뒤에 추가)

commit;

-- (선택) 수출 원본까지 지우려면 아래 줄의 주석(--)을 지우세요. 올린 수출 데이터가 사라집니다(엑셀로 다시 올릴 수 있음).
-- drop table if exists public.export_records;


-- =====================================================================
--  아래는 before-export 시점의 dashboard.sql · stats_customers.sql · stats_shippers.sql 원문입니다. 고치지 마세요.
-- =====================================================================

-- ---------- dashboard.sql (before-export) ----------
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
--  업무 규칙: TEU = 20'×1 + 40'×2 + 45'×2 (B/L Type E 는 0), 금액은 Collect 기준, 업체는 사업자번호(Consignee Code)로 구분.
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
  synced_at   timestamptz not null default now(),
  rf          text             -- 냉동 구분: R=냉동, S=선어, L=활어, null=냉동 아님 (dash_transform 참고)
);
-- 이전 버전에서 만든 테이블에는 rf 를 덧붙인다 (아래 3)의 '한 번에 채움'이 값을 다시 계산함)
alter table public.dash_rows add column if not exists rf text;
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
  -- 45' = 2 TEU. B/L Type E(여객 수화물 · 엠티 컨테이너 운송)는 실제 수입 물량이 아니므로 TEU 0
  o.teu        := case when o.bt = 'E' then 0 else o.c20 + 2 * o.c40 + 2 * o.c45 end;
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
  -- 냉동: B/L 번호에 'E12' 가 있으면 냉동 B/L. 그중 REMARK 에 '선어'가 있으면 선어, '활어'가 있으면 활어(둘 다면 선어 우선).
  -- (REMARK 의 '냉동 컨테이너'는 Bulk 로 컨테이너 자체를 들여오는 건이라 냉동이 아니며, E12 번호도 아니다.)
  o.rf         := case when o.bl like '%E12%' then
                    case when o.remark like '%선어%' then 'S' when o.remark like '%활어%' then 'L' else 'R' end
                  end;
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
--                          ft:'all'|'P'|'C', rf:'all'|'1'|'0' }
--    (ex = 특송: B/L Type 이 X 인 B/L, rf = 냉동: 선어 · 활어 포함)
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
           coalesce(f ->> 'ft', 'all') as ft,
           coalesce(f ->> 'rf', 'all') as rf
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
    and (p.rf = 'all' or (p.rf = '1') = (r.rf is not null))
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
    'tsTeu', coalesce(sum(teu) filter (where ts > 0), 0),
    'exTeu', coalesce(sum(teu) filter (where bt = 'X'), 0),
    'months',  count(distinct to_char(d, 'YYYY-MM')),   -- 월 평균 · 항차 평균 KPI 의 분모
    'voyages', count(distinct voyage),
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

-- 합계 + 월 · 항차 · Consignee · Notify · ITEM · Cargo · 배정장소 · 냉동 구분 · 냉동 Consignee 별 집계 (화면 갱신마다 1회)
-- groups.<축> = [[키, ...fields 순서의 값]] (키 ''=값 없음)
--   reefer = 냉동 구분(R/S/L, ''=냉동 아님), reeferConsignee = 냉동 B/L 만 모은 Consignee 별 집계
--   tsConsignee = 환적(T/S) B/L 만, exConsignee = 특송(B/L Type X) B/L 만 모은 Consignee 별 집계
--   tsTeu · exTeu = 묶음 안의 환적 · 특송 TEU (월 · 항차별 점유율 차트용)
--   rTeu · sTeu · lTeu = 묶음 안의 냉동 · 선어 · 활어 TEU (월 · 항차별 냉동 차트용)
create or replace function public.dash_summary(f jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  res jsonb;
begin
  perform public.dash_assert();
  with r as (
    select x.*, to_char(x.d, 'YYYY-MM') as m, (x.rf is not null) as rfc,
           (x.ts > 0) as tsc, (x.bt is not distinct from 'X') as exc
    from public.dash_filter(f) x
  ), g as (
    select
      case when grouping(m) = 0 then 'month'
           when grouping(voyage) = 0 then 'voyage'
           when grouping(rfc) = 0 then 'reeferConsignee'
           when grouping(tsc) = 0 then 'tsConsignee'
           when grouping(exc) = 0 then 'exConsignee'
           when grouping(ckey) = 0 then 'consignee'
           when grouping(notify) = 0 then 'notify'
           when grouping(item) = 0 then 'item'
           when grouping(cargo) = 0 then 'cargo'
           when grouping(rf) = 0 then 'reefer'
           else 'place' end as dim,
      jsonb_build_array(
        coalesce(case when grouping(m) = 0 then m
                      when grouping(voyage) = 0 then voyage
                      when grouping(ckey) = 0 then ckey
                      when grouping(notify) = 0 then notify
                      when grouping(item) = 0 then item
                      when grouping(cargo) = 0 then cargo
                      when grouping(rf) = 0 then rf
                      else place end, ''),
        count(*), sum(c20), sum(c40), sum(c45), sum(teu), sum(cntr),
        sum(pkg), sum(weight), sum(cbm), sum(krw), sum(usd), sum(total),
        sum(ts), count(*) filter (where bt = 'X'), count(*) filter (where ft = 'P'), count(notify), count(distinct ckey), min(d)::text,
        coalesce(sum(teu) filter (where tsc), 0), coalesce(sum(teu) filter (where exc), 0),
        coalesce(sum(teu) filter (where rf = 'R'), 0), coalesce(sum(teu) filter (where rf = 'S'), 0), coalesce(sum(teu) filter (where rf = 'L'), 0)
      ) as a
    from r
    group by grouping sets ((m), (voyage), (ckey), (notify), (item), (cargo), (place), (rf), (rfc, ckey), (tsc, ckey), (exc, ckey))
    -- 냉동 · 환적 · 특송 Consignee 집계는 해당 B/L 묶음(true)만 남긴다
    having (grouping(rfc) = 1 or rfc) and (grouping(tsc) = 1 or tsc) and (grouping(exc) = 1 or exc)
  )
  select jsonb_build_object(
    'fields', '["key","bl","c20","c40","c45","teu","cntr","pkg","weight","cbm","krw","usd","total","ts","ex","prepaid","withNotify","companies","date","tsTeu","exTeu","rTeu","sTeu","lTeu"]'::jsonb,
    'groups', coalesce((select jsonb_object_agg(dim, rows) from (select dim, jsonb_agg(a) as rows from g group by dim) x), '{}'::jsonb),
    -- Consignee 별 Notify 목록: { 키: [[Notify(''=없음), B/L 수], ...] } (B/L 수 많은 순)
    'notifyOf', coalesce((select jsonb_object_agg(ckey, ns) from (
                  select ckey, jsonb_agg(jsonb_build_array(k, n) order by n desc, k) as ns
                  from (select coalesce(ckey, '') as ckey, coalesce(notify, '') as k, count(*) as n from r group by 1, 2) a
                  group by ckey) b), '{}'::jsonb)
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

-- ---------- stats_customers.sql (before-export) ----------
-- =====================================================================
--  [실험] 대시보드 "고객 변화" 보기 — 새 함수 dash_customers 하나만 추가합니다.
--
--  - dashboard.sql 의 기존 함수 · 테이블은 바꾸지 않습니다. dashboard.sql 을 먼저 실행한 뒤 실행하세요.
--  - 여러 번 실행해도 안전합니다. 없애려면 stats_rollback.sql 을 실행합니다(기존 대시보드는 그대로).
--
--  정의 (기준일 = 조회 기간 끝과 데이터 마지막 입항일 중 이른 날)
--    고객 = Consignee(사업자번호) 또는 Notify(이름). 값이 없는 B/L 과 B/L Type E(엠티)는 제외.
--    상태: 마지막 실적이 기준일보다
--          6개월 넘게 전 → gone(장기 미거래), 3개월 넘게 전 → lost(이탈 의심), 1개월 넘게 전 → warn(주의)
--          그 밖(최근 1개월 안에 실적) → new(첫 실적이 조회 기간 안) · back(3개월 넘게 쉬다가 조회 기간에 다시 시작) · keep(유지)
--          데이터 첫 날 이전 기록은 알 수 없으므로 조회 기간이 데이터 첫 날부터면 new 를 판단하지 않습니다(newKnown=false).
--    등급: 조회 기간 TEU 많은 순으로 더해 앞쪽 80% = A, 다음 15% = B, 나머지 = C (TEU 0 이면 '')
-- =====================================================================

create or replace function public.dash_customers(f jsonb, opt jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  res   jsonb;
  gmin  date;
  gmax  date;
  pf    date;
  pt    date;
  asof  date;
  cf    date := nullif(opt ->> 'cmpFrom', '')::date;
  ct    date := nullif(opt ->> 'cmpTo', '')::date;
  basis text := coalesce(opt ->> 'basis', 'consignee');
begin
  perform public.dash_assert();
  select min(d), max(d) into gmin, gmax from public.dash_rows;
  pf   := coalesce(nullif(opt ->> 'from', '')::date, gmin);
  pt   := coalesce(nullif(opt ->> 'to', '')::date, gmax);
  asof := least(pt, gmax);

  with r as (
    -- 기간을 뺀 나머지 조회 조건(ITEM · 화물 종류 등)은 그대로 적용, 기준일 이후 실적은 보지 않음
    select case when basis = 'notify' then coalesce(x.notify, '') else x.ckey end as k, x.d, x.teu
    from public.dash_filter(f - 'from' - 'to') x
    where x.d is not null and x.d <= asof and x.bt is distinct from 'E'
  ),
  k as (
    select k,
           coalesce(sum(teu) filter (where d >= pf), 0)              as teu_p,
           count(*) filter (where d >= pf)                           as bl_p,
           coalesce(sum(teu) filter (where d between cf and ct), 0)  as teu_c,
           count(*) filter (where d between cf and ct)               as bl_c,
           coalesce(sum(teu), 0)                                     as teu_h,   -- 기준일까지 전체 TEU
           count(distinct date_trunc('month', d))                    as mon,     -- 실적 있는 개월 수
           min(d) as first_d, max(d) as last_d,
           max(d) filter (where d < pf)  as prev_d,
           min(d) filter (where d >= pf) as first_p
    from r where k <> '' group by k
  ),
  s as (
    select k.*,
           case
             when last_d < asof - interval '6 months' then 'gone'
             when last_d < asof - interval '3 months' then 'lost'
             when last_d < asof - interval '1 month'  then 'warn'
             when pf > gmin and first_d >= pf          then 'new'
             when bl_p > 0 and prev_d < first_p - interval '3 months' then 'back'
             else 'keep'
           end as st,
           sum(teu_p) over (order by teu_p desc, bl_p desc, k rows between unbounded preceding and current row) - teu_p as cum_before,
           sum(teu_p) over () as teu_all
    from k
  ),
  -- 월별 고객 흐름 (최근 12개월): 활동 · 신규(첫 실적 달) · 전월에 이어 · 다시 시작(전월 공백) · 전월 대비 빠짐
  am as (select distinct k, date_trunc('month', d)::date as m from r where k <> ''),
  fm as (select k, min(m) as m0 from am group by k),
  mm as (
    select g::date as m
    from generate_series(greatest(date_trunc('month', gmin), date_trunc('month', asof) - interval '11 months'),
                         date_trunc('month', asof), interval '1 month') g
  ),
  flow as (
    select mm.m,
           (select count(*) from am where am.m = mm.m) as active,
           (select count(*) from fm where fm.m0 = mm.m) as fresh,
           (select count(*) from am a where a.m = mm.m
              and exists (select 1 from am b where b.k = a.k and b.m = (mm.m - interval '1 month')::date)) as cont,
           (select count(*) from am b where b.m = (mm.m - interval '1 month')::date
              and not exists (select 1 from am a where a.k = b.k and a.m = mm.m)) as dropped,
           (select coalesce(sum(teu), 0) from r where date_trunc('month', r.d) = mm.m and r.k <> '') as teu
    from mm
  )
  select jsonb_build_object(
    'asOf', asof::text, 'from', pf::text, 'to', pt::text,
    'cmpFrom', cf::text, 'cmpTo', ct::text,
    'dataMin', gmin::text, 'newKnown', pf > gmin,
    'fields', '["key","st","grade","teu","bl","teuC","blC","first","last","prev","teuH","mon"]'::jsonb,
    'rows', (select coalesce(jsonb_agg(jsonb_build_array(
               k, st,
               case when teu_p <= 0 then ''
                    when cum_before < 0.80 * teu_all then 'A'
                    when cum_before < 0.95 * teu_all then 'B'
                    else 'C' end,
               teu_p, bl_p, teu_c, bl_c, first_d::text, last_d::text, prev_d::text, teu_h, mon)
             order by teu_p desc, bl_p desc, last_d desc), '[]'::jsonb) from s),
    -- 월 · 활동 · 신규 · 전월에 이어 · 다시 시작 · 전월 대비 빠짐 · TEU
    'months', (select coalesce(jsonb_agg(jsonb_build_array(to_char(m, 'YYYY-MM'), active, fresh, cont,
                 active - fresh - cont, dropped, teu) order by m), '[]'::jsonb) from flow),
    'firstMonth', to_char(date_trunc('month', gmin), 'YYYY-MM')
  ) into res;
  return res;
end $$;

revoke execute on function public.dash_customers(jsonb, jsonb) from public, anon;
grant execute on function public.dash_customers(jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ---------- stats_shippers.sql (before-export) ----------
-- =====================================================================
--  [실험] 대시보드 "Shipper 연결" 보기 — 새 함수 dash_shippers 하나만 추가합니다.
--
--  - dashboard.sql 의 기존 함수 · 테이블은 바꾸지 않습니다. dashboard.sql 을 먼저 실행한 뒤 실행하세요.
--  - 여러 번 실행해도 안전합니다. 없애려면 stats_rollback.sql 을 실행합니다(기존 대시보드는 그대로).
--
--  정의
--    Shipper 는 이름에서 영문 · 숫자만 남기고 대문자로 바꾼 값으로 묶습니다
--    ("SANG DO SHIPPING CO., LTD." = "SANGDO SHIPPING CO., LTD"). 표시 이름은 가장 많이 쓴 표기.
--    상대편 = Consignee(사업자번호) 또는 Notify(이름). 값이 없는 B/L 과 B/L Type E(엠티)는 제외.
--    조회 기간(P) 또는 비교 기간(C)에 실적이 있는 Shipper · 연결(Shipper × 상대편)만 돌려줍니다.
--    newKnown = 조회 기간이 데이터 첫 날 이후라서 "새 연결(첫 거래가 조회 기간 안)"을 판단할 수 있는지.
-- =====================================================================

create or replace function public.dash_shippers(f jsonb, opt jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  res   jsonb;
  gmin  date;
  gmax  date;
  pf    date;
  pt    date;
  asof  date;
  cf    date := nullif(opt ->> 'cmpFrom', '')::date;
  ct    date := nullif(opt ->> 'cmpTo', '')::date;
  basis text := coalesce(opt ->> 'basis', 'consignee');
begin
  perform public.dash_assert();
  select min(d), max(d) into gmin, gmax from public.dash_rows;
  pf   := coalesce(nullif(opt ->> 'from', '')::date, gmin);
  pt   := coalesce(nullif(opt ->> 'to', '')::date, gmax);
  asof := least(pt, gmax);

  with r as (
    select upper(regexp_replace(coalesce(x.shipper, ''), '[^A-Za-z0-9]', '', 'g')) as sk, x.shipper as sname,
           case when basis = 'notify' then coalesce(x.notify, '') else x.ckey end as k, x.d, x.teu
    from public.dash_filter(f - 'from' - 'to') x
    where x.d is not null and x.d <= asof and x.bt is distinct from 'E'
  ),
  r2 as (select * from r where sk <> '' and k <> ''),
  nm as (select sk, mode() within group (order by sname) as name, count(distinct sname) as variants from r2 group by sk),
  pr as (
    select sk, k,
           coalesce(sum(teu) filter (where d >= pf), 0)              as teu_p,
           count(*) filter (where d >= pf)                           as bl_p,
           coalesce(sum(teu) filter (where d between cf and ct), 0)  as teu_c,
           count(*) filter (where d between cf and ct)               as bl_c,
           min(d) as first_d, max(d) as last_d
    from r2 group by sk, k
  ),
  pa as (select * from pr where bl_p > 0 or bl_c > 0),
  sh as (
    select sk,
           sum(teu_p) as teu_p, sum(bl_p) as bl_p, sum(teu_c) as teu_c, sum(bl_c) as bl_c,
           count(*) filter (where bl_p > 0) as n_p,      -- 조회 기간에 거래한 상대편 수
           count(*) filter (where bl_c > 0) as n_c,
           min(first_d) as first_d, max(last_d) as last_d
    from pr group by sk
    having sum(bl_p) > 0 or sum(bl_c) > 0
  )
  select jsonb_build_object(
    'asOf', asof::text, 'from', pf::text, 'to', pt::text,
    'cmpFrom', cf::text, 'cmpTo', ct::text, 'newKnown', pf > gmin,
    'sFields', '["key","name","variants","teu","bl","teuC","blC","n","nC","first","last"]'::jsonb,
    'shippers', (select coalesce(jsonb_agg(jsonb_build_array(sh.sk, nm.name, nm.variants, teu_p, bl_p, teu_c, bl_c, n_p, n_c,
                   first_d::text, last_d::text) order by teu_p desc, bl_p desc), '[]'::jsonb)
                 from sh join nm using (sk)),
    'pFields', '["s","k","teu","bl","teuC","blC","first","last"]'::jsonb,
    'pairs', (select coalesce(jsonb_agg(jsonb_build_array(sk, k, teu_p, bl_p, teu_c, bl_c, first_d::text, last_d::text)
                order by teu_p desc, bl_p desc), '[]'::jsonb) from pa)
  ) into res;
  return res;
end $$;

revoke execute on function public.dash_shippers(jsonb, jsonb) from public, anon;
grant execute on function public.dash_shippers(jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
