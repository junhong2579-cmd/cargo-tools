-- =====================================================================
--  되돌리기: freight_records_rls.sql 을 실행하기 전 규칙 4개로 돌아갑니다.
--  (2026-11-16 Supabase 에서 받은 원문 그대로, supabase/existing/policies.sql 참고)
--  여러 번 실행해도 안전합니다. 데이터는 건드리지 않습니다.
-- =====================================================================

drop policy if exists freight_records_read on public.freight_records;
drop policy if exists freight_records_insert on public.freight_records;
drop policy if exists freight_records_update on public.freight_records;
drop policy if exists freight_records_delete on public.freight_records;

drop policy if exists "Allow admin all" on public.freight_records;
drop policy if exists "Allow authenticated read" on public.freight_records;
drop policy if exists "Authenticated users can delete freight_records" on public.freight_records;
drop policy if exists "Authenticated users can update freight_records" on public.freight_records;

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

select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'freight_records' order by policyname;
