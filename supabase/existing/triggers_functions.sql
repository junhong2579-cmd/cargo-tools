-- =====================================================================
--  [보관용 · 실행하지 마세요] 트리거 · 저장소에 없던 함수
--  Supabase 에서 2026-11-16 받아 둔 원문입니다. 실행용이 아닙니다(이미 Supabase 에 있음).
--  조회문: 시스템 표(pg_class · pg_constraint · pg_indexes · pg_policies · pg_trigger · pg_proc)에서 꺼낸 내용을
--  읽기 쉽게 create 문 모양으로 옮겼습니다. 새 프로젝트로 옮기거나 복구할 때 참고합니다.
--  auth.users 에 가입하면 handle_new_user() 가 profiles 에 (id, email, is_approved=false) 한 줄을 만듭니다. is_admin 은 기본값 false.
--  public 의 다른 함수(dash_* 제외)는 저장소 파일과 내용이 같아 여기에 다시 두지 않았습니다:
--    freight_filter_types · freight_filter_type_bls · freight_type_key → supabase/freight_filter_types.sql
--    get_past_freight_since → supabase/freight_check_past.sql, get_past_freight_by_consignees → supabase/legacy_get_past_freight_by_consignees.sql
--    dash_rows_sync · dash_export_sync → supabase/dashboard.sql
-- =====================================================================
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();
CREATE TRIGGER dash_export_sync AFTER INSERT OR DELETE OR UPDATE ON public.export_records FOR EACH ROW EXECUTE FUNCTION dash_export_sync();
CREATE TRIGGER dash_export_truncate AFTER TRUNCATE ON public.export_records FOR EACH STATEMENT EXECUTE FUNCTION dash_export_sync();
CREATE TRIGGER dash_rows_sync AFTER INSERT OR DELETE OR UPDATE ON public.freight_records FOR EACH ROW EXECUTE FUNCTION dash_rows_sync();
CREATE TRIGGER dash_rows_truncate AFTER TRUNCATE ON public.freight_records FOR EACH STATEMENT EXECUTE FUNCTION dash_rows_sync();

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$

begin

  insert into public.profiles (id, email, is_approved)

  values (new.id, new.email, false);

  return new;

end;

$function$;
