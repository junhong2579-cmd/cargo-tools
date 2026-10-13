-- =====================================================================
--  [실험] 통계 보기 되돌리기 — stats_*.sql 로 추가한 함수만 지웁니다.
--  기존 대시보드(dashboard.sql) · freight_records 데이터는 그대로입니다.
--  실행: Supabase → SQL Editor → 이 파일 전체를 붙여 넣고 Run.
-- =====================================================================
drop function if exists public.dash_customers(jsonb, jsonb);
drop function if exists public.dash_shippers(jsonb, jsonb);

notify pgrst, 'reload schema';
