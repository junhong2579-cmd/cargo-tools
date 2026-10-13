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
