-- =====================================================================
--  [보관용 · 실행하지 마세요] 예전 운임 체크 과거 기록 함수 원문
--  2026-10-21 Supabase 에서 pg_get_functiondef 로 꺼낸 그대로입니다. 저장소에 없던 함수라 기록으로 남깁니다.
--  지금 화면은 supabase/freight_check_past.sql 의 get_past_freight_since 를 쓰고,
--  그 함수가 없거나 오류일 때만 이 함수로 대신 받습니다(Supabase 에 그대로 남아 있음).
--
--  핵심: 비교에 쓰는 24개 칸이 모두 같은 과거 건은 DISTINCT ON 으로 한 건만 보낸다 (사용량 최적화).
--  약점: 입항일과 상관없이 먼저 합친 뒤 화면에서 4/1 이전을 버려, 대표 건이 4/1 이전이면 4/1 이후 같은 운임도 빠질 수 있었음.
--        io_date 가 문자열이라 "최근 건" 정렬이 날짜순이 아님.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_past_freight_by_consignees(p_consignees text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (
      consignee,
      cargo,
      bt,
      ts,
      consignee_code,
      notify,
      actual_shipper,
      a_shipper_code,
      twenty,
      forty,
      forty_five,
      crs_c,
      lss_c,
      pss_c,
      frt_c,
      esc,
      caf,
      baf_c,
      thc,
      ccf,
      doc,
      wfg,
      tsf,
      psc
    ) *
    FROM freight_records
    WHERE consignee = ANY(p_consignees)
       OR regexp_replace(consignee, '\s+', '', 'g') = ANY(
            ARRAY(SELECT regexp_replace(u, '\s+', '', 'g') FROM unnest(p_consignees) u)
          )
    ORDER BY
      consignee,
      cargo,
      bt,
      ts,
      consignee_code,
      notify,
      actual_shipper,
      a_shipper_code,
      twenty,
      forty,
      forty_five,
      crs_c,
      lss_c,
      pss_c,
      frt_c,
      esc,
      caf,
      baf_c,
      thc,
      ccf,
      doc,
      wfg,
      tsf,
      psc,
      io_date DESC NULLS LAST,
      created_at DESC NULLS LAST
  ) r;
$function$
