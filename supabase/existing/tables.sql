-- =====================================================================
--  [보관용 · 실행하지 마세요] 표 · 칸 · 기본키 · 제약 · 인덱스
--  Supabase 에서 2026-11-16 받아 둔 원문입니다. 실행용이 아닙니다(이미 Supabase 에 있음).
--  조회문: 시스템 표(pg_class · pg_constraint · pg_indexes · pg_policies · pg_trigger · pg_proc)에서 꺼낸 내용을
--  읽기 쉽게 create 문 모양으로 옮겼습니다. 새 프로젝트로 옮기거나 복구할 때 참고합니다.
--  dash_rows · export_records · ex_act_bl 은 supabase/dashboard.sql 이 만드는 표입니다(참고로 함께 둠).
--  freight_records 의 id 는 기본값 없이 나옵니다(자동 번호 identity 여부는 이 조회로 확인하지 않음).
-- =====================================================================
-- container_cache
create table public.container_cache (
  id text not null default 'latest'::text,
  container_list jsonb,
  soc_list jsonb,
  nonsoc_list jsonb,
  in_yard_list jsonb,
  free_time_list jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  updated_by text,
  constraint container_cache_pkey PRIMARY KEY (id)
);

-- freight_cache
create table public.freight_cache (
  id text not null default 'latest'::text,
  freight_data_list jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  updated_by text,
  constraint freight_cache_pkey PRIMARY KEY (id)
);

-- freight_records
create table public.freight_records (
  id bigint not null,
  io_date text,
  bl_no text not null,
  cargo text,
  voyage text,
  description text,
  bt text,
  consignee_code text,
  consignee text,
  notify text,
  actual_shipper text,
  a_shipper_code text,
  shipper text,
  twenty text default '0'::text,
  forty text default '0'::text,
  forty_five text default '0'::text,
  ts text,
  item text,
  remark text,
  crs_c text default '0'::text,
  lss_c text default '0'::text,
  pss_c text default '0'::text,
  frt_c text default '0'::text,
  esc text,
  caf text,
  baf_c text default '0'::text,
  thc text,
  ccf text,
  doc text,
  wfg text,
  tsf text,
  psc text,
  ebs_c text default '0'::text,
  cfs text,
  collect_ttl text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  updated_by text,
  vsl text,
  issue_date text,
  ft text,
  pkg text,
  weight text,
  measure text,
  place text,
  constraint freight_records_pkey PRIMARY KEY (id)
);
CREATE INDEX idx_freight_records_actual_shipper ON public.freight_records USING btree (actual_shipper);
CREATE UNIQUE INDEX idx_freight_records_bl_no ON public.freight_records USING btree (bl_no);
CREATE INDEX idx_freight_records_consignee ON public.freight_records USING btree (consignee);
CREATE INDEX idx_freight_records_consignee_code ON public.freight_records USING btree (consignee_code);
CREATE INDEX idx_freight_records_io_date ON public.freight_records USING btree (io_date);

-- profiles
create table public.profiles (
  id uuid not null,
  email text,
  is_approved boolean default false,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  is_admin boolean default false,
  constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  constraint profiles_pkey PRIMARY KEY (id)
);

-- (dashboard.sql 이 만드는 표) dash_rows
create table public.dash_rows (
  bl text not null,
  vsl text,
  voyage text,
  d date,
  issue_date date,
  ckey text not null,
  c_code text,
  c_name text,
  notify text,
  shipper text,
  a_shipper text,
  item text,
  cargo text,
  bt text,
  ts numeric,
  ft text,
  c20 numeric,
  c40 numeric,
  c45 numeric,
  teu numeric,
  cntr numeric,
  pkg numeric,
  weight numeric,
  cbm numeric,
  thc numeric,
  doc numeric,
  wfg numeric,
  ccf numeric,
  tsf numeric,
  psc numeric,
  esc numeric,
  frt numeric,
  baf numeric,
  caf numeric,
  crs numeric,
  lss numeric,
  pss numeric,
  krw numeric,
  usd numeric,
  total numeric,
  place text,
  remark text,
  descr text,
  ext boolean not null default false,
  synced_at timestamp with time zone not null default now(),
  rf text,
  dir text not null default 'IN'::text,
  fwd text,
  partner text,
  rf20 numeric,
  rf40 numeric,
  cfs numeric,
  pp numeric,
  cc numeric,
  mt_teu numeric,
  part boolean,
  exd text,
  constraint dash_rows_pkey PRIMARY KEY (bl)
);
CREATE INDEX dash_rows_ckey_idx ON public.dash_rows USING btree (ckey);
CREATE INDEX dash_rows_d_idx ON public.dash_rows USING btree (d);
CREATE INDEX dash_rows_notify_idx ON public.dash_rows USING btree (notify);

-- (dashboard.sql 이 만드는 표) ex_act_bl
create table public.ex_act_bl (
  bl_no text not null,
  updated_at timestamp with time zone not null default now(),
  constraint ex_act_bl_pkey PRIMARY KEY (bl_no)
);

-- (dashboard.sql 이 만드는 표) export_records
create table public.export_records (
  bl_no text not null,
  vsl text,
  voyage text,
  io_date text,
  cargo text,
  bt text,
  ts text,
  shipper_code text,
  shipper text,
  a_shipper_code text,
  actual_shipper text,
  forwarder text,
  consignee text,
  twenty text,
  forty text,
  forty_five text,
  rf20 text,
  rf40 text,
  item text,
  issue_date text,
  pkg text,
  weight text,
  measure text,
  ft text,
  frt_p text,
  frt_c text,
  baf_p text,
  baf_c text,
  caf text,
  crs_p text,
  crs_c text,
  lss_p text,
  lss_c text,
  esc text,
  thc text,
  doc text,
  wfg text,
  cfs text,
  ccf text,
  tsf text,
  psc text,
  prepaid_ttl text,
  collect_ttl text,
  description text,
  remark text,
  ccam_check text,
  updated_at timestamp with time zone not null default now(),
  updated_by text,
  part text,
  constraint export_records_bl_no_check CHECK ((bl_no ~ '[0-9]W[0-9]{4}$'::text)),
  constraint export_records_pkey PRIMARY KEY (bl_no)
);

