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

## 업무 규칙 (사용자 확정 · 데이터로 검증)

- **TEU** = 20'×1 + 40'×2 + **45'×2**. **Cargo**: F=FCL, L=LCL, E=Empty, B=Bulk. **ITEM** 은 코드(RA, EL 등)를 그대로 표시합니다.
- 금액은 모두 Collect 기준입니다. **원화** = THC+DOC+WFG+CCF+TSF+PSC, **USD** = FRT+BAF+CAF+CRS+LSS+PSS+**ESC**(ESC 는 달러 항목).
  `Collect TTL` = 원화 + USD × 적용환율이며 전 건에서 이 식이 맞습니다. 엑셀의 `원화발생금액(C)` 컬럼은 일부 행에서 0이라 쓰지 않습니다.
- 업체는 Consignee(사업자번호로 구분)와 Notify(이름) 두 축입니다. AND/OR 조건을 지원하며, Notify 가 없으면 `''`입니다.
- 기간은 `I/O Date`(입항일) 기준입니다. 비교 기간은 달 단위로 골랐으면 직전 같은 개월 수, 아니면 직전 같은 일수입니다.
- 엑셀 헤더의 `FRT(＄)`, `BAF(＄)`는 전각 `＄`(U+FF04)입니다. 배정장소 `동방 cfs`는 `동방 CFS`로 합칩니다.
- `Insert by`/`Update by`(작업자 이름)는 개인정보이므로 저장 · 표시하지 않습니다. 실제 업체명 · 사업자번호가 든 엑셀/CSV 는 저장소에 올리지 않습니다(`.gitignore`).

## 작업 방식 (안전하게)

- 사용자용 수정 · 배포 절차(테스트 주소, Supabase SQL 실행법, 요청 문구, 변경 기록)는 `작업가이드.md`에 있습니다. 배포할 때마다 9장 변경 기록과 6장 이름표 표를 갱신합니다.

- **`main` = 운영(푸시하면 Vercel 이 바로 배포합니다).** 기능 · 디자인 작업은 `dev` 같은 브랜치에서 하고, Vercel 미리보기 주소에서 확인한 뒤 main 에 합칩니다.
- 올리는 방법은 git 하나로 통일합니다(GitHub 웹 업로드와 섞으면 로컬과 GitHub 이 어긋납니다). 커밋 · 푸시는 사용자가 요청할 때만 합니다.
- 큰 작업이 끝나면 이름표(태그)를 답니다: `git tag -a dashboard-v2 -m "..." && git push origin dashboard-v2`.
  - 현재 이름표: `before-dashboard`(대시보드 이전), `dashboard-v1`(대시보드 첫 버전), `dashboard-v2`(B/L 타입 · 특송 조건, KPI 개편, 추이 차트 · 표).
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
```

- SQL 을 고치면 `setup.mjs`와 `rollback.mjs`로 먼저 확인한 뒤 Supabase 에서 실행합니다.
- 화면 확인은 `ui.mjs` 스크린샷으로 합니다. puppeteer 는 모바일 390px 화면도 직접 띄울 수 있습니다.
- Windows 콘솔(cp949)에서는 한글 출력이 깨질 수 있습니다. 엑셀 분석 결과는 `encoding='utf-8'` 파일로 써서 확인합니다.
