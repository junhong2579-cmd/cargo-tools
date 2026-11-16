# supabase/existing — Supabase 에만 있던 설정 원문 (보관용, 실행하지 마세요)

2026-11-16 Supabase SQL Editor 에서 조회해 받아 둔 내용입니다. 이미 Supabase 에 있으므로 실행하지 않습니다. 새 프로젝트로 옮기거나 복구할 때 참고합니다.
조회문은 `평택데이터/supabase_원문_조회.sql`(저장소에 올리지 않는 폴더)에 있습니다. 다시 받을 때 같은 조회문을 실행해 CSV 로 내려받습니다.

- `tables.sql` — 표 7개(profiles · container_cache · freight_cache · freight_records + 대시보드 표 3개)의 칸 · 기본키 · 제약 · 인덱스
- `policies.sql` — RLS(행 보안) 켜짐 여부, 정책 15개, 표 권한(grant)
- `triggers_functions.sql` — 트리거 5개(가입 시 profiles 만드는 `on_auth_user_created` 포함)와 저장소에 없던 함수 `handle_new_user()`

다른 public 함수(dash_* 제외)는 저장소 파일과 내용이 같았습니다: `freight_filter_types.sql` · `freight_check_past.sql` · `legacy_get_past_freight_by_consignees.sql` · `dashboard.sql`.
