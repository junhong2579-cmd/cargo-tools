-- =====================================================================
--  물류 대시보드 되돌리기 (dashboard.sql 로 만든 것을 Supabase 에서 제거)
--
--  언제: 대시보드를 통째로 빼고 대시보드 이전(GitHub 이름표 before-dashboard)으로 돌아갈 때.
--  실행: Supabase 대시보드 → SQL Editor → 이 파일 전체를 붙여 넣고 Run.
--
--  지워지는 것: 트리거, dash_* 함수, dash_rows 테이블(대시보드용 복사본이라 원본은 안전)
--  그대로 남는 것: freight_records 의 모든 데이터 (운임 필터 · 운임 체크는 영향 없음)
--  다시 대시보드를 쓰려면 dashboard.sql 을 다시 실행하면 됩니다.
-- =====================================================================
begin;

drop trigger if exists dash_rows_sync on public.freight_records;
drop trigger if exists dash_rows_truncate on public.freight_records;

-- 지우는 순서: 권한 정책 → 함수 → 테이블 (서로 의존하므로 이 순서를 지켜야 합니다)
drop policy if exists dash_rows_read on public.dash_rows;

drop function if exists
  public.dash_detail(jsonb, jsonb),
  public.dash_summary(jsonb),
  public.dash_totals(jsonb),
  public.dash_options(),
  public.dash_meta(),
  public.dash_qc(public.dash_rows, text),
  public.dash_filter(jsonb),
  public.dash_assert(),
  public.dash_can_read(),
  public.dash_rows_sync(),
  public.dash_transform(public.freight_records),
  public.dash_date(text),
  public.dash_num(text),
  public.dash_text(text);

drop table if exists public.dash_rows;

-- (선택) 엑셀 업로드에 추가했던 7개 컬럼까지 지우려면 아래 주석(--)을 지우고 실행하세요.
-- 지우면 그 컬럼에 저장된 값(중량 · CBM · 배정장소 등)은 사라집니다. 남겨 두어도 예전 화면은 문제없이 동작합니다.
-- alter table public.freight_records
--   drop column if exists vsl,
--   drop column if exists issue_date,
--   drop column if exists ft,
--   drop column if exists pkg,
--   drop column if exists weight,
--   drop column if exists measure,
--   drop column if exists place;

commit;

notify pgrst, 'reload schema';
