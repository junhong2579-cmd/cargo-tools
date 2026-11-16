-- =====================================================================
--  [보관용 · 실행하지 마세요] RLS(행 보안) 켜짐 여부 · 정책 · 표 권한
--  Supabase 에서 2026-11-16 받아 둔 원문입니다. 실행용이 아닙니다(이미 Supabase 에 있음).
--  조회문: 시스템 표(pg_class · pg_constraint · pg_indexes · pg_policies · pg_trigger · pg_proc)에서 꺼낸 내용을
--  읽기 쉽게 create 문 모양으로 옮겼습니다. 새 프로젝트로 옮기거나 복구할 때 참고합니다.
--  정책 안에 관리자 이메일이 직접 적힌 곳: container_cache · freight_cache 의 "Allow write only for admin".
--  grant 는 Supabase 기본값(anon · authenticated 에 모든 권한)이며, 실제로 막는 것은 RLS 정책입니다.
-- =====================================================================
alter table public.container_cache enable row level security;
alter table public.dash_rows enable row level security;
alter table public.ex_act_bl enable row level security;
alter table public.export_records enable row level security;
alter table public.freight_cache enable row level security;
alter table public.freight_records enable row level security;
alter table public.profiles enable row level security;

create policy "Allow read for approved users" on public.container_cache
  as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_approved = true)))));

create policy "Allow write only for admin" on public.container_cache
  as permissive for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.is_admin = true) OR (profiles.email = 'junhong2579@gmail.com'::text))))))
  with check ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.is_admin = true) OR (profiles.email = 'junhong2579@gmail.com'::text))))));

create policy "dash_rows_read" on public.dash_rows
  as permissive for select to authenticated
  using (( SELECT dash_can_read() AS dash_can_read));

create policy "ex_act_bl_read" on public.ex_act_bl
  as permissive for select to authenticated
  using (( SELECT dash_can_read() AS dash_can_read));

create policy "export_records_delete" on public.export_records
  as permissive for delete to authenticated
  using (( SELECT dash_is_admin() AS dash_is_admin));

create policy "export_records_insert" on public.export_records
  as permissive for insert to authenticated
  with check (( SELECT dash_is_admin() AS dash_is_admin));

create policy "export_records_read" on public.export_records
  as permissive for select to authenticated
  using (( SELECT dash_can_read() AS dash_can_read));

create policy "export_records_update" on public.export_records
  as permissive for update to authenticated
  using (( SELECT dash_is_admin() AS dash_is_admin))
  with check (( SELECT dash_is_admin() AS dash_is_admin));

create policy "Allow read for approved users" on public.freight_cache
  as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_approved = true)))));

create policy "Allow write only for admin" on public.freight_cache
  as permissive for all to authenticated
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.is_admin = true) OR (profiles.email = 'junhong2579@gmail.com'::text))))))
  with check ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND ((profiles.is_admin = true) OR (profiles.email = 'junhong2579@gmail.com'::text))))));

create policy "Allow admin all" on public.freight_records
  as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Allow authenticated read" on public.freight_records
  as permissive for select to authenticated
  using (true);

create policy "Authenticated users can delete freight_records" on public.freight_records
  as permissive for delete to public
  using ((auth.role() = 'authenticated'::text));

create policy "Authenticated users can update freight_records" on public.freight_records
  as permissive for update to public
  using ((auth.role() = 'authenticated'::text));

create policy "Users can view own profile" on public.profiles
  as permissive for select to public
  using ((auth.uid() = id));

grant delete, insert, references, select, trigger, truncate, update on public.container_cache to anon;
grant delete, insert, references, select, trigger, truncate, update on public.container_cache to authenticated;
grant select on public.dash_rows to authenticated;
grant select on public.ex_act_bl to authenticated;
grant delete, insert, select, update on public.export_records to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.freight_cache to anon;
grant delete, insert, references, select, trigger, truncate, update on public.freight_cache to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.freight_records to anon;
grant delete, insert, references, select, trigger, truncate, update on public.freight_records to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.profiles to anon;
grant delete, insert, references, select, trigger, truncate, update on public.profiles to authenticated;
