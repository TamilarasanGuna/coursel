const $ = (sel) => document.querySelector(sel);
const adminToken = () => { try { return localStorage.getItem('lc_admin_token') || ''; } catch { return ''; } };
const api = (path, opts = {}) => {
  const t = adminToken();
  const headers = Object.assign({}, opts.headers || {}, t ? { 'x-admin-token': t } : {});
  return fetch('/api' + path, { ...opts, headers }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && /admin/i.test(data.error || '')) { showAdminLogin(); throw new Error(data.error); }
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  });
};

let state = {
  collegeId: null, students: [], monthlyChart: null, practiceCollegeId: null,
  practiceDomain: '__all', // selected domain tab in the Practice section
  // dashboard pagination + filters
  dash: { batch: '', department: '', campus: '', q: '', page: 1, pageSize: 100, total: 0 },
  filtersFor: null, // college id the filter dropdowns were populated for
};

// Charts read tick/grid colors from the active theme's CSS variables.
function lcChartColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    tick: cs.getPropertyValue('--muted').trim() || '#8b92a5',
    grid: cs.getPropertyValue('--border').trim() || 'rgba(128,134,149,.2)',
  };
}
function lcChartTheme() {
  if (!window.Chart) return;
  const { tick, grid } = lcChartColors();
  Chart.defaults.color = tick;
  Chart.defaults.borderColor = grid;
}
// Re-apply colors to an already-built chart (Chart.js bakes defaults at creation).
function recolorChart(c) {
  if (!c || !c.options || !c.options.scales) return;
  const { tick, grid } = lcChartColors();
  for (const ax of Object.values(c.options.scales)) {
    ax.ticks = Object.assign(ax.ticks || {}, { color: tick });
    if (!ax.grid || ax.grid.display !== false) ax.grid = Object.assign(ax.grid || {}, { color: grid });
  }
  c.update('none');
}
lcChartTheme();
window.__onTheme = () => { lcChartTheme(); recolorChart(state.monthlyChart); };

// ---- Tabs -------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'practice') populatePracticeColleges().then(loadPractice);
    if (t.dataset.tab === 'colleges') loadCollegesTab();
  });
});

// ---- Colleges tab -----------------------------------------------------------
async function loadCollegesTab() {
  $('#studentLink').textContent = location.origin + '/student';
  $('#studentLink').href = '/student';
  const colleges = await api('/colleges');
  const tbody = $('#collegeTable').querySelector('tbody');
  if (!colleges.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No colleges yet. Add one above.</td></tr>';
    return;
  }
  tbody.innerHTML = colleges.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${c.student_count}</td>
      <td>${c.has_code ? '<span class="check">✓ set</span>' : '<span class="cross">none — can’t log in</span>'}</td>
      <td>
        <input class="search code-input" data-id="${c.id}" style="width:150px" placeholder="${c.has_code ? 'type to replace' : 'set a code'}" />
        <button class="btn btn-sm btn-primary set-code" data-id="${c.id}">Save</button>
      </td>
      <td>
        <button class="btn btn-sm btn-ghost gen-link" data-id="${c.id}">Get link</button>
        <span class="link-out" data-id="${c.id}"></span>
      </td>
      <td><button class="btn btn-sm btn-danger del-college" data-id="${c.id}" data-name="${esc(c.name)}" data-count="${c.student_count}">Delete</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('.del-college').forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.name, n = b.dataset.count;
    if (!confirm(`Delete "${name}" and ALL of its ${n} student(s), practice problems, and progress?\n\nThis cannot be undone.`)) return;
    try {
      await api(`/colleges/${b.dataset.id}`, { method: 'DELETE' });
      if (state.collegeId == b.dataset.id) state.collegeId = null;
      if (state.practiceCollegeId == b.dataset.id) state.practiceCollegeId = null;
      loadCollegesTab();
      loadColleges();
    } catch (e) { alert(e.message); }
  }));
  tbody.querySelectorAll('.gen-link').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/colleges/${b.dataset.id}/view-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const url = location.origin + r.path;
      const out = tbody.querySelector(`.link-out[data-id="${b.dataset.id}"]`);
      out.innerHTML = `<input class="search" readonly value="${url}" style="width:230px;margin-left:6px" onclick="this.select()" />
        <button class="btn btn-sm copy-link">Copy</button>
        <button class="btn btn-sm btn-ghost regen-link" data-id="${b.dataset.id}" title="Make a new link and invalidate the old one">↻</button>`;
      out.querySelector('.copy-link').addEventListener('click', () => {
        navigator.clipboard?.writeText(url); out.querySelector('.copy-link').textContent = 'Copied';
      });
      out.querySelector('.regen-link').addEventListener('click', async (e) => {
        if (!confirm('Generate a new link? The current one will stop working.')) return;
        const rr = await api(`/colleges/${b.dataset.id}/view-link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: true }),
        });
        out.querySelector('input').value = location.origin + rr.path;
        out.querySelector('.copy-link').textContent = 'Copy';
      });
    } catch (e) { alert(e.message); }
  }));
  tbody.querySelectorAll('.set-code').forEach((b) => b.addEventListener('click', async () => {
    const inp = tbody.querySelector(`.code-input[data-id="${b.dataset.id}"]`);
    const code = inp.value.trim();
    if (!code) return alert('Enter a code to set.');
    try {
      await api(`/colleges/${b.dataset.id}/access-code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      loadCollegesTab();
    } catch (e) { alert(e.message); }
  }));
}

$('#addCollegeBtn').addEventListener('click', async () => {
  const name = $('#newCollegeName').value.trim();
  const code = $('#newCollegeCode').value.trim();
  if (!name) return setMsg('#addCollegeMsg', 'Enter a college name.', 'err');
  if (!code) return setMsg('#addCollegeMsg', 'Set an access code so students can log in.', 'err');
  try {
    const r = await api('/colleges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }),
    });
    setMsg('#addCollegeMsg', `Added "${r.name}" with an access code. Now upload its roster in the Upload tab.`, 'ok');
    $('#newCollegeName').value = '';
    $('#newCollegeCode').value = '';
    loadCollegesTab();
    loadColleges();
  } catch (e) { setMsg('#addCollegeMsg', e.message, 'err'); }
});

// ---- College picker ---------------------------------------------------------
async function loadColleges() {
  const colleges = await api('/colleges');

  // Keep the Upload tab's college dropdown in sync with existing colleges.
  const up = $('#uploadCollege');
  const prevUp = up.value;
  up.innerHTML = colleges.length
    ? colleges.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')
    : '<option value="">No colleges yet — add one in the Colleges tab</option>';
  if (colleges.some((c) => c.name === prevUp)) up.value = prevUp;

  const sel = $('#collegeSelect');
  sel.innerHTML = '';
  if (!colleges.length) {
    sel.innerHTML = '<option value="">No colleges yet — upload a roster</option>';
    renderEmptyDashboard();
    return;
  }
  for (const c of colleges) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name} (${c.student_count})`;
    sel.appendChild(o);
  }
  const prevCollege = state.collegeId;
  state.collegeId = state.collegeId && colleges.some((c) => c.id == state.collegeId)
    ? state.collegeId : colleges[0].id;
  if (state.collegeId !== prevCollege) resetDash(); // switched/auto-picked a different college
  sel.value = state.collegeId;
  loadDashboard();
  loadAccessCode();
}
$('#collegeSelect').addEventListener('change', (e) => {
  state.collegeId = Number(e.target.value);
  resetDash();
  loadDashboard();
  loadAccessCode();
});

async function loadAccessCode() {
  if (!state.collegeId) return;
  try {
    const c = await api(`/colleges/${state.collegeId}`);
    $('#accessCode').value = '';
    $('#accessCode').placeholder = c.has_code ? '•••••• (set — type to replace)' : 'e.g. ABC-2026';
    setMsg('#accessMsg', c.has_code ? 'Code is set.' : 'No code yet — students can’t log in.', c.has_code ? 'ok' : '');
  } catch {}
}
$('#saveCodeBtn').addEventListener('click', async () => {
  if (!state.collegeId) return;
  const code = $('#accessCode').value.trim();
  try {
    const r = await api(`/colleges/${state.collegeId}/access-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    setMsg('#accessMsg', r.has_code ? 'Saved.' : 'Cleared — students can’t log in.', r.has_code ? 'ok' : 'err');
    $('#accessCode').value = '';
    $('#accessCode').placeholder = r.has_code ? '•••••• (set — type to replace)' : 'e.g. ABC-2026';
  } catch (e) { setMsg('#accessMsg', e.message, 'err'); }
});

// ---- Dashboard --------------------------------------------------------------
function renderEmptyDashboard() {
  $('#summaryCards').innerHTML = '';
  $('#studentTable').querySelector('tbody').innerHTML =
    '<tr><td colspan="8" class="empty">No data yet. Go to the Upload tab to add a student roster.</td></tr>';
  if ($('#pageInfo')) $('#pageInfo').textContent = '';
}

let dashAbort = null;
async function loadDashboard(opts = {}) {
  if (!state.collegeId) return renderEmptyDashboard();
  const dq = state.dash;
  const params = {
    batch: dq.batch, department: dq.department, campus: dq.campus, q: dq.q,
    page: String(dq.page), pageSize: String(dq.pageSize),
  };
  if (opts.chart === false) params.light = '1'; // auto-refresh: skip monthly/filter queries
  const qs = new URLSearchParams(params);
  dashAbort?.abort();
  const ctrl = new AbortController();
  dashAbort = ctrl;
  let d;
  try {
    d = await api(`/colleges/${state.collegeId}/dashboard?${qs}`, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError' || /abort/i.test(e.message || '')) return; // superseded by a newer load
    throw e;
  }
  state.students = d.students;
  state.dash.total = d.total;

  const label = (dq.batch || dq.department || dq.campus || dq.q) ? 'Students (filtered)' : 'Students';
  $('#summaryCards').innerHTML = `
    <div class="card"><div class="v">${d.totals.students}</div><div class="l">${label}</div></div>
    <div class="card"><div class="v">${d.totals.total}</div><div class="l">Total solved</div></div>
    <div class="card easy"><div class="v">${d.totals.easy}</div><div class="l">Easy</div></div>
    <div class="card medium"><div class="v">${d.totals.medium}</div><div class="l">Medium</div></div>
    <div class="card hard"><div class="v">${d.totals.hard}</div><div class="l">Hard</div></div>
    <div class="card"><div class="v">${d.practiceTotal}</div><div class="l">Practice problems</div></div>`;

  if (opts.chart !== false) renderMonthlyChart(d.monthly); // skip on fast auto-refresh to avoid flicker
  if (state.filtersFor !== state.collegeId && d.filters) { populateFilters(d.filters); state.filtersFor = state.collegeId; }
  renderStudents(d.students);
  renderPager();
}

function resetDash() {
  state.dash = { batch: '', department: '', campus: '', q: '', page: 1, pageSize: 100, total: 0 };
  state.filtersFor = null;
  const ss = $('#studentSearch'); if (ss) ss.value = '';
}

function fillSel(sel, allLabel, opts, cur) {
  const el = $(sel);
  el.innerHTML = `<option value="">${allLabel}</option>` + opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  el.value = opts.includes(cur) ? cur : '';
}
function populateFilters(f) {
  // drop any active filter that no longer exists for this college
  if (!f.campuses.includes(state.dash.campus)) state.dash.campus = '';
  if (!f.departments.includes(state.dash.department)) state.dash.department = '';
  if (!f.batches.includes(state.dash.batch)) state.dash.batch = '';
  fillSel('#filterCampus', 'All campuses', f.campuses, state.dash.campus);
  fillSel('#filterDept', 'All departments', f.departments, state.dash.department);
  fillSel('#filterBatch', 'All batches', f.batches, state.dash.batch);
}
function renderPager() {
  const { page, pageSize, total } = state.dash;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  $('#pageInfo').textContent = `${from}–${to} of ${total}`;
  $('#prevPage').disabled = page <= 1;
  $('#nextPage').disabled = page >= pages;
}

$('#filterBatch').addEventListener('change', (e) => { state.dash.batch = e.target.value; state.dash.page = 1; loadDashboard(); });
$('#filterDept').addEventListener('change', (e) => { state.dash.department = e.target.value; state.dash.page = 1; loadDashboard(); });
$('#filterCampus').addEventListener('change', (e) => { state.dash.campus = e.target.value; state.dash.page = 1; loadDashboard(); });
$('#prevPage').addEventListener('click', () => { if (state.dash.page > 1) { state.dash.page--; loadDashboard(); } });
$('#nextPage').addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(state.dash.total / state.dash.pageSize));
  if (state.dash.page < pages) { state.dash.page++; loadDashboard(); }
});

function avInitial(name) { return (name || '?').trim().charAt(0).toUpperCase(); }
function avColor(name) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 58%, 50%)`;
}
function rankCell(r) {
  if (r === 1) return '<span class="medal">🥇</span>';
  if (r === 2) return '<span class="medal">🥈</span>';
  if (r === 3) return '<span class="medal">🥉</span>';
  return `<span class="rank-num">${r}</span>`;
}
function difficultyCell(s) {
  const e = s.solved_easy || 0, m = s.solved_medium || 0, h = s.solved_hard || 0, sum = e + m + h || 1;
  return `<div class="dbar">
      <span style="width:${(e / sum) * 100}%;background:var(--easy)"></span>
      <span style="width:${(m / sum) * 100}%;background:var(--medium)"></span>
      <span style="width:${(h / sum) * 100}%;background:var(--hard)"></span>
    </div>
    <div class="dcounts"><span style="color:var(--easy)">${e}</span> · <span style="color:var(--medium)">${m}</span> · <span style="color:var(--hard)">${h}</span></div>`;
}
function practiceCell(s) {
  const tot = s.practiceTotal || 0, done = s.practiceCompleted || 0;
  const pct = tot ? Math.round((done / tot) * 100) : 0;
  return `<div class="pp"><span class="bar"><span style="width:${pct}%"></span></span><span class="hint">${done}/${tot}</span></div>`;
}

function renderStudents(students) {
  const rows = students; // filtering/search now handled server-side
  const tbody = $('#studentTable').querySelector('tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No students match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((s) => `
    <tr data-id="${s.id}">
      <td>${rankCell(s.classRank)}</td>
      <td>
        <div class="s-cell">
          <div class="s-av" style="background:${avColor(s.name)}">${esc(avInitial(s.name))}</div>
          <div>
            <div class="s-name">${esc(s.name)}</div>
            <div class="s-user">@${esc(s.username)}</div>
            ${(s.section || s.department) ? `<div class="s-tags">${s.section ? `<span class="tag">${esc(s.section)}</span>` : ''}${s.department ? `<span class="tag">${esc(s.department)}</span>` : ''}</div>` : ''}
          </div>
        </div>
      </td>
      <td>${s.found ? (s.ranking ? '#' + s.ranking.toLocaleString() : '—') : '<span class="cross">private</span>'}${rankDelta(s)}</td>
      <td>${difficultyCell(s)}</td>
      <td><span class="tot">${s.solved_total}</span>${gain(s.solved_total, s.baseline_total)}</td>
      <td>${practiceCell(s)}</td>
      <td><span class="dot ${s.sync_status}"></span>${fmtAgo(s.last_synced_at)}</td>
      <td><button class="btn btn-sm btn-ghost sync-one" data-id="${s.id}">⟳</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.sync-one')) return;
      openStudent(tr.dataset.id);
    });
  });
  tbody.querySelectorAll('.sync-one').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.textContent = '…';
      try { await api(`/students/${b.dataset.id}/sync`, { method: 'POST' }); }
      catch (err) { alert(err.message); }
      loadDashboard();
    });
  });
}
let searchTimer = null;
$('#studentSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim();
  searchTimer = setTimeout(() => { state.dash.q = v; state.dash.page = 1; loadDashboard(); }, 350);
});

function renderMonthlyChart(monthly) {
  const ctx = $('#monthlyChart');
  if (state.monthlyChart) state.monthlyChart.destroy();
  state.monthlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: monthly.map((m) => m.ym),
      datasets: [{ label: 'Submissions', data: monthly.map((m) => m.submissions), backgroundColor: '#ffa116' }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true },
      },
    },
  });
}

// ---- Student drawer ---------------------------------------------------------
async function openStudent(id) {
  const d = await api(`/students/${id}`);
  const s = d.student;
  const growth = d.monthlySolvedGrowth;
  $('#drawerContent').innerHTML = `
    <h2 style="margin-top:0">${esc(s.name)}</h2>
    <p class="hint"><a href="${esc(s.profile_url || '#')}" target="_blank">@${esc(s.username)}</a>
      ${s.found ? '' : '· <span class="cross">profile not found / private</span>'}</p>
    ${(s.register_number || s.department || s.section || s.campus || s.year) ? `<p class="hint" style="line-height:1.7">
      ${s.register_number ? `Reg: <b>${esc(s.register_number)}</b> · ` : ''}${s.section ? `Batch: <b>${esc(s.section)}</b> · ` : ''}${s.department ? `${esc(s.department)} · ` : ''}${s.campus ? `${esc(s.campus)}` : ''}${s.year ? ` · ${esc(s.year)}` : ''}</p>` : ''}
    <div class="kv">
      <div><div class="l">Global rank</div><div class="v">${s.ranking ? '#' + s.ranking.toLocaleString() : '—'}</div></div>
      <div><div class="l">Total solved</div><div class="v">${s.solved_total}</div></div>
      <div><div class="l">Easy</div><div class="v" style="color:var(--easy)">${s.solved_easy}</div></div>
      <div><div class="l">Medium</div><div class="v" style="color:var(--medium)">${s.solved_medium}</div></div>
      <div><div class="l">Hard</div><div class="v" style="color:var(--hard)">${s.solved_hard}</div></div>
      <div><div class="l">Contest rating</div><div class="v">${s.contest_rating || '—'}</div></div>
    </div>
    ${progressBlock(s)}
    <h2>Monthly submissions</h2>
    <canvas id="drawerMonthly" height="120"></canvas>
    ${growth.length ? `<h2 style="margin-top:18px">Problems solved per month</h2>
      <table><thead><tr><th>Month</th><th>Easy</th><th>Med</th><th>Hard</th><th>Total</th></tr></thead>
      <tbody>${growth.map((g) => `<tr><td>${g.ym}</td><td>${g.easy}</td><td>${g.medium}</td><td>${g.hard}</td><td><b>${g.total}</b></td></tr>`).join('')}</tbody></table>
      <p class="hint">Computed from snapshot diffs — accumulates as the app keeps running.</p>` : ''}
    <h2 style="margin-top:18px">Practice problems</h2>
    <table><thead><tr><th>Problem</th><th>Status</th></tr></thead><tbody>
      ${d.practice.length ? d.practice.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a></td>
        <td>${p.completed ? '<span class="check">✓ solved</span>' : '<span class="cross">pending</span>'}</td></tr>`).join('')
        : '<tr><td colspan="2" class="empty">No problems assigned.</td></tr>'}
    </tbody></table>
    <div style="margin-top:24px; border-top:1px solid var(--border); padding-top:16px">
      <button class="btn btn-sm btn-danger del-student" data-id="${s.id}" data-name="${esc(s.name)}">Delete this student</button>
    </div>`;

  openDrawer();
  const m = d.monthlyActivity;
  new Chart($('#drawerMonthly'), {
    type: 'line',
    data: { labels: m.map((x) => x.ym), datasets: [{ data: m.map((x) => x.submissions), borderColor: '#ffa116', backgroundColor: 'rgba(255,161,22,.15)', fill: true, tension: .3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });

  const ds = $('#drawerContent').querySelector('.del-student');
  if (ds) ds.addEventListener('click', async () => {
    if (!confirm(`Delete "${ds.dataset.name}" and all their data (stats, progress, completions)? This cannot be undone.`)) return;
    try {
      await api(`/students/${ds.dataset.id}`, { method: 'DELETE' });
      closeDrawer();
      loadDashboard();
    } catch (e) { alert(e.message); }
  });

  const rb = $('#drawerContent').querySelector('.reset-baseline');
  if (rb) rb.addEventListener('click', async () => {
    if (!confirm('Reset this student’s baseline to their current stats? Progress will restart from now.')) return;
    try {
      await api(`/students/${rb.dataset.id}/reset-baseline`, { method: 'POST' });
      openStudent(rb.dataset.id); // re-render drawer with the new baseline
      loadDashboard();
    } catch (e) { alert(e.message); }
  });
}
function openDrawer() { $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('show'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('show'); }
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);

// ---- Practice tab -----------------------------------------------------------
// The Practice tab has its own college selector (state.practiceCollegeId),
// independent of the dashboard's top-bar selection.
const practiceCid = () => state.practiceCollegeId || state.collegeId;

async function populatePracticeColleges() {
  const colleges = await api('/colleges');
  const sel = $('#practiceCollege');
  const cur = practiceCid();
  sel.innerHTML = colleges.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (colleges.some((c) => c.id == cur)) sel.value = cur;
  state.practiceCollegeId = Number(sel.value) || null;
}
$('#practiceCollege').addEventListener('change', (e) => {
  state.practiceCollegeId = Number(e.target.value);
  loadPractice();
});

const domName = (p) => (p.domain && p.domain.trim()) || 'Uncategorized';
const topName = (p) => (p.topic && p.topic.trim()) || 'Uncategorized';
const sortGroups = (a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b));

async function loadPractice() {
  const cid = practiceCid();
  if (!cid) return;
  const d = await api(`/colleges/${cid}/practice`);

  // picker options
  $('#topicList').innerHTML = (d.topics || []).map((t) => `<option value="${esc(t)}">`).join('');
  $('#domainList').innerHTML = (d.domains || []).map((t) => `<option value="${esc(t)}">`).join('');

  const tbody = $('#practiceTable').querySelector('tbody');
  if (!d.problems.length) {
    $('#domainTabs').innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No practice problems assigned yet.</td></tr>';
    return;
  }

  // domain tabs: All + each domain present
  const domainSet = [...new Set(d.problems.map(domName))].sort(sortGroups);
  if (state.practiceDomain && state.practiceDomain !== '__all' && !domainSet.includes(state.practiceDomain)) {
    state.practiceDomain = '__all';
  }
  const sel = state.practiceDomain || '__all';
  $('#domainTabs').innerHTML =
    `<button class="dom-tab ${sel === '__all' ? 'active' : ''}" data-dom="__all">All domains</button>` +
    domainSet.map((dn) => `<button class="dom-tab ${sel === dn ? 'active' : ''}" data-dom="${esc(dn)}">${esc(dn)}</button>`).join('');
  $('#domainTabs').querySelectorAll('.dom-tab').forEach((b) => b.addEventListener('click', () => {
    state.practiceDomain = b.dataset.dom;
    loadPractice();
  }));

  const rowHtml = (p) => {
    const pct = d.studentCount ? Math.round((p.completedCount / d.studentCount) * 100) : 0;
    return `<tr>
      <td><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a></td>
      <td>${p.difficulty ? `<span class="pill ${(p.difficulty || '').toLowerCase()}">${esc(p.difficulty)}</span>` : '—'}</td>
      <td>${p.completedCount}/${d.studentCount}</td>
      <td><span class="progress"><span style="width:${pct}%"></span></span> ${pct}%</td>
      <td><button class="btn btn-sm btn-danger del-prob" data-id="${p.id}">Delete</button></td>
    </tr>`;
  };
  // topic sub-group within a set of problems
  const byTopic = (probs) => {
    const groups = {};
    for (const p of probs) (groups[topName(p)] ||= []).push(p);
    return Object.keys(groups).sort(sortGroups).map((t) =>
      `<tr><td colspan="5" style="background:var(--panel-2);font-weight:600;padding-left:18px">${esc(t)} <span style="color:var(--muted);font-weight:400">· ${groups[t].length}</span></td></tr>`
      + groups[t].map(rowHtml).join('')).join('');
  };

  let html = '';
  if (sel === '__all') {
    // group by domain (header), then topic
    const domGroups = {};
    for (const p of d.problems) (domGroups[domName(p)] ||= []).push(p);
    html = domainSet.map((dn) =>
      `<tr><td colspan="5" style="background:var(--accent);color:#1a1300;font-weight:700">${esc(dn)} <span style="font-weight:400">· ${domGroups[dn].length}</span></td></tr>`
      + byTopic(domGroups[dn])).join('');
  } else {
    html = byTopic(d.problems.filter((p) => domName(p) === sel));
  }
  tbody.innerHTML = html;

  tbody.querySelectorAll('.del-prob').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this practice problem?')) return;
    await api(`/practice/${b.dataset.id}`, { method: 'DELETE' });
    loadPractice();
  }));
}

// Add a single question (own link + topic + difficulty).
$('#addSingleBtn').addEventListener('click', async () => {
  const link = $('#singleLink').value.trim();
  const domain = $('#singleDomain').value.trim();
  const topic = $('#singleTopic').value.trim();
  const difficulty = $('#singleDifficulty').value;
  if (!practiceCid()) return setMsg('#singleMsg', 'Pick a college first.', 'err');
  if (!link) return setMsg('#singleMsg', 'Enter a LeetCode link or slug.', 'err');
  try {
    const r = await api(`/colleges/${practiceCid()}/practice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: link, topic, domain, difficulty }),
    });
    if (r.added) {
      setMsg('#singleMsg', `Added.`, 'ok');
      $('#singleLink').value = ''; // keep topic + difficulty for the next one
    } else {
      setMsg('#singleMsg', 'That link could not be parsed.', 'err');
    }
    loadPractice();
  } catch (e) { setMsg('#singleMsg', e.message, 'err'); }
});

$('#addPracticeBtn').addEventListener('click', async () => {
  const links = $('#practiceLinks').value.trim();
  const domain = $('#practiceDomain').value.trim();
  const topic = $('#practiceTopic').value.trim();
  const difficulty = $('#practiceDifficulty').value;
  if (!practiceCid()) return setMsg('#practiceMsg', 'Pick a college first.', 'err');
  if (!links) return setMsg('#practiceMsg', 'Paste at least one link.', 'err');
  try {
    const r = await api(`/colleges/${practiceCid()}/practice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links, topic, domain, difficulty }),
    });
    setMsg('#practiceMsg', `Added ${r.added} problem(s)${topic ? ' under “' + topic + '”' : ''}.` + (r.skipped.length ? ` Skipped ${r.skipped.length}.` : ''), 'ok');
    $('#practiceLinks').value = '';
    loadPractice();
  } catch (e) { setMsg('#practiceMsg', e.message, 'err'); }
});

$('#practiceFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !practiceCid()) return;
  const fd = new FormData();
  fd.append('file', file);
  const topic = $('#practiceTopic').value.trim();
  const domain = $('#practiceDomain').value.trim();
  const difficulty = $('#practiceDifficulty').value;
  if (topic) fd.append('topic', topic); // fallbacks for rows missing these columns
  if (domain) fd.append('domain', domain);
  if (difficulty) fd.append('difficulty', difficulty);
  try {
    const r = await api(`/colleges/${practiceCid()}/practice`, { method: 'POST', body: fd });
    setMsg('#practiceMsg', `Added ${r.added} problem(s) from file.`, 'ok');
    loadPractice();
  } catch (err) { setMsg('#practiceMsg', err.message, 'err'); }
  e.target.value = '';
});

// ---- Upload tab -------------------------------------------------------------
$('#uploadBtn').addEventListener('click', async () => {
  const college = $('#uploadCollege').value.trim();
  const file = $('#rosterFile').files[0];
  if (!college) return setMsg('#uploadResult', 'Enter a college name.', 'err');
  if (!file) return setMsg('#uploadResult', 'Choose an Excel file.', 'err');
  const fd = new FormData(); fd.append('college', college); fd.append('file', file);
  setMsg('#uploadResult', 'Uploading…', '');
  try {
    const r = await api('/upload', { method: 'POST', body: fd });
    let msg = `Added/updated ${r.added} of ${r.total} students for "${r.college.name}".`;
    if (r.skipped.length) msg += `\nSkipped ${r.skipped.length} row(s): ` + r.skipped.map((s) => `row ${s.row} (${s.reason})`).join(', ');
    msg += `\nStarting LeetCode sync in the background…`;
    setMsg('#uploadResult', msg, 'ok');
    state.collegeId = r.college.id;
    resetDash();
    await api(`/colleges/${r.college.id}/sync`, { method: 'POST' });
    pollSync();
    await loadColleges();
  } catch (e) { setMsg('#uploadResult', e.message, 'err'); }
});

// ---- Sync button + polling --------------------------------------------------
$('#syncCollegeBtn').addEventListener('click', async () => {
  if (!state.collegeId) return;
  await api(`/colleges/${state.collegeId}/sync`, { method: 'POST' });
  pollSync();
});

let pollTimer = null;
function pollSync() {
  clearInterval(pollTimer);
  $('#syncStatus').textContent = 'syncing…';
  pollTimer = setInterval(async () => {
    const st = await api('/sync/state');
    if (st.running) {
      $('#syncStatus').textContent = 'syncing…';
    } else {
      clearInterval(pollTimer);
      $('#syncStatus').textContent = st.lastRun
        ? `synced ${st.lastRun.ok}/${st.lastRun.students}` + (st.lastRun.newCompletions ? `, +${st.lastRun.newCompletions} completions` : '')
        : '';
      loadColleges();
      if ($('#tab-practice').classList.contains('active')) loadPractice();
    }
  }, 2500);
}

// ---- helpers ----------------------------------------------------------------
function setMsg(sel, text, cls) { const el = $(sel); el.textContent = text; el.className = 'msg ' + (cls || ''); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Progress since first tracked. `gain` for solved counts (up is good),
// `rankDelta` for global rank (a smaller number is better).
function gain(current, baseline) {
  if (baseline == null || current == null) return '';
  const d = current - baseline;
  if (d > 0) return ` <span class="delta" title="since first tracked">+${d}</span>`;
  if (d < 0) return ` <span class="delta down">${d}</span>`;
  return '';
}
function rankDelta(s) {
  if (s.baseline_ranking == null || s.ranking == null) return '';
  const d = s.baseline_ranking - s.ranking; // positive => rank improved
  if (d > 0) return ` <span class="delta" title="rank improved since first tracked">▲${Math.abs(d).toLocaleString()}</span>`;
  if (d < 0) return ` <span class="delta down" title="rank dropped">▼${Math.abs(d).toLocaleString()}</span>`;
  return '';
}

// "Started at … → now" comparison shown in the student drawer.
function progressBlock(s) {
  if (s.baseline_at == null) return '';
  const row = (label, base, cur, isRank) => {
    let delta = '';
    if (base != null && cur != null) {
      if (isRank) delta = rankDelta({ baseline_ranking: base, ranking: cur });
      else delta = gain(cur, base);
    }
    const fmt = (v) => v == null ? '—' : (isRank ? '#' + Number(v).toLocaleString() : v);
    return `<tr><td>${label}</td><td>${fmt(base)}</td><td>${fmt(cur)}</td><td>${delta || '—'}</td></tr>`;
  };
  return `<h2 style="margin-top:18px">Progress since first tracked <span class="hint">(${fmtAgo(s.baseline_at)})</span>
      <button class="btn btn-sm btn-ghost reset-baseline" data-id="${s.id}" title="Re-anchor progress to current stats" style="float:right">Reset baseline</button></h2>
    <table><thead><tr><th>Metric</th><th>Started</th><th>Now</th><th>Change</th></tr></thead><tbody>
      ${row('Global rank', s.baseline_ranking, s.ranking, true)}
      ${row('Easy', s.baseline_easy, s.solved_easy)}
      ${row('Medium', s.baseline_medium, s.solved_medium)}
      ${row('Hard', s.baseline_hard, s.solved_hard)}
      ${row('Total', s.baseline_total, s.solved_total)}
    </tbody></table>`;
}
function fmtAgo(iso) {
  if (!iso) return 'never';
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ---- Admin login gate -------------------------------------------------------
function showAdminLogin() {
  try { localStorage.removeItem('lc_admin_token'); } catch {}
  $('#adminLogin').classList.add('show');
  $('#adminLogout').style.display = 'none';
  setTimeout(() => $('#adminUser').focus(), 50);
}
async function adminLogin() {
  const username = $('#adminUser').value.trim();
  const password = $('#adminPass').value;
  if (!username || !password) return setMsg('#adminLoginMsg', 'Enter your username and password.', 'err');
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Login failed');
    if (d.token) { try { localStorage.setItem('lc_admin_token', d.token); } catch {} }
    $('#adminLogin').classList.remove('show');
    $('#adminPass').value = '';
    $('#adminUser').value = '';
    $('#adminLogout').style.display = 'inline-block';
    loadColleges();
  } catch (e) { setMsg('#adminLoginMsg', e.message, 'err'); }
}
$('#adminLoginBtn').addEventListener('click', adminLogin);
$('#adminUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });
$('#adminPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });
$('#adminLogout').addEventListener('click', () => { showAdminLogin(); });

(async function boot() {
  let authRequired = false;
  try { authRequired = (await fetch('/api/admin/status').then((r) => r.json())).authRequired; } catch {}
  if (authRequired && !adminToken()) { showAdminLogin(); return; }
  if (authRequired) $('#adminLogout').style.display = 'inline-block';
  loadColleges();
})();

// Auto-refresh the admin view every 2s so scheduler/extension updates show up
// without a manual reload. This only re-reads the database (no LeetCode calls).
setInterval(() => {
  if (document.hidden) return;                              // tab not visible
  if ($('#adminLogin').classList.contains('show')) return;  // not logged in
  if ($('#drawer').classList.contains('open')) return;      // don't disrupt an open student drawer
  const active = document.querySelector('.tab.active')?.dataset.tab;
  if (active === 'dashboard') loadDashboard({ chart: false });
  else if (active === 'practice') loadPractice();
}, 2000);
