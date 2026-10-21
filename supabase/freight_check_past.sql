-- =====================================================================
-- 운임 체크: 검증 대상 화주들의 과거 운임 기록 (기준일 이후 입항분, 같은 운임은 한 건만)
--   예전 get_past_freight_by_consignees 와 같이 비교에 쓰는 24개 칸(업체 · 코드 · Notify · Cargo · B/T · T/S ·
--   컨테이너 수 · 운임 항목)이 모두 같은 건은 한 건만 보냅니다(사용량 최적화).
--   다른 점: ① 기준일 이전 입항분을 먼저 빼고 합칩니다(예전에는 합친 뒤 화면에서 빼서 4/1 이후 건이 같이 빠질 수 있었음)
--            ② 요율이 바뀐 날(p_breaks: 요율 변경일 · 45' 할인 종료일)을 경계로 나눠 합칩니다
--               → 운임 체크가 과거 건 입항일로 계산하는 요율 보정까지 모두 받았을 때와 같은 결과
--   기존 함수는 그대로 두며, 이 함수가 없거나 오류가 나면 화면이 기존 함수를 씁니다.
--
--   p_consignees : 화주명 목록 (화면에서 앞뒤 공백 제거). 띄어쓰기만 다른 이름도 찾습니다(예전 함수와 같음)
--   p_from       : 기준일 (cargo-tool.html 의 FC_BASELINE_FROM)
--   p_breaks     : 요율 구간 경계일 (cargo-tool.html 의 FREIGHT_RATE_CHANGES 날짜 + FREIGHT_THC45_DISCOUNT_END)
--   반환 { rows: [기준일 이후(또는 입항일을 읽을 수 없는) 기록, 같은 운임은 가장 최근 한 건],
--          oldOnly: [기준일 이전 기록만 있는 화주], oldCount: 제외한 기준일 이전 건수, total: 합치기 전 건수 }
--   입항일 해석은 대시보드와 같은 dash_date (supabase/dashboard.sql) 를 씁니다.
--
--   여러 번 실행해도 안전합니다. 되돌리기: drop function if exists public.get_past_freight_since(text[], date, date[]);
-- =====================================================================
drop function if exists public.get_past_freight_since(text[], date); -- 이전 버전(합치지 않음)

create or replace function public.get_past_freight_since(p_consignees text[], p_from date, p_breaks date[] default '{}')
returns jsonb
language sql stable set search_path = public as $$
  with t as (
    select f.*, public.dash_date(f.io_date::text) as d, btrim(f.consignee::text) as ckey
    from public.freight_records f
    where f.consignee = any(p_consignees)
       or regexp_replace(f.consignee, '\s+', '', 'g') = any(array(select regexp_replace(u, '\s+', '', 'g') from unnest(p_consignees) u))
  ), cur as (
    select t.*,
           -- 요율 구간: 입항일을 읽을 수 없으면 -1, 아니면 지난 경계일 수
           case when d is null then -1 else (select count(*) from unnest(p_breaks) b where t.d >= b) end as period
    from t where d is null or d >= p_from
  ), old as (
    select * from t where d < p_from
  ), u as (
    select distinct on (consignee, cargo, bt, ts, consignee_code, notify, actual_shipper, a_shipper_code,
                        twenty, forty, forty_five, crs_c, lss_c, pss_c, frt_c, esc, caf, baf_c, thc, ccf, doc, wfg, tsf, psc, period) *
    from cur
    order by consignee, cargo, bt, ts, consignee_code, notify, actual_shipper, a_shipper_code,
             twenty, forty, forty_five, crs_c, lss_c, pss_c, frt_c, esc, caf, baf_c, thc, ccf, doc, wfg, tsf, psc, period,
             d desc nulls last, updated_at desc nulls last
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
              'io_date', io_date, 'bl_no', bl_no, 'cargo', cargo, 'voyage', voyage, 'description', description,
              'bt', bt, 'consignee_code', consignee_code, 'consignee', consignee, 'notify', notify,
              'actual_shipper', actual_shipper, 'a_shipper_code', a_shipper_code, 'shipper', shipper,
              'twenty', twenty, 'forty', forty, 'forty_five', forty_five, 'ts', ts, 'item', item, 'remark', remark,
              'crs_c', crs_c, 'lss_c', lss_c, 'pss_c', pss_c, 'frt_c', frt_c, 'esc', esc, 'caf', caf, 'baf_c', baf_c,
              'thc', thc, 'ccf', ccf, 'doc', doc, 'wfg', wfg, 'tsf', tsf, 'psc', psc, 'ebs_c', ebs_c,
              'cfs', cfs, 'collect_ttl', collect_ttl)) from u), '[]'::jsonb),
    'oldOnly', coalesce((select jsonb_agg(distinct ckey) from old
                         where ckey not in (select ckey from cur)), '[]'::jsonb),
    'oldCount', (select count(*) from old),
    'total', (select count(*) from cur)
  )
$$;

revoke execute on function public.get_past_freight_since(text[], date, date[]) from public, anon;
grant execute on function public.get_past_freight_since(text[], date, date[]) to authenticated;

-- PostgREST 가 새 함수를 바로 인식하도록
notify pgrst, 'reload schema';
