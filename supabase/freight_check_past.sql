-- =====================================================================
-- 운임 체크: 검증 대상 화주들의 과거 운임 기록 (기준일 이후 입항분만)
--   기존 get_past_freight_by_consignees 는 화주의 모든 기록을 보내고 화면에서 기준일 이전을 버렸습니다.
--   이 함수는 서버에서 먼저 거르므로 데이터가 몇 년 치로 늘어도 받는 양이 거의 같습니다.
--   기존 함수는 그대로 두며, 이 함수가 없거나 오류가 나면 화면이 기존 함수를 씁니다.
--
--   p_consignees : 화주명 목록 (화면에서 앞뒤 공백 제거)
--   p_from       : 기준일 (cargo-tool.html 의 FC_BASELINE_FROM)
--   반환 { rows: [기준일 이후 또는 입항일을 읽을 수 없는 기록],
--          oldOnly: [기준일 이전 기록만 있는 화주], oldCount: 제외한 기준일 이전 건수 }
--   입항일 해석은 대시보드와 같은 dash_date (supabase/dashboard.sql) 를 씁니다.
--
--   여러 번 실행해도 안전합니다. 되돌리기: drop function if exists public.get_past_freight_since(text[], date);
-- =====================================================================
create or replace function public.get_past_freight_since(p_consignees text[], p_from date)
returns jsonb
language sql stable set search_path = public as $$
  with t as (
    select f.*, public.dash_date(f.io_date::text) as d, btrim(f.consignee::text) as ckey
    from public.freight_records f
    where btrim(f.consignee::text) = any(p_consignees)
  ), cur as (
    select * from t where d is null or d >= p_from
  ), old as (
    select * from t where d < p_from
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
              'io_date', io_date, 'bl_no', bl_no, 'cargo', cargo, 'voyage', voyage, 'description', description,
              'bt', bt, 'consignee_code', consignee_code, 'consignee', consignee, 'notify', notify,
              'actual_shipper', actual_shipper, 'a_shipper_code', a_shipper_code, 'shipper', shipper,
              'twenty', twenty, 'forty', forty, 'forty_five', forty_five, 'ts', ts, 'item', item, 'remark', remark,
              'crs_c', crs_c, 'lss_c', lss_c, 'pss_c', pss_c, 'frt_c', frt_c, 'esc', esc, 'caf', caf, 'baf_c', baf_c,
              'thc', thc, 'ccf', ccf, 'doc', doc, 'wfg', wfg, 'tsf', tsf, 'psc', psc, 'ebs_c', ebs_c,
              'cfs', cfs, 'collect_ttl', collect_ttl)) from cur), '[]'::jsonb),
    'oldOnly', coalesce((select jsonb_agg(distinct ckey) from old
                         where ckey not in (select ckey from cur)), '[]'::jsonb),
    'oldCount', (select count(*) from old)
  )
$$;

revoke execute on function public.get_past_freight_since(text[], date) from public, anon;
grant execute on function public.get_past_freight_since(text[], date) to authenticated;

-- PostgREST 가 새 함수를 바로 인식하도록
notify pgrst, 'reload schema';
