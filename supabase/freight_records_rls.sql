-- =====================================================================
--  운임 기록 표(freight_records) 보안 규칙 정리 (2026-11-16)
--  Supabase SQL Editor 에서 이 파일 전체를 실행합니다. 여러 번 실행해도 안전합니다.
--
--  바꾸기 전 (supabase/existing/policies.sql 에 원문 보관):
--    "Allow admin all"(조건 없음) · "Allow authenticated read"(조건 없음) 등 4개 →
--    로그인만 하면 승인 전인 사람도 운임 기록을 모두 읽고 · 고치고 · 지울 수 있었음
--  바꾼 뒤: 다른 표(container_cache · freight_cache · 대시보드)와 같은 기준
--    읽기 = 승인된 사람(profiles.is_approved) 또는 관리자
--    저장 · 고치기 · 지우기 = 관리자(profiles.is_admin)
--    관리자 이메일 조건은 지금 화면 · 대시보드(dash_can_read · dash_is_admin)와 똑같이 남겨 둡니다(잠김 방지).
--  화면 동작은 그대로입니다: [클라우드 동기화] · B/L 삭제 · 대시보드 [데이터 올리기]는 원래 관리자만 쓰고,
--  운임 필터 · 운임 체크 · 프리타임 검색은 승인된 사람이 읽기만 합니다.
--  다른 함수에 기대지 않아 supabase/dashboard_rollback.sql 을 실행해도 이 규칙은 그대로 남습니다.
--
--  되돌리기: supabase/freight_records_rls_rollback.sql (바꾸기 전 4개 규칙으로)
-- =====================================================================

alter table public.freight_records enable row level security;

-- 예전 규칙 4개 제거
drop policy if exists "Allow admin all" on public.freight_records;
drop policy if exists "Allow authenticated read" on public.freight_records;
drop policy if exists "Authenticated users can delete freight_records" on public.freight_records;
drop policy if exists "Authenticated users can update freight_records" on public.freight_records;

-- 새 규칙 (다시 실행할 때를 위해 먼저 지움)
drop policy if exists freight_records_read on public.freight_records;
drop policy if exists freight_records_insert on public.freight_records;
drop policy if exists freight_records_update on public.freight_records;
drop policy if exists freight_records_delete on public.freight_records;

-- 읽기: 승인된 사람 또는 관리자 ( (select ...) 로 감싸 한 번만 계산 → 조회 속도 그대로 )
create policy freight_records_read on public.freight_records
  for select to authenticated
  using ((select
    coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false)
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and (p.is_approved is true or p.is_admin is true))));

-- 저장 · 고치기 · 지우기: 관리자만
create policy freight_records_insert on public.freight_records
  for insert to authenticated
  with check ((select
    coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin is true)));

create policy freight_records_update on public.freight_records
  for update to authenticated
  using ((select
    coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin is true)))
  with check ((select
    coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin is true)));

create policy freight_records_delete on public.freight_records
  for delete to authenticated
  using ((select
    coalesce(lower(auth.jwt() ->> 'email') = 'junhong2579@gmail.com', false)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin is true)));

-- 확인용: 실행 뒤 아래 결과에 freight_records_read · insert · update · delete 4줄만 나오면 정상
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'freight_records' order by policyname;
