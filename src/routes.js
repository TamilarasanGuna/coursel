import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { store } from './store.js';
import { parseUsername, parseProblemSlug, fetchProfileStats } from './leetcode.js';
import { runSync, runSyncStudent, getSyncState } from './sync.js';
import { ingestResults } from './ingest.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
export const router = express.Router();

// ---- Admin authentication ---------------------------------------------------
// Single shared password (config.adminPassword). Login returns a token kept in
// memory; admin requests must send it as the x-admin-token header.
const adminTokens = new Set();

// Endpoints that stay open regardless of admin auth (student + shared-link + auth itself).
function isPublicReq(req) {
  const p = req.path, m = req.method;
  if (m === 'OPTIONS') return true;
  if (p === '/admin/login' || p === '/admin/status') return true;
  if (m === 'GET' && p === '/colleges') return true;                       // student login dropdown
  if (m === 'GET' && /^\/colleges\/\d+\/options$/.test(p)) return true;    // student register dropdowns
  if (m === 'POST' && (p === '/student/login' || p === '/student/register')) return true;
  if (m === 'GET' && /^\/student\/\d+\/dashboard$/.test(p)) return true;
  if (m === 'GET' && /^\/view\/[^/]+(\/student\/\d+)?$/.test(p)) return true; // shared read-only link
  return false;
}

router.use((req, res, next) => {
  if (!config.adminPassword) return next(); // auth disabled
  if (isPublicReq(req)) return next();
  const token = req.get('x-admin-token');
  if (token && adminTokens.has(token)) return next();
  return res.status(401).json({ error: 'Admin login required.' });
});

router.get('/admin/status', (req, res) => res.json({ authRequired: !!config.adminPassword }));

router.post('/admin/login', (req, res) => {
  if (!config.adminPassword) return res.json({ ok: true, authRequired: false, token: '' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (username === config.adminUsername && password === config.adminPassword) {
    const token = randomUUID();
    adminTokens.add(token);
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ error: 'Incorrect admin username or password.' });
});

// Wrap async handlers so a rejected promise becomes a 500 instead of a hung request.
const h = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[route]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

const titleize = (slug) =>
  slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Email is used for login only — never send it to the browser (admin or shared link).
const omitEmail = (s) => { const { email, ...rest } = s; return rest; };

// Find a value in a row object by trying several header aliases (case-insensitive).
function pick(row, aliases) {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const k = keys.find((kk) => kk.trim().toLowerCase() === alias.toLowerCase());
    if (k && row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

// ---- Colleges ---------------------------------------------------------------

router.get('/colleges', h(async (req, res) => {
  res.json(await store.listColleges());
}));

// Admin: create a college and (optionally) set its student access code in one go.
router.post('/colleges', h(async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'College name is required.' });
  const c = await store.getOrCreateCollege(name);
  const code = req.body?.code;
  if (code != null && String(code).trim() !== '') await store.setAccessCode(c.id, code);
  const fresh = await store.getCollege(c.id);
  res.json({ id: fresh.id, name: fresh.name, has_code: !!fresh.access_code });
}));

// Admin: read basic college info (whether a student code is set).
router.get('/colleges/:id', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  res.json({ id: c.id, name: c.name, has_code: !!c.access_code });
}));

// Admin: delete a college and everything under it.
router.delete('/colleges/:id', h(async (req, res) => {
  await store.deleteCollege(Number(req.params.id));
  res.json({ ok: true });
}));

// Admin: set/clear the student access code for a college.
router.post('/colleges/:id/access-code', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  await store.setAccessCode(c.id, req.body?.code || '');
  res.json({ ok: true, has_code: !!(req.body?.code || '').trim() });
}));

// Admin: create (or rotate) a read-only share link for a college.
router.post('/colleges/:id/view-link', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  const token = await store.ensureViewToken(c.id, !!req.body?.regenerate);
  res.json({ token, path: `/view/${token}` });
}));

// Public read-only dashboard for ONE college, resolved by share token.
// Mirrors the admin dashboard: filters, pagination, per-student progress.
router.get('/view/:token', h(async (req, res) => {
  const c = await store.getCollegeByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid or expired link.' });

  const f = {
    batch: (req.query.batch || '').trim(),
    department: (req.query.department || '').trim(),
    campus: (req.query.campus || '').trim(),
    q: (req.query.q || '').trim(),
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(500, Math.max(1, Number(req.query.pageSize) || 100)),
  };

  const problems = await store.listPracticeProblems(c.id);
  const { rows, total, offset } = await store.getStudentsPage(c.id, f);
  const completions = await store.getCompletionsForCollege(c.id);

  const compByStudent = new Map();
  const compByProblem = new Map();
  for (const x of completions) {
    if (!compByStudent.has(x.student_id)) compByStudent.set(x.student_id, new Set());
    compByStudent.get(x.student_id).add(x.problem_id);
    compByProblem.set(x.problem_id, (compByProblem.get(x.problem_id) || 0) + 1);
  }

  const collegeStudentCount = (await store.getCollegeTotals(c.id, {})).students;

  res.json({
    college: { name: c.name },
    totals: await store.getCollegeTotals(c.id, f),
    monthly: await store.getCollegeMonthly(c.id, f),
    filters: await store.getFilterOptions(c.id),
    page: f.page,
    pageSize: f.pageSize,
    total,
    practiceTotal: problems.length,
    students: rows.map((s, i) => ({
      ...omitEmail(s),
      classRank: offset + i + 1,
      practiceCompleted: compByStudent.get(s.id)?.size || 0,
      practiceTotal: problems.length,
    })),
    studentCount: collegeStudentCount,
    practice: problems.map((p) => ({
      title: p.title,
      url: p.url,
      difficulty: p.difficulty,
      topic: p.topic || null,
      completedCount: compByProblem.get(p.id) || 0,
    })),
  });
}));

// Read-only individual student detail, scoped to the share token's college.
router.get('/view/:token/student/:studentId', h(async (req, res) => {
  const c = await store.getCollegeByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid or expired link.' });
  const s = await store.getStudent(Number(req.params.studentId));
  if (!s || s.college_id !== c.id) return res.status(404).json({ error: 'Student not found.' });

  const completions = await store.getCompletionsForStudent(s.id);
  const compIds = new Set(completions.map((x) => x.problem_id));
  const problems = await store.getPracticeProblemsByCollege(s.college_id);
  res.json({
    student: omitEmail(s),
    monthlyActivity: await store.getMonthlyActivity(s.id),
    monthlySolvedGrowth: await store.getMonthlySolvedGrowth(s.id),
    practice: problems.map((p) => ({
      ...p,
      completed: compIds.has(p.id),
      completed_at: completions.find((x) => x.problem_id === p.id)?.completed_at || null,
    })),
  });
}));

// Existing batches / departments / campuses for a college — used to populate
// the student self-register dropdowns. Non-sensitive metadata, no code needed.
router.get('/colleges/:id/options', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  res.json(await store.getFilterOptions(c.id));
}));

// ---- Student side (gated by college access code) ----------------------------

// Student logs in with college + access code + their registered email.
router.post('/student/login', h(async (req, res) => {
  const collegeId = Number(req.body?.collegeId);
  const code = req.body?.code;
  const email = (req.body?.email || '').trim();
  const college = await store.getCollege(collegeId);
  if (!college) return res.status(404).json({ error: 'College not found.' });
  if (!college.access_code)
    return res.status(403).json({ error: 'No access code set for this college yet. Ask your admin.' });
  if (!(await store.checkAccessCode(collegeId, code)))
    return res.status(401).json({ error: 'Incorrect access code.' });
  if (!email) return res.status(400).json({ error: 'Enter your email.' });
  const student = await store.getStudentByEmail(collegeId, email);
  if (!student)
    return res.status(404).json({ error: 'No student found with that email in this college. Check it, or add yourself below.' });
  res.json({
    ok: true,
    college: { id: college.id, name: college.name },
    student: { id: student.id, name: student.name, username: student.username },
  });
}));

// Self-register: if a student isn't on the roster, they add themselves
// (gated by the same college access code). Deduplicated by LeetCode username.
router.post('/student/register', h(async (req, res) => {
  const collegeId = Number(req.body?.collegeId);
  const college = await store.getCollege(collegeId);
  if (!college) return res.status(404).json({ error: 'College not found.' });
  if (!(await store.checkAccessCode(collegeId, req.body?.code)))
    return res.status(401).json({ error: 'Incorrect access code.' });

  const name = (req.body?.name || '').trim();
  const profile = (req.body?.profile || '').trim();
  const email = (req.body?.email || '').trim();
  const section = (req.body?.section || '').trim() || null;
  const department = (req.body?.department || '').trim() || null;
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Enter a valid email.' });
  const username = parseUsername(profile);
  if (!username)
    return res.status(400).json({ error: 'Enter a valid LeetCode profile link or username.' });

  // Duplicate checks — tell them which field already exists.
  if (await store.getStudentByEmail(collegeId, email))
    return res.status(409).json({ error: 'You are already a user — this email is already registered. Please log in instead.' });
  if (await store.getStudentByUsername(collegeId, username))
    return res.status(409).json({ error: 'You are already a user — this LeetCode profile is already registered. Please log in instead.' });

  // Validate the LeetCode profile actually exists (public profile).
  let stats = null;
  try { stats = await fetchProfileStats(username); } catch { stats = null; }
  if (!stats || !stats.found)
    return res.status(400).json({ error: 'Enter a valid LeetCode profile — we couldn’t find that user on LeetCode.' });

  const profileUrl = profile.includes('leetcode.com') ? profile : `https://leetcode.com/u/${username}/`;
  const id = await store.upsertStudent({ college_id: collegeId, name, username, profile_url: profileUrl, email, section, department });
  try { await store.saveStudentStats(id, stats); } catch { /* already validated */ }
  try { await runSyncStudent(id); } catch { /* practice matching is best-effort */ }

  res.json({ ok: true, student: { id, name, username } });
}));

// Step 2: student views ONLY their own data (stats, progress, practice).
router.get('/student/:studentId/dashboard', h(async (req, res) => {
  const student = await store.getStudent(Number(req.params.studentId));
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (!(await store.checkAccessCode(student.college_id, req.query.code)))
    return res.status(401).json({ error: 'Incorrect or missing access code.' });

  const classSize = (await store.getCollegeTotals(student.college_id, {})).students;
  const classRank = await store.getRankInCollege(student.college_id, student.solved_total);

  const completions = await store.getCompletionsForStudent(student.id);
  const compIds = new Set(completions.map((c) => c.problem_id));
  const problems = await store.getPracticeProblemsByCollege(student.college_id);

  res.json({
    me: {
      id: student.id,
      name: student.name,
      username: student.username,
      profile_url: student.profile_url,
      ranking: student.ranking,
      contest_rating: student.contest_rating,
      easy: student.solved_easy,
      medium: student.solved_medium,
      hard: student.solved_hard,
      total: student.solved_total,
      classRank,
      classSize,
      found: !!student.found,
      last_synced_at: student.last_synced_at,
      // academic details (the student's own info)
      register_number: student.register_number,
      section: student.section,
      department: student.department,
      campus: student.campus,
      year: student.year,
      // baseline for the "progress since first tracked" view
      baseline_ranking: student.baseline_ranking,
      baseline_easy: student.baseline_easy,
      baseline_medium: student.baseline_medium,
      baseline_hard: student.baseline_hard,
      baseline_total: student.baseline_total,
      baseline_at: student.baseline_at,
    },
    monthlyActivity: await store.getMonthlyActivity(student.id),
    monthlySolvedGrowth: await store.getMonthlySolvedGrowth(student.id),
    practice: problems.map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      difficulty: p.difficulty,
      topic: p.topic || null,
      completed: compIds.has(p.id),
      completed_at: completions.find((c) => c.problem_id === p.id)?.completed_at || null,
    })),
  });
}));

// ---- Student roster upload --------------------------------------------------

router.post('/upload', upload.single('file'), h(async (req, res) => {
  const collegeName = (req.body.college || '').trim();
  if (!collegeName) return res.status(400).json({ error: 'College name is required.' });
  if (!req.file) return res.status(400).json({ error: 'No Excel file uploaded.' });

  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) return res.status(400).json({ error: 'The sheet appears to be empty.' });

  const college = await store.getOrCreateCollege(collegeName);
  const result = { added: 0, skipped: [], total: rows.length };

  for (const [i, row] of rows.entries()) {
    const name = pick(row, ['name', 'student name', 'student', 'full name']);
    const profile = pick(row, [
      'leetcode profile', 'leetcode', 'profile', 'profile url', 'leetcode url',
      'leetcode id', 'username', 'url', 'link',
    ]);
    const username = parseUsername(profile);
    if (!name || !username) {
      result.skipped.push({ row: i + 2, reason: 'missing name or LeetCode profile' });
      continue;
    }
    const profileUrl = profile.includes('leetcode.com')
      ? profile
      : `https://leetcode.com/u/${username}/`;
    await store.upsertStudent({
      college_id: college.id,
      name,
      username,
      profile_url: profileUrl,
      register_number: pick(row, ['register number', 'registration number', 'reg number', 'register no', 'roll number', 'roll no', 'regno']),
      email: pick(row, ['email id', 'email', 'mail', 'e-mail']),
      department: pick(row, ['department', 'dept', 'branch']),
      section: pick(row, ['section', 'batch', 'batch no', 'batch number']),
      year: pick(row, ['year', 'passing year', 'graduation year', 'batch year', 'passout year']),
      campus: pick(row, ['campus name', 'campus', 'location', 'centre', 'center']),
    });
    result.added++;
  }

  res.json({ college, ...result });
}));

// ---- Dashboard --------------------------------------------------------------

router.get('/colleges/:id/dashboard', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const f = {
    batch: (req.query.batch || '').trim(),
    department: (req.query.department || '').trim(),
    campus: (req.query.campus || '').trim(),
    q: (req.query.q || '').trim(),
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(500, Math.max(1, Number(req.query.pageSize) || 100)),
  };

  const problems = await store.listPracticeProblems(collegeId);
  const { rows, total, offset } = await store.getStudentsPage(collegeId, f);

  // completion counts (one query for the whole college)
  const completions = await store.getCompletionsForCollege(collegeId);
  const compByStudent = new Map();
  for (const c of completions) {
    if (!compByStudent.has(c.student_id)) compByStudent.set(c.student_id, new Set());
    compByStudent.get(c.student_id).add(c.problem_id);
  }

  const students = rows.map((s, i) => ({
    ...omitEmail(s),
    classRank: offset + i + 1,
    practiceCompleted: compByStudent.get(s.id)?.size || 0,
    practiceTotal: problems.length,
  }));

  res.json({
    students,
    practiceTotal: problems.length,
    totals: await store.getCollegeTotals(collegeId, f),     // reflects current filters
    monthly: await store.getCollegeMonthly(collegeId, f),   // single aggregated query
    filters: await store.getFilterOptions(collegeId),       // distinct batches/depts/campuses
    page: f.page,
    pageSize: f.pageSize,
    total,
  });
}));

// ---- Student detail ---------------------------------------------------------

router.get('/students/:id', h(async (req, res) => {
  const s = await store.getStudent(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'student not found' });
  const completions = await store.getCompletionsForStudent(s.id);
  const problems = await store.getPracticeProblemsByCollege(s.college_id);
  const compIds = new Set(completions.map((c) => c.problem_id));
  res.json({
    student: omitEmail(s),
    monthlyActivity: await store.getMonthlyActivity(s.id),
    monthlySolvedGrowth: await store.getMonthlySolvedGrowth(s.id),
    practice: problems.map((p) => ({
      ...p,
      completed: compIds.has(p.id),
      completed_at: completions.find((c) => c.problem_id === p.id)?.completed_at || null,
    })),
  });
}));

router.delete('/students/:id', h(async (req, res) => {
  await store.deleteStudent(Number(req.params.id));
  res.json({ ok: true });
}));

router.post('/students/:id/sync', h(async (req, res) => {
  const r = await runSyncStudent(Number(req.params.id));
  res.json(r);
}));

// Reset a student's progress baseline to their current stats.
router.post('/students/:id/reset-baseline', h(async (req, res) => {
  await store.resetBaseline(Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Practice tab -----------------------------------------------------------

router.get('/colleges/:id/practice', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const problems = await store.listPracticeProblems(collegeId);
  const students = await store.listStudents(collegeId);
  const completions = await store.getCompletionsForCollege(collegeId);

  const compByProblem = new Map();
  for (const c of completions) {
    if (!compByProblem.has(c.problem_id)) compByProblem.set(c.problem_id, []);
    compByProblem.get(c.problem_id).push(c.student_id);
  }

  res.json({
    studentCount: students.length,
    topics: await store.listTopics(collegeId),
    problems: problems.map((p) => ({
      ...p,
      completedCount: compByProblem.get(p.id)?.length || 0,
    })),
    students: students.map((s) => ({ id: s.id, name: s.name, username: s.username })),
    completions,
  });
}));

// Add practice problems. Accepts either:
//   - JSON body { links: "url1\nurl2..." }  (textarea paste), or
//   - a multipart Excel file with Title/URL/Difficulty columns.
router.post('/colleges/:id/practice', upload.single('file'), h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const formTopic = (req.body.topic || '').trim() || null;      // applies to all when set
  const formDifficulty = (req.body.difficulty || '').trim() || null;
  const items = [];

  if (req.file) {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    for (const row of rows) {
      const url = pick(row, ['url', 'link', 'leetcode link', 'problem', 'problem url', 'question', 'question link']);
      if (!url) continue;
      items.push({
        url,
        title: pick(row, ['title', 'name', 'problem name', 'question']),
        difficulty: pick(row, ['difficulty', 'level']) || formDifficulty, // row value wins
        topic: pick(row, ['topic', 'category', 'tag']) || formTopic,
      });
    }
  } else {
    const links = (req.body.links || '').split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
    for (const url of links) items.push({ url, topic: formTopic, difficulty: formDifficulty });
  }

  if (!items.length) return res.status(400).json({ error: 'No problem links found.' });

  const added = [];
  const skipped = [];
  for (const it of items) {
    const slug = parseProblemSlug(it.url);
    if (!slug) { skipped.push(it.url); continue; }
    const url = it.url.includes('leetcode.com') ? it.url : `https://leetcode.com/problems/${slug}/`;
    const id = await store.addPracticeProblem({
      college_id: collegeId,
      title: it.title || titleize(slug),
      slug,
      url,
      difficulty: it.difficulty || null,
      topic: it.topic || null,
    });
    added.push({ id, slug });
  }
  res.json({ added: added.length, skipped });
}));

router.delete('/practice/:id', h(async (req, res) => {
  await store.deletePracticeProblem(Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Sync controls ----------------------------------------------------------

router.post('/colleges/:id/sync', (req, res) => {
  runSync({ collegeId: Number(req.params.id) }).catch((e) => console.error('sync error', e.message));
  res.json({ started: true });
});

router.post('/sync', (req, res) => {
  runSync().catch((e) => console.error('sync error', e.message));
  res.json({ started: true });
});

router.get('/sync/state', (req, res) => res.json(getSyncState()));

// ---- Chrome-extension integration ------------------------------------------

router.get('/colleges/:id/scrape-config', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const students = await store.listStudents(collegeId);
  const problems = await store.listPracticeProblems(collegeId);
  res.json({
    collegeId,
    profiles: students.map((s) => s.profile_url || s.username),
    usernames: students.map((s) => s.username),
    questions: problems.map((p) => ({ slug: p.slug, title: p.title, url: p.url })),
  });
}));

// The extension POSTs scraped results here. `college` may be an id or a name.
router.post('/ingest', h(async (req, res) => {
  const { college, results } = req.body || {};
  if (!Array.isArray(results)) return res.status(400).json({ error: 'results[] required' });
  let collegeId = Number(college);
  if (!collegeId || Number.isNaN(collegeId)) {
    if (!college) return res.status(400).json({ error: 'college (id or name) required' });
    collegeId = (await store.getOrCreateCollege(String(college))).id;
  }
  const summary = await ingestResults(collegeId, results);
  res.json({ ok: true, collegeId, ...summary });
}));

// Import the CSV the extension exports (fallback when not pushing live).
router.post('/import-csv', upload.single('file'), h(async (req, res) => {
  const collegeName = (req.body.college || '').trim();
  if (!collegeName) return res.status(400).json({ error: 'College name is required.' });
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });

  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  if (!rows.length) return res.status(400).json({ error: 'The file appears to be empty.' });

  const KNOWN = new Set([
    'username', 'profile url', 'rank', 'easy questions', 'medium questions',
    'hard questions', 'error/comment', 'easy', 'medium', 'hard', 'total',
  ]);
  const results = rows.map((row) => {
    const get = (alias) => pick(row, [alias]);
    const questions = {};
    for (const [k, v] of Object.entries(row)) {
      if (!KNOWN.has(k.trim().toLowerCase())) questions[k] = v;
    }
    return {
      username: get('username') || get('profile url'),
      profileUrl: get('profile url'),
      rank: get('rank'),
      easy: get('easy questions') || get('easy'),
      medium: get('medium questions') || get('medium'),
      hard: get('hard questions') || get('hard'),
      total: get('total'),
      comment: get('error/comment'),
      questions,
    };
  });

  const collegeId = (await store.getOrCreateCollege(collegeName)).id;
  const summary = await ingestResults(collegeId, results);
  res.json({ ok: true, collegeId, ...summary });
}));

// ---- Excel template download ------------------------------------------------

router.get('/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Student Name', 'Register Number', 'Email ID', 'Department', 'Section', 'Year', 'Campus name', 'LeetCode URL'],
    ['Asha Rao', '2023002199', 'arao@gitam.in', 'CSE', 'Batch-16', '2027', 'Vizag', 'https://leetcode.com/u/asharao/'],
    ['Vivek Kumar', '2023008288', 'vkumar@gitam.in', 'CSE', 'Batch-11', '2027', 'Vizag', 'vivekk'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="student_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Practice-problems upload template.
router.get('/practice-template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['URL', 'Topic', 'Difficulty', 'Title'],
    ['https://leetcode.com/problems/two-sum/', 'Arrays', 'Easy', 'Two Sum'],
    ['https://leetcode.com/problems/add-two-numbers/', 'Linked List', 'Medium', ''],
    ['trapping-rain-water', 'Two Pointers', 'Hard', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Problems');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="practice_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
