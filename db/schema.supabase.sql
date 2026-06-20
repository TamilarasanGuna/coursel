-- Supabase / Postgres schema for the LeetCode dashboard.
-- Safe to run multiple times (IF NOT EXISTS). Paste into the Supabase SQL editor
-- once, or let the server run it automatically on first boot with DB_DRIVER=supabase.

create table if not exists colleges (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  access_code text,
  view_token  text,
  created_at  timestamptz not null default now()
);

create table if not exists students (
  id             bigint generated always as identity primary key,
  college_id     bigint not null references colleges(id) on delete cascade,
  name           text not null,
  username       text not null,
  profile_url    text,
  ranking        integer,
  contest_rating integer,
  solved_easy    integer default 0,
  solved_medium  integer default 0,
  solved_hard    integer default 0,
  solved_total   integer default 0,
  found          integer default 1,            -- 0 if profile not found / private
  sync_status    text default 'pending',       -- pending | ok | error
  sync_error     text,
  last_synced_at timestamptz,
  -- baseline = stats captured on the first successful sync (for progress tracking)
  baseline_ranking integer,
  baseline_easy    integer,
  baseline_medium  integer,
  baseline_hard    integer,
  baseline_total   integer,
  baseline_at      timestamptz,
  created_at     timestamptz not null default now(),
  unique (college_id, username)
);
-- For projects created before the baseline columns existed:
alter table students add column if not exists baseline_ranking integer;
alter table students add column if not exists baseline_easy integer;
alter table students add column if not exists baseline_medium integer;
alter table students add column if not exists baseline_hard integer;
alter table students add column if not exists baseline_total integer;
alter table students add column if not exists baseline_at timestamptz;
-- Roster metadata:
alter table students add column if not exists register_number text;
alter table students add column if not exists email text;
alter table students add column if not exists department text;
alter table students add column if not exists section text;
alter table students add column if not exists year text;
alter table students add column if not exists campus text;
create index if not exists idx_students_filters on students(college_id, section, department, campus);

create table if not exists monthly_activity (
  student_id  bigint not null references students(id) on delete cascade,
  ym          text not null,                   -- 'YYYY-MM'
  submissions integer not null default 0,
  primary key (student_id, ym)
);

create table if not exists stat_snapshots (
  id            bigint generated always as identity primary key,
  student_id    bigint not null references students(id) on delete cascade,
  taken_at      timestamptz not null default now(),
  solved_easy   integer, solved_medium integer, solved_hard integer, solved_total integer
);

create table if not exists practice_problems (
  id          bigint generated always as identity primary key,
  college_id  bigint not null references colleges(id) on delete cascade,
  title       text not null,
  slug        text not null,
  url         text not null,
  difficulty  text,
  topic       text,
  created_at  timestamptz not null default now(),
  unique (college_id, slug)
);
-- For projects created before the topic column existed:
alter table practice_problems add column if not exists topic text;

create table if not exists practice_completions (
  student_id       bigint not null references students(id) on delete cascade,
  problem_id       bigint not null references practice_problems(id) on delete cascade,
  completed_at     timestamptz not null default now(),
  solved_timestamp bigint,
  primary key (student_id, problem_id)
);

create index if not exists idx_students_college on students(college_id);
create index if not exists idx_problems_college on practice_problems(college_id);
create index if not exists idx_snapshots_student on stat_snapshots(student_id);
