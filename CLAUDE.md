# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

평택항 카페리 선사의 **화물 업무 도구**. GitHub `junhong2579-cmd/cargo-tools` → Vercel 자동 배포, 데이터·로그인은 Supabase.
사용자는 비개발자이며 바이브 코딩으로 기능 추가·디자인 수정을 이어 갑니다. 설명은 한국어로, 쉬운 말로 합니다.

## 구조

- **Next.js 는 로그인 관문 역할만 합니다.** 화면 본체는 거대한 단일 HTML 입니다.
  - `middleware.js`: 모든 페이지 요청에서 로그인 · 승인(`profiles.is_approved`, 관리자 이메일) · 3시간 비활동을 검사합니다. `/api/*`는 검사하지 않습니다.
  - `pages/index.js`: 승인된 사용자에게 `private/cargo-tool.html`을 읽어 응답합니다. `__USER_EMAIL__`·`__SERVER_SESSION_TOKENS__` 자리에 값을 넣어 줍니다.
  - `pages/api/auth/refresh.js`: 세션 연장. `pages/api/auth/token.js`: 대시보드용 접근 토큰.
- **`private/cargo-tool.html`** (약 1만 2천 줄, CRLF 줄바꿈 유지): 탭(메인 · 체크리스트 · To Do · 기타 드롭다운)과 모든 기능이 들어 있습니다.
  - 기타 그룹 탭 목록 배열이 3곳에 있습니다(`setupDropdownTabs`, `switchTab` 2곳). 탭을 추가할 때는 세 곳 모두 고쳐야 합니다.
  - 운임 엑셀 업로드: `freightFileInput` → `freightDataList`(getVal 로 헤더 매핑) → `syncFreightDataToSupabase()` → `freight_records` 에 500건씩 upsert(`bl_no` 기준)합니다. 엑셀 80개 컬럼 중 41개만 저장하며, **값은 모두 SheetJS `raw:false` 문자열**입니다(날짜 `4/2/26`, 숫자 `3614.25`).
- **대시보드** (기타 → 대시보드 탭, iframe으로 `/dash/index.html`을 엽니다)
  - `public/dash/api.js`: `/api/auth/token`에서 토큰을 받아 Supabase RPC 를 fetch 로 호출합니다. 브라우저에서 refresh token 을 쓰지 않으므로 본 화면 세션과 충돌하지 않습니다.
  - `public/dash/app.js`: 조회 조건(`state`, URL 해시에 저장) → `dash_summary` → 차트(ECharts) · 표. `update()` 하나가 전체를 다시 그립니다.
  - `public/dash/report.js`: 보고서 → A4 미리보기 → `window.print()`. `dash:ready` 이벤트 뒤 `window.Dash` 를 재사용합니다.
  - `public/dash/style.css`: 색상 · 폰트 토큰이 `:root`에 있습니다. 디자인을 바꿀 때는 여기부터 봅니다.
- **`supabase/dashboard.sql`**: `freight_records` → 트리거 → `dash_rows`(정규화) → RPC `dash_meta` · `dash_options` · `dash_summary` · `dash_totals` · `dash_detail`. 여러 번 실행해도 안전하며, 고친 뒤에는 Supabase SQL Editor 에서 전체를 다시 실행합니다.
  - 지표 정의(TEU, 원화/USD 등)는 이 SQL 의 `dash_transform` 에 있습니다. 화면에는 계산 로직이 없습니다.
  - `supabase/dashboard_rollback.sql`: 대시보드 DB 객체를 모두 제거합니다. `freight_records` 데이터는 건드리지 않습니다.
- **수출 (대시보드 전용, `export-v1` 운영 반영, 시작점 이름표 `before-export`)**
  - **수출 관련 작업은 대시보드(`public/dash/`, `supabase/`)에만 합니다. `private/cargo-tool.html` · `pages/` · `middleware.js` 는 고치지 않습니다(사용자 확정, 화물 도구는 수입 중심).** 커밋 전 `git diff --stat before-export -- private/ pages/ middleware.js` 가 비어 있어야 합니다.
  - 대시보드 [데이터 올리기](관리자, `upload.js`, SheetJS 는 `vendor/xlsx.full.min.js` 를 창 열 때만 로드): B/L 번호로 수입 · 수출 자동 판별. **수입은 `freight_records` 에 화물 도구 [클라우드 동기화]와 같은 변환**(`toFreightItems` · `toFreightRecords` 는 cargo-tool.html 코드를 옮긴 것, 화물 도구 쪽이 바뀌면 같이 맞추고 `export.mjs` 로 같은지 확인. `freight_cache` 는 쓰지 않음). 수출은 `export_records` → 트리거 → `dash_rows`(`dir`='OUT'). 수입은 `dir`='IN'. B/L 번호 `…W0001`(수출) / `…E1001`(수입), `export_records` 는 DB 제약으로 W 형식만 받습니다.
  - 모든 RPC 는 조회 조건 `f.dir` 가 없으면 수입만(`'OUT'` 수출, `'ALL'` 전체). `dash_meta` · `dash_options` 는 수입 기준이고, `byDir.OUT/ALL`(= `dash_meta_of` · `dash_options_of`), `dash_meta.export`(수출 현황) · `canUpload`(관리자) 를 함께 줍니다. 결과에 새 칸은 **끝에만 덧붙여** 수입 화면 · 예전 화면이 그대로 동작하게 합니다.
  - 수출 행의 `notify` 칸 = Forwarder (두 번째 업체 축을 그대로 씀), `ckey` = Shipper 사업자번호, `partner` = 중국 쪽 업체. 화면 `state.dir`(URL 해시) 를 바꾸면 목록을 다시 받으려고 새로고침합니다. 축 이름은 `cAx()`/`nAx()`(수입 Consignee/Notify · 수출 Shipper/Forwarder · 전체 업체/Notify · Forwarder).
  - 컨테이너 칸(`cntrCols()`): 수출 보기 = 20' · 40' · 45' · 20RF · 40RF 따로(`dry()`), 수입 · 전체 = 20' · 40' · 45'(수출 RF 포함). 어느 보기든 20' + 20RF + (40' + 40RF + 45') × 2 = TEU.
  - 수출 · 전체 전용: KPI(공컨 이송 · 한국 금액 · 중국 금액), 추이 막대 수입/수출 쌓기, 한국 · 중국 금액 · 공컨 이송 카드, 보고서 13~16절. 수출에서는 특송 · 배정 장소 숨김, [시험] 탭은 수입 보기에서만.
  - 되돌리기: `supabase/export_rollback.sql` 한 파일(수출 객체 제거 + before-export 시점 SQL 원문 포함). 검증: `node export.mjs "<수출엑셀>"`.

## 업무 규칙 (사용자 확정 · 데이터로 검증)

- **TEU** = 20'×1 + 40'×2 + **45'×2**. 단 **B/L Type E**(여객 수화물 · 엠티 컨테이너 운송)는 실제 화물이 아니므로 TEU 0 이고, **물동량 화면의 컨테이너 개수에서도 빼고 셉니다**(2026-10-21 사용자 확정, 화면 `stripE()`. B/L 상세는 B/L 원래 값). B/L Type E 를 TEU 로 세는 곳은 수출 **공컨 이송**(`mt_teu`)뿐입니다. **Cargo**: F=FCL, L=LCL, E=Empty, B=Bulk. **ITEM** 은 코드(RA, EL 등)를 그대로 표시합니다.
- 금액은 모두 Collect 기준입니다. **원화** = THC+DOC+WFG+CCF+TSF+PSC, **USD** = FRT+BAF+CAF+CRS+LSS+PSS+**ESC**(ESC 는 달러 항목).
  `Collect TTL` = 원화 + USD × 적용환율이며 전 건에서 이 식이 맞습니다. 엑셀의 `원화발생금액(C)` 컬럼은 일부 행에서 0이라 쓰지 않습니다.
- **냉동** = B/L 번호에 `E12` 가 있는 B/L(선어 · 활어 포함). 그중 REMARK 에 `선어`가 있으면 선어, `활어`가 있으면 활어(둘 다면 선어 우선), 나머지는 냉동입니다(`dash_rows.rf` = R/S/L). REMARK 의 "냉동 컨테이너"는 Bulk 로 컨테이너를 들여오는 건이라 냉동이 아닙니다.
- **수출**(사용자 확정 · 9월 수출 엑셀로 검증): TEU 는 20RF · 40RF 를 20' · 40' 에 더해 같은 식(B/L Type E 는 0). 냉동 = RF 수량 있음(수입은 지금 방식 유지). **공컨** = B/L Type E 이고 B/L 끝 번호 `1000` → `mt_teu` 로 따로 집계. 금액 = Prepaid TTL(한국 지불) + Collect TTL(중국 지불). **한국 금액 = 수입 CC + 수출 PP, 중국 금액 = 수출 CC 만**(수입 PP 는 저장하지 않으므로 "수입 PP 미집계" 표시). 업체 = Shipper(사업자번호), Forwarder(한글 이름, 사업자번호 없음)는 연결에 쓰지 않고 조회 · 통계 축. 수출입 업체 연결 = 수입 Consignee 사업자번호 또는 수입 Notify 이름 ↔ 수출 Shipper(+ 수동 연결표). 선복량 313TEU, 실무 최대 304TEU. B/L 번호대 구분(8000번대 등)은 하지 않습니다.
- **파트 B/L**(2026-10-22 사용자 확정): PART 열에 값이 있으면 그 모 B/L(메인)의 파트 B/L 이고, 컨테이너는 모 B/L 에만 있으므로 **파트 B/L 의 컨테이너 수량 0 은 정상**(데이터 점검 '컨테이너 수량 0' 에서 뺌, `dash_rows.part`). 수입 `…1158E1072B` 의 PART = `1072A`(끝이 영문, PART 는 저장 안 함 → B/L 끝 영문 + 컨테이너 0 으로 판단, 2025-10 ~ 2026-09 엑셀 1,733건 일치), 수출 `…W0312` 의 PART = `311`(숫자라 번호로 못 가림 → `export_records.part` 저장).
- 업체는 Consignee(사업자번호로 구분)와 Notify(이름) 두 축입니다. AND/OR 조건을 지원하며, Notify 가 없으면 `''`입니다. 수입 Notify 없음은 정상(데이터 점검에서 세지 않음), **수출 Forwarder 없음은 오류**(점검 'Forwarder 미지정', 2026-10-22 사용자 확정).
- 기간은 `I/O Date`(입항일) 기준입니다. 비교 기간은 달 단위로 골랐으면 직전 같은 개월 수, 아니면 직전 같은 일수입니다.
- 엑셀 헤더의 `FRT(＄)`, `BAF(＄)`는 전각 `＄`(U+FF04)입니다. 배정장소 `동방 cfs`는 `동방 CFS`로 합칩니다.
- `Insert by`/`Update by`(작업자 이름)는 개인정보이므로 저장 · 표시하지 않습니다. 실제 업체명 · 사업자번호가 든 엑셀/CSV 는 저장소에 올리지 않습니다(`.gitignore`).

## 작업 방식 (안전하게)

- 사용자용 수정 · 배포 절차(테스트 주소, Supabase SQL 실행법, 요청 문구, 변경 기록)는 `작업가이드.md`에 있습니다. 배포할 때마다 9장 변경 기록과 6장 이름표 표를 갱신합니다.

- **`main` = 운영(푸시하면 Vercel 이 바로 배포합니다).** 기능 · 디자인 작업은 `dev` 같은 브랜치에서 하고, Vercel 미리보기 주소에서 확인한 뒤 main 에 합칩니다.
- 올리는 방법은 git 하나로 통일합니다(GitHub 웹 업로드와 섞으면 로컬과 GitHub 이 어긋납니다). 커밋 · 푸시는 사용자가 요청할 때만 합니다.
- 큰 작업이 끝나면 이름표(태그)를 답니다: `git tag -a dashboard-v2 -m "..." && git push origin dashboard-v2`.
  - 현재 이름표: `before-dashboard`(대시보드 이전), `dashboard-v1`(대시보드 첫 버전), `dashboard-v2`(B/L 타입 · 특송 조건, KPI 개편, 추이 차트 · 표), `dashboard-v3`(조회 조건 스크롤 분리), `dashboard-v4`(Notify · 누적 비중 열, 냉동 · 환적 · 특송 카드, 인보이스 차액 메일 양식), `dashboard-v5`(냉동 · 환적 · 특송 막대 · 도넛 · 표 전환, 상위 10 표, 보고서 구성 · B/L 상세 목록), `dashboard-v5.1`(보고서 차트 쪽 잘림 수정), `freight-check-v1`(운임 체크 4/1 이전 입항분 비교 제외), `freight-table-v1`(기본 운임표 1원 오차 수정 · 할인 행 숨김 · 디자인, 전체 공지 중량), `teu-empty-v1`(B/L Type E TEU 0), `before-stats`(시험 탭 직전), `stats-test-v1`([시험] 보기 전환 · 고객 변화 · Shipper 연결), `todo-v1`(To Do 고치기 · 순서 바꾸기 · 중요 표시 · 완료 기록), `freight-rates-v1`(요율 이력표 한 곳 관리, 운임 체크 입항일 요율), `table-edi-v1`(결과 표 너비 · 머리글/왼쪽 열 고정, 과거 불일치 다른 항목만 보기, EDI 내부오류 보강), `past-data-v1`(운임 체크 4/1 이후만 서버에서 받기, 대시보드 상세 목록 1,000건 제한), `checklist-deposit-v1`(체크리스트 입금내역), `before-export`(수출 대시보드 직전), `export-v1`(대시보드 수출 · 데이터 올리기 · 공컨 · 선복 대비), `freight-check-dedup-v1`(운임 체크 같은 운임 한 건만 받기 복구).
- **결과 표 공통**: `.sticky-cols-2` 클래스 = 왼쪽 두 열 고정(두 번째 열 위치는 파일 끝 `setupStickyColumns`가 `--sticky-left-2`로 넣음). 표 상자(`.edi-table-container` · `.fc-table-container` · `#freightTableScroll`)는 `max-height: calc(100vh - 120px)`.
- **EDI 내부오류**(`checkExcelInternalErrors`): `{ errors, notices }`를 돌려주고 `notices`는 `#ediInternalCheckNotice`에 표시. E3000=수화물(컨테이너 영문4+숫자7, 씰 `1`은 임시값), E4000=공샤시. 둘 다 엑셀 전용 B/L(EDI에 없어야 정상).
- **요율**: `cargo-tool.html`의 `FREIGHT_RATE_BASE`(가장 오래된 요율) + `FREIGHT_RATE_CHANGES`(변경일별 바뀐 항목) → `freightRatesOn(입항일)`. 기본 운임표 · 운임 체크가 모두 이것만 씁니다. 45' THC 계약 할인(210,000)은 `FREIGHT_THC45_DISCOUNT_END`(2026-10-02) 로 따로 관리합니다. 요율 숫자를 다른 곳에 직접 쓰지 않습니다.
- **운임 체크 과거 기록 (바꿀 때 반드시 지킬 것)**
  - 흐름: 검증 엑셀의 Consignee 목록 → RPC `get_past_freight_since(화주 목록, 기준일, 요율 경계일)`(`supabase/freight_check_past.sql`) → 화면 `fcCompareHistory`가 B/L 마다 같은 화주의 과거 건 중 **차이가 가장 적은 한 건**과 비교. 수입(`freight_records`)만 봅니다.
  - 서버에서 하는 일: ① 기준일(`FC_BASELINE_FROM`, 2026-04-01) **이전 입항분을 먼저 뺌**(입항일 해석 `dash_date`) ② **비교에 쓰는 24개 칸**(consignee · cargo · bt · ts · consignee_code · notify · actual_shipper · a_shipper_code · twenty · forty · forty_five · crs_c · lss_c · pss_c · frt_c · esc · caf · baf_c · thc · ccf · doc · wfg · tsf · psc)이 모두 같은 건은 **한 건만**(가장 최근 입항) ③ 단, **요율 구간**(화면이 넘기는 `FREIGHT_RATE_CHANGES` 날짜 + `FREIGHT_THC45_DISCOUNT_END`)이 다르면 따로 남김 — 과거 건 입항일로 THC 요율 · 45' 할인 종료 차액을 보정하기 때문 ④ 업체명은 띄어쓰기를 무시하고도 찾음.
  - 이렇게 해야 결과가 "모두 받은 경우"와 같고 받는 양은 약 1/15 (2026-10-21 검증: 51항차 × 2경우 102회 결과 완전 일치, 항차당 6,661건 → 557건, 5.4MB → 0.35MB). 화면 안내: "○건 (타겟 화주 ○개사 연동, 같은 운임 ○건 합침, 4/1 이전 ○건 제외)".
  - `fcCompareHistory`가 과거 건에서 새로 쓰는 칸(예: 다른 날짜 판단 · Weight)이 생기면 **합치는 기준(24개 칸 · 요율 구간)에도 넣어야** 합니다. 고친 뒤에는 "모두 받기 vs 합쳐 받기" 결과가 같은지 확인합니다(화면 함수는 `/tool` 페이지 전역이라 puppeteer 로 바로 부를 수 있음).
  - 예비: 새 함수가 없거나 오류면 예전 `get_past_freight_by_consignees`(원문 `supabase/legacy_get_past_freight_by_consignees.sql`, 같은 24개 칸 합침) 로 받고 화면에서 4/1 이전을 거릅니다.
  - **교훈 (2026-10-21)**: `past-data-v1`에서 예전 함수 내용을 확인하지 않고 "전체 기록을 보낸다"고 가정해 새 함수를 만들어, 합치기(사용량 최적화)가 빠졌었음. **Supabase 에만 있는 함수 · 정책을 대체하거나 고칠 때는 먼저 사용자에게 `select pg_get_functiondef('public.함수명'::regproc);` 결과를 받아 원문을 확인하고, 저장소에 원문을 남긴 뒤 진행**합니다.
- **대시보드 CSV · 보고서 B/L 상세 목록**은 `DETAIL_MAX`(1,000건, `app.js`)까지만 받습니다(1,000건 ≈ 0.4MB). 운임 필터 검색은 500건 제한을 유지합니다(사용자 결정).
- **[시험] 고객 변화 · Shipper 연결 탭**: `supabase/stats_customers.sql` · `stats_shippers.sql`(새 함수만), 되돌리기 `stats_rollback.sql`. 코드에는 `[실험]` 표시. 기존 `dashboard.sql` 함수는 바꾸지 않습니다.
- **되돌리기**
  - 화면만: Vercel → Deployments → 이전 배포 → Promote to Production.
  - 코드: 해당 이름표 기준으로 되돌린 커밋을 만들어 푸시합니다.
  - DB: `supabase/dashboard_rollback.sql`.
- DB를 바꾸기 전에는 사용자에게 Supabase `freight_records` CSV 백업을 권합니다. 무료 플랜은 자동 백업을 내려받을 수 없습니다.

## 명령어 · 검증

```bash
npm run dev                         # 로컬 Next.js (.env.local 필요). 실제 Supabase 에 붙으므로 주의
node --check public/dash/app.js     # JS 문법 확인 (테스트 프레임워크 없음)

# SQL · 대시보드 로컬 검증 (실제 Supabase 를 건드리지 않음). 처음 한 번 npm install
cd scripts/dash-test && npm install
node setup.mjs "<운임엑셀.xlsx>"    # PGlite 에 Supabase 흉내 DB → cargo-tool.html 의 실제 업로드 매핑으로 적재 → dashboard.sql
node serve.mjs                      # http://localhost:5179/dash/index.html , /tool (PostgREST · 토큰 API 흉내)
node ui.mjs                         # 시스템 Chrome 으로 필터 · 표 · 보고서 · 탭 연결 조작 → shots/
node rollback.mjs                   # 되돌리기 → 재적용 검증 (원본 데이터 불변 확인)
node export.mjs "<수출엑셀>" ["<수입엑셀>"]  # 수출: before-export 대비 수입 결과 불변 · 수출 집계 = 엑셀 · 권한 · export_rollback 검증 → pgex/
DASH_DB=pgex DASH_ADMIN=1 node serve.mjs   # 수입+수출 DB, 관리자로 화면 확인 (수출 데이터 올리기)
```

- SQL 을 고치면 `setup.mjs`와 `rollback.mjs`로 먼저 확인한 뒤 Supabase 에서 실행합니다.
- 화면 확인은 `ui.mjs` 스크린샷으로 합니다. puppeteer 는 모바일 390px 화면도 직접 띄울 수 있습니다.
- Windows 콘솔(cp949)에서는 한글 출력이 깨질 수 있습니다. 엑셀 분석 결과는 `encoding='utf-8'` 파일로 써서 확인합니다.
