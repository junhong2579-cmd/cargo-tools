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
