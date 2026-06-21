// Postgres / Supabase implementation of the data layer.
// Exposes the SAME async API as db.js (the SQLite store). Selected when
// DB_DRIVER=supabase. Talks to Postgres over a direct connection string using
// the `pg` driver, keeping the SQL close to the SQLite version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.supabase.sql');

let pool;
const q = (text, params) => pool.query(text, params);

// Timestamps are returned as 'YYYY-MM-DD HH24:MI:SS' text so the frontend's
// date helpers behave the same as on the SQLite path.
const TS = (col, alias) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS') AS ${alias}`;
const STUDENT_COLS = `id, college_id, name, username, profile_url, ranking, contest_rating,
  solved_easy, solved_medium, solved_hard, solved_total, found, sync_status, sync_error,
  baseline_ranking, baseline_easy, baseline_medium, baseline_hard, baseline_total,
  register_number, email, department, section, year, campus,
  ${TS('last_synced_at', 'last_synced_at')}, ${TS('baseline_at', 'baseline_at')}, ${TS('created_at', 'created_at')}`;

// WHERE clause + params ($n) for student filters.
function studentWhere(collegeId, f = {}) {
  const params = [collegeId];
  const cond = ['college_id = $1'];
  const p = (v) => { params.push(v); return '$' + params.length; };
  if (f.batch) cond.push(`section = ${p(f.batch)}`);
  if (f.department) cond.push(`department = ${p(f.department)}`);
  if (f.campus) cond.push(`campus = ${p(f.campus)}`);
  if (f.q) {
    const l = '%' + f.q + '%';
    cond.push(`(name ILIKE ${p(l)} OR username ILIKE ${p(l)} OR register_number ILIKE ${p(l)})`);
  }
  return { where: cond.join(' AND '), params };
}

export async function initStore() {
  if (!config.supabase.connectionString) {
    throw new Error(
      'DB_DRIVER=supabase but SUPABASE_DB_URL (Postgres connection string) is not set.'
    );
  }
  pool = new pg.Pool({
    connectionString: config.supabase.connectionString,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL
    max: 5,
  });
  await q('SELECT 1');
  // Ensure schema exists (idempotent).
  await q(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  console.log('[db] driver: supabase (postgres)');
}

// ---- College helpers --------------------------------------------------------

export async function getOrCreateCollege(name) {
  const clean = String(name).trim();
  await q('INSERT INTO colleges(name) VALUES ($1) ON CONFLICT(name) DO NOTHING', [clean]);
  const { rows } = await q('SELECT * FROM colleges WHERE name=$1', [clean]);
  return rows[0];
}

export async function listColleges() {
  const { rows } = await q(
    `SELECT c.id, c.name, ${TS('c.created_at', 'created_at')},
       (CASE WHEN c.access_code IS NOT NULL AND c.access_code <> '' THEN 1 ELSE 0 END) AS has_code,
       (SELECT COUNT(*) FROM students s WHERE s.college_id = c.id)::int AS student_count
     FROM colleges c ORDER BY c.name`
  );
  return rows;
}

export async function getCollege(id) {
  const { rows } = await q('SELECT * FROM colleges WHERE id=$1', [id]);
  return rows[0];
}

export async function deleteCollege(id) {
  await q('DELETE FROM colleges WHERE id=$1', [id]); // cascades via FK ON DELETE CASCADE
}

export async function setAccessCode(id, code) {
  await q('UPDATE colleges SET access_code=$1 WHERE id=$2', [(code || '').trim(), id]);
}

export async function checkAccessCode(id, code) {
  const c = await getCollege(id);
  if (!c || !c.access_code) return false;
  return String(code || '').trim() === String(c.access_code).trim();
}

export async function getCollegeByToken(t) {
  if (!t) return undefined;
  const { rows } = await q('SELECT * FROM colleges WHERE view_token=$1', [t]);
  return rows[0];
}

export async function ensureViewToken(id, regenerate = false) {
  const c = await getCollege(id);
  if (!c) return null;
  if (c.view_token && !regenerate) return c.view_token;
  const token = randomUUID();
  await q('UPDATE colleges SET view_token=$1 WHERE id=$2', [token, id]);
  return token;
}

export async function studentsBasic(collegeId) {
  const { rows } = await q(
    'SELECT id, name, username FROM students WHERE college_id=$1 ORDER BY name',
    [collegeId]
  );
  return rows;
}

// ---- Student helpers --------------------------------------------------------

export async function upsertStudent({
  college_id, name, username, profile_url,
  register_number = null, email = null, department = null, section = null, year = null, campus = null,
}) {
  const { rows } = await q(
    `INSERT INTO students (college_id, name, username, profile_url, register_number, email, department, section, year, campus)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (college_id, username) DO UPDATE SET
       name = EXCLUDED.name,
       profile_url     = COALESCE(EXCLUDED.profile_url, students.profile_url),
       register_number = COALESCE(EXCLUDED.register_number, students.register_number),
       email           = COALESCE(EXCLUDED.email, students.email),
       department      = COALESCE(EXCLUDED.department, students.department),
       section         = COALESCE(EXCLUDED.section, students.section),
       year            = COALESCE(EXCLUDED.year, students.year),
       campus          = COALESCE(EXCLUDED.campus, students.campus)
     RETURNING id`,
    [college_id, name, username, profile_url, register_number, email, department, section, year, campus]
  );
  return rows[0].id;
}

export async function listStudents(collegeId) {
  const { rows } = await q(
    `SELECT ${STUDENT_COLS} FROM students WHERE college_id=$1 ORDER BY solved_total DESC, name`,
    [collegeId]
  );
  return rows;
}

export async function getStudentsPage(collegeId, f = {}) {
  const { where, params } = studentWhere(collegeId, f);
  const pageSize = Math.min(500, Math.max(1, f.pageSize || 100));
  const page = Math.max(1, f.page || 1);
  const offset = (page - 1) * pageSize;
  const total = (await q(`SELECT COUNT(*)::int AS c FROM students WHERE ${where}`, params)).rows[0].c;
  const rows = (await q(
    `SELECT ${STUDENT_COLS} FROM students WHERE ${where} ORDER BY solved_total DESC, name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  )).rows;
  return { rows, total, offset };
}

export async function getCollegeTotals(collegeId, f = {}) {
  const { where, params } = studentWhere(collegeId, f);
  const { rows } = await q(`
    SELECT COUNT(*)::int AS students,
      COALESCE(SUM(solved_easy),0)::int AS easy,
      COALESCE(SUM(solved_medium),0)::int AS medium,
      COALESCE(SUM(solved_hard),0)::int AS hard,
      COALESCE(SUM(solved_total),0)::int AS total
    FROM students WHERE ${where}`, params);
  return rows[0];
}

export async function getCollegeMonthly(collegeId, f = {}) {
  const { where, params } = studentWhere(collegeId, f);
  const { rows } = await q(`
    SELECT ym, SUM(submissions)::int AS submissions
    FROM monthly_activity JOIN students ON students.id = monthly_activity.student_id
    WHERE ${where} GROUP BY ym ORDER BY ym`, params);
  return rows;
}

export async function getFilterOptions(collegeId) {
  const distinct = async (col) =>
    (await q(`SELECT DISTINCT ${col} AS v FROM students WHERE college_id=$1 AND ${col} IS NOT NULL AND ${col}<>'' ORDER BY ${col}`, [collegeId])).rows.map((r) => r.v);
  return { batches: await distinct('section'), departments: await distinct('department'), campuses: await distinct('campus') };
}

export async function getAllStudents() {
  const { rows } = await q(`SELECT ${STUDENT_COLS} FROM students`);
  return rows;
}

export async function getRankInCollege(collegeId, solvedTotal) {
  const { rows } = await q(
    'SELECT COUNT(*)::int AS c FROM students WHERE college_id=$1 AND solved_total > $2',
    [collegeId, solvedTotal]
  );
  return rows[0].c + 1;
}

export async function getStudent(id) {
  const { rows } = await q(`SELECT ${STUDENT_COLS} FROM students WHERE id=$1`, [id]);
  return rows[0];
}

export async function getStudentByUsername(collegeId, username) {
  const { rows } = await q(
    `SELECT ${STUDENT_COLS} FROM students WHERE college_id=$1 AND username=$2`,
    [collegeId, username]
  );
  return rows[0];
}

export async function getStudentByEmail(collegeId, email) {
  const { rows } = await q(
    `SELECT ${STUDENT_COLS} FROM students WHERE college_id=$1 AND LOWER(email)=LOWER($2)`,
    [collegeId, String(email).trim()]
  );
  return rows[0];
}

export async function deleteStudent(id) {
  await q('DELETE FROM students WHERE id=$1', [id]);
}

export async function saveStudentStats(id, stats) {
  if (!stats.found) {
    await q(
      `UPDATE students SET found=0, sync_status='error',
       sync_error='Profile not found or private', last_synced_at=now() WHERE id=$1`,
      [id]
    );
    return;
  }

  const monthly = {};
  for (const [ts, count] of Object.entries(stats.submissionCalendar || {})) {
    const d = new Date(Number(ts) * 1000);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthly[ym] = (monthly[ym] || 0) + Number(count);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE students SET
         found=1, ranking=$1, contest_rating=$2,
         solved_easy=$3, solved_medium=$4, solved_hard=$5, solved_total=$6,
         baseline_ranking=COALESCE(baseline_ranking, $8),
         baseline_easy=COALESCE(baseline_easy, $9),
         baseline_medium=COALESCE(baseline_medium, $10),
         baseline_hard=COALESCE(baseline_hard, $11),
         baseline_total=COALESCE(baseline_total, $12),
         baseline_at=COALESCE(baseline_at, now()),
         sync_status='ok', sync_error=NULL, last_synced_at=now()
       WHERE id=$7`,
      [
        stats.ranking ?? null,
        stats.contestRating ?? null,
        stats.solved.easy,
        stats.solved.medium,
        stats.solved.hard,
        stats.solved.total,
        id,
        stats.ranking ?? null,
        stats.solved.easy,
        stats.solved.medium,
        stats.solved.hard,
        stats.solved.total,
      ]
    );
    await client.query(
      `INSERT INTO stat_snapshots(student_id, solved_easy, solved_medium, solved_hard, solved_total)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, stats.solved.easy, stats.solved.medium, stats.solved.hard, stats.solved.total]
    );
    for (const [ym, count] of Object.entries(monthly)) {
      await client.query(
        `INSERT INTO monthly_activity(student_id, ym, submissions) VALUES ($1,$2,$3)
         ON CONFLICT (student_id, ym) DO UPDATE SET submissions=EXCLUDED.submissions`,
        [id, ym, count]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function resetBaseline(id) {
  await q(
    `UPDATE students SET
       baseline_ranking=ranking, baseline_easy=solved_easy, baseline_medium=solved_medium,
       baseline_hard=solved_hard, baseline_total=solved_total, baseline_at=now()
     WHERE id=$1`,
    [id]
  );
}

export async function setSyncError(id, message) {
  await q(
    `UPDATE students SET sync_status='error', sync_error=$1, last_synced_at=now() WHERE id=$2`,
    [message, id]
  );
}

export async function getMonthlyActivity(studentId) {
  const { rows } = await q(
    'SELECT ym, submissions FROM monthly_activity WHERE student_id=$1 ORDER BY ym',
    [studentId]
  );
  return rows;
}

export async function getMonthlySolvedGrowth(studentId) {
  const { rows: snaps } = await q(
    `SELECT to_char(taken_at,'YYYY-MM') AS ym,
            solved_easy, solved_medium, solved_hard, solved_total
     FROM stat_snapshots WHERE student_id=$1 ORDER BY taken_at`,
    [studentId]
  );
  if (snaps.length < 2) return [];
  const lastByMonth = new Map();
  for (const s of snaps) lastByMonth.set(s.ym, s);
  const months = [...lastByMonth.keys()].sort();
  const out = [];
  let prev = snaps[0];
  for (const ym of months) {
    const cur = lastByMonth.get(ym);
    out.push({
      ym,
      easy: Math.max(0, cur.solved_easy - prev.solved_easy),
      medium: Math.max(0, cur.solved_medium - prev.solved_medium),
      hard: Math.max(0, cur.solved_hard - prev.solved_hard),
      total: Math.max(0, cur.solved_total - prev.solved_total),
    });
    prev = cur;
  }
  return out;
}

// ---- Practice helpers -------------------------------------------------------

export async function addPracticeProblem({ college_id, title, slug, url, difficulty, topic, domain }) {
  const { rows } = await q(
    `INSERT INTO practice_problems(college_id, title, slug, url, difficulty, topic, domain)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (college_id, slug) DO UPDATE SET
       title=EXCLUDED.title, url=EXCLUDED.url, difficulty=EXCLUDED.difficulty,
       topic=EXCLUDED.topic, domain=EXCLUDED.domain
     RETURNING id`,
    [college_id, title, slug, url, difficulty, topic ?? null, domain ?? null]
  );
  return rows[0].id;
}

export async function listPracticeProblems(collegeId) {
  const { rows } = await q(
    `SELECT id, college_id, title, slug, url, difficulty, topic, domain, ${TS('created_at', 'created_at')}
     FROM practice_problems WHERE college_id=$1 ORDER BY domain NULLS FIRST, topic NULLS FIRST, created_at DESC`,
    [collegeId]
  );
  return rows;
}

export async function listTopics(collegeId) {
  const { rows } = await q(
    "SELECT DISTINCT topic FROM practice_problems WHERE college_id=$1 AND topic IS NOT NULL AND topic<>'' ORDER BY topic",
    [collegeId]
  );
  return rows.map((r) => r.topic);
}

export async function listDomains(collegeId) {
  const { rows } = await q(
    "SELECT DISTINCT domain FROM practice_problems WHERE college_id=$1 AND domain IS NOT NULL AND domain<>'' ORDER BY domain",
    [collegeId]
  );
  return rows.map((r) => r.domain);
}

export async function getPracticeProblemsByCollege(collegeId) {
  const { rows } = await q('SELECT * FROM practice_problems WHERE college_id=$1', [collegeId]);
  return rows;
}

export async function getProblemBySlug(collegeId, slug) {
  const { rows } = await q(
    'SELECT * FROM practice_problems WHERE college_id=$1 AND slug=$2',
    [collegeId, slug]
  );
  return rows[0];
}

export async function countPracticeProblems(collegeId) {
  const { rows } = await q('SELECT COUNT(*)::int AS c FROM practice_problems WHERE college_id=$1', [collegeId]);
  return rows[0].c;
}

export async function deletePracticeProblem(id) {
  await q('DELETE FROM practice_problems WHERE id=$1', [id]);
}

export async function markCompletion(studentId, problemId, solvedTimestamp) {
  const r = await q(
    `INSERT INTO practice_completions(student_id, problem_id, solved_timestamp)
     VALUES ($1,$2,$3) ON CONFLICT (student_id, problem_id) DO NOTHING`,
    [studentId, problemId, solvedTimestamp ?? null]
  );
  return r.rowCount > 0;
}

export async function getCompletionsForCollege(collegeId) {
  const { rows } = await q(
    `SELECT pc.student_id, pc.problem_id, ${TS('pc.completed_at', 'completed_at')}
     FROM practice_completions pc
     JOIN practice_problems pp ON pp.id = pc.problem_id
     WHERE pp.college_id = $1`,
    [collegeId]
  );
  return rows;
}

export async function getCompletedCountsForStudents(studentIds) {
  if (!studentIds || !studentIds.length) return {};
  const { rows } = await q(
    'SELECT student_id, COUNT(*)::int AS c FROM practice_completions WHERE student_id = ANY($1) GROUP BY student_id',
    [studentIds]
  );
  const m = {};
  for (const r of rows) m[r.student_id] = r.c;
  return m;
}
export async function getCompletedCountsByProblem(collegeId) {
  const { rows } = await q(
    `SELECT pc.problem_id AS pid, COUNT(*)::int AS c
     FROM practice_completions pc JOIN practice_problems pp ON pp.id = pc.problem_id
     WHERE pp.college_id = $1 GROUP BY pc.problem_id`,
    [collegeId]
  );
  const m = {};
  for (const r of rows) m[r.pid] = r.c;
  return m;
}

export async function getCompletionsForStudent(studentId) {
  const { rows } = await q(
    `SELECT problem_id, ${TS('completed_at', 'completed_at')}
     FROM practice_completions WHERE student_id=$1`,
    [studentId]
  );
  return rows;
}
