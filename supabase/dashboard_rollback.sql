-- =====================================================================
--  물류 대시보드 되돌리기 (dashboard.sql 로 만든 것을 Supabase 에서 제거)
--
--  언제: 대시보드를 통째로 빼고 대시보드 이전(GitHub 이름표 before-dashboard)으로 돌아갈 때.
--  실행: Supabase 대시보드 → SQL Editor → 이 파일 전체를 붙여 넣고 Run.
--
--  지워지는 것: 트리거, dash_* 함수, dash_rows 테이블(대시보드용 복사본이라 원본은 안전)
--  그대로 남는 것: freight_records 의 모든 데이터 (운임 필터 · 운임 체크는 영향 없음),
--                  export_records(수출 원본) 의 데이터 (아무 화면도 읽지 않음. 지우려면 맨 아래 주석 참고)
--  수출 대시보드만 빼고 수입 대시보드는 남기려면 이 파일 대신 export_rollback.sql 을 실행하세요.
--  다시 대시보드를 쓰려면 dashboard.sql 을 다시 실행하면 됩니다.
-- =====================================================================
begin;

drop trigger if exists dash_rows_sync on public.freight_records;
drop trigger if exists dash_rows_truncate on public.freight_records;

-- 수출: 트리거 · 권한 · 변환 함수 (수출 원본 export_records 의 데이터는 남김)
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
drop function if exists public.dash_export_sync(), public.dash_is_admin(), public.dash_meta_of(text), public.dash_options_of(text);
-- 특송 도착지 (ACT 자가 장치장 목록 ex_act_bl 의 데이터는 남김. 지우려면 맨 아래 주석 참고)
drop function if exists public.dash_ex_act_replace(jsonb), public.dash_ex_dest(text, text, text);
do $$
begin
  if to_regclass('public.ex_act_bl') is not null then
    drop policy if exists ex_act_bl_read on public.ex_act_bl;
    revoke all on public.ex_act_bl from anon, authenticated;
  end if;
end $$;

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

-- (선택) 수출 원본까지 지우려면: drop table if exists public.export_records;
-- (선택) ACT 자가 장치장 목록까지 지우려면: drop table if exists public.ex_act_bl;

commit;

notify pgrst, 'reload schema';
