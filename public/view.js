const $ = (s) => document.querySelector(s);
const token = decodeURIComponent(location.pathname.split('/view/')[1] || '').replace(/\/+$/, '');

let chart = null, drawerChart = null, lastMonthlySig = null, filtersLoaded = false;
const dash = { batch: '', department: '', campus: '', q: '', page: 1, pageSize: 100, total: 0 };

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
window.__onTheme = () => { lcChartTheme(); recolorChart(chart); recolorChart(drawerChart); };

const api = (path) => fetch('/api' + path).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
});
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// progress helpers (same logic as admin)
function gain(cur, base) {
  if (base == null || cur == null) return '';
  const d = cur - base;
  if (d > 0) return ` <span class="delta">+${d}</span>`;
  if (d < 0) return ` <span class="delta down">${d}</span>`;
  return '';
}
function rankDelta(s) {
  if (s.baseline_ranking == null || s.ranking == null) return '';
  const d = s.baseline_ranking - s.ranking;
  if (d > 0) return ` <span class="delta">▲${Math.abs(d).toLocaleString()}</span>`;
  if (d < 0) return ` <span class="delta down">▼${Math.abs(d).toLocaleString()}</span>`;
  return '';
}

async function load(opts = {}) {
  let d;
  try {
    const qs = new URLSearchParams({
      batch: dash.batch, department: dash.department, campus: dash.campus, q: dash.q,
      page: String(dash.page), pageSize: String(dash.pageSize),
    });
    d = await api(`/view/${encodeURIComponent(token)}?${qs}`);
  } catch (e) {
    $('#content').style.display = 'none';
    const err = $('#error');
    err.style.display = 'block';
    err.innerHTML = `<h2 style="margin:0 0 6px">Link not available</h2><p class="hint" style="margin:0">${esc(e.message)}</p>`;
    return;
  }
  render(d, opts);
}

function render(d, opts) {
  document.title = `${d.college.name} — Progress`;
  $('#collegeName').textContent = d.college.name;
  $('#error').style.display = 'none';
  $('#content').style.display = 'block';
  dash.total = d.total;

  const filtered = dash.batch || dash.department || dash.campus || dash.q;
  $('#cards').innerHTML = `
    <div class="card"><div class="v">${d.totals.students}</div><div class="l">${filtered ? 'Students (filtered)' : 'Students'}</div></div>
    <div class="card"><div class="v">${d.totals.total}</div><div class="l">Total solved</div></div>
    <div class="card easy"><div class="v">${d.totals.easy}</div><div class="l">Easy</div></div>
    <div class="card medium"><div class="v">${d.totals.medium}</div><div class="l">Medium</div></div>
    <div class="card hard"><div class="v">${d.totals.hard}</div><div class="l">Hard</div></div>
    <div class="card"><div class="v">${d.practiceTotal}</div><div class="l">Practice problems</div></div>`;

  const sig = JSON.stringify(d.monthly);
  if (opts.chart !== false && sig !== lastMonthlySig) {
    if (chart) chart.destroy();
    chart = new Chart($('#monthly'), {
      type: 'bar',
      data: { labels: d.monthly.map((m) => m.ym), datasets: [{ data: d.monthly.map((m) => m.submissions), backgroundColor: '#ffa116' }] },
      options: { plugins: { legend: { display: false } }, scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true } } },
    });
    lastMonthlySig = sig;
  }

  if (!filtersLoaded) { populateFilters(d.filters); filtersLoaded = true; }
  renderStudents(d.students);
  renderPager();
  renderPractice(d);
}

function fillSel(sel, allLabel, opts, cur) {
  const el = $(sel);
  el.innerHTML = `<option value="">${allLabel}</option>` + opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  el.value = opts.includes(cur) ? cur : '';
}
function populateFilters(f) {
  if (!f.campuses.includes(dash.campus)) dash.campus = '';
  if (!f.departments.includes(dash.department)) dash.department = '';
  if (!f.batches.includes(dash.batch)) dash.batch = '';
  fillSel('#filterCampus', 'All campuses', f.campuses, dash.campus);
  fillSel('#filterDept', 'All departments', f.departments, dash.department);
  fillSel('#filterBatch', 'All batches', f.batches, dash.batch);
}
function renderPager() {
  const { page, pageSize, total } = dash;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#pageInfo').textContent = `${total === 0 ? 0 : (page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`;
  $('#prevPage').disabled = page <= 1;
  $('#nextPage').disabled = page >= pages;
}

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
  const tbody = $('#studentTable').querySelector('tbody');
  if (!students.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No students match.</td></tr>';
    return;
  }
  tbody.innerHTML = students.map((s) => `
    <tr data-id="${s.id}" style="cursor:pointer">
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
    </tr>`).join('');
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openStudent(tr.dataset.id)));
}

function renderPractice(d) {
  const tbody = $('#practiceTable').querySelector('tbody');
  if (!d.practice.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No practice problems assigned.</td></tr>';
    return;
  }
  const groups = {};
  for (const p of d.practice) { const t = (p.topic && p.topic.trim()) || 'Uncategorized'; (groups[t] ||= []).push(p); }
  const names = Object.keys(groups).sort((a, b) => a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b));
  const row = (p) => {
    const pct = d.studentCount ? Math.round((p.completedCount / d.studentCount) * 100) : 0;
    return `<tr>
      <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></td>
      <td>${p.difficulty ? `<span class="pill ${(p.difficulty || '').toLowerCase()}">${esc(p.difficulty)}</span>` : '—'}</td>
      <td>${p.completedCount}/${d.studentCount}</td>
      <td><span class="progress"><span style="width:${pct}%"></span></span> ${pct}%</td></tr>`;
  };
  tbody.innerHTML = names.map((t) =>
    `<tr><td colspan="4" style="background:var(--panel-2);font-weight:600">${esc(t)} <span style="color:var(--muted);font-weight:400">· ${groups[t].length}</span></td></tr>`
    + groups[t].map(row).join('')
  ).join('');
}

// ---- read-only student drawer ----------------------------------------------
async function openStudent(id) {
  let d;
  try { d = await api(`/view/${encodeURIComponent(token)}/student/${id}`); }
  catch (e) { return; }
  const s = d.student;
  const growth = d.monthlySolvedGrowth;
  $('#drawerContent').innerHTML = `
    <h2 style="margin-top:0">${esc(s.name)}</h2>
    <p class="hint"><a href="${esc(s.profile_url || '#')}" target="_blank">@${esc(s.username)}</a>
      ${s.found ? '' : '· <span class="cross">profile not found / private</span>'}</p>
    ${(s.register_number || s.section || s.department || s.campus || s.year) ? `<p class="hint" style="line-height:1.7">
      ${s.register_number ? `Reg: <b>${esc(s.register_number)}</b> · ` : ''}${s.section ? `Batch: <b>${esc(s.section)}</b> · ` : ''}${s.department ? `${esc(s.department)} · ` : ''}${s.campus ? esc(s.campus) : ''}${s.year ? ` · ${esc(s.year)}` : ''}</p>` : ''}
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
      <tbody>${growth.map((g) => `<tr><td>${g.ym}</td><td>${g.easy}</td><td>${g.medium}</td><td>${g.hard}</td><td><b>${g.total}</b></td></tr>`).join('')}</tbody></table>` : ''}
    <h2 style="margin-top:18px">Practice problems</h2>
    <table><thead><tr><th>Problem</th><th>Status</th></tr></thead><tbody>
      ${d.practice.length ? d.practice.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a></td>
        <td>${p.completed ? '<span class="check">✓ solved</span>' : '<span class="cross">pending</span>'}</td></tr>`).join('')
        : '<tr><td colspan="2" class="empty">No problems assigned.</td></tr>'}
    </tbody></table>`;

  $('#drawer').classList.add('open');
  $('#drawerBackdrop').classList.add('show');
  const m = d.monthlyActivity;
  if (drawerChart) drawerChart.destroy();
  drawerChart = new Chart($('#drawerMonthly'), {
    type: 'line',
    data: { labels: m.map((x) => x.ym), datasets: [{ data: m.map((x) => x.submissions), borderColor: '#ffa116', backgroundColor: 'rgba(255,161,22,.15)', fill: true, tension: .3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}
function progressBlock(s) {
  if (s.baseline_at == null) return '';
  const r = (label, base, cur, isRank) => {
    let delta = '—';
    if (base != null && cur != null) delta = (isRank ? rankDelta({ baseline_ranking: base, ranking: cur }) : gain(cur, base)) || '—';
    const fmt = (v) => v == null ? '—' : (isRank ? '#' + Number(v).toLocaleString() : v);
    return `<tr><td>${label}</td><td>${fmt(base)}</td><td>${fmt(cur)}</td><td>${delta}</td></tr>`;
  };
  return `<h2 style="margin-top:18px">Progress since first tracked <span class="hint">(${esc(String(s.baseline_at).slice(0, 10))})</span></h2>
    <table><thead><tr><th>Metric</th><th>Started</th><th>Now</th><th>Change</th></tr></thead><tbody>
      ${r('Global rank', s.baseline_ranking, s.ranking, true)}
      ${r('Easy', s.baseline_easy, s.solved_easy)}
      ${r('Medium', s.baseline_medium, s.solved_medium)}
      ${r('Hard', s.baseline_hard, s.solved_hard)}
      ${r('Total', s.baseline_total, s.solved_total)}
    </tbody></table>`;
}
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('show'); }
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);

// ---- filters / pager / search ----------------------------------------------
$('#filterBatch').addEventListener('change', (e) => { dash.batch = e.target.value; dash.page = 1; load(); });
$('#filterDept').addEventListener('change', (e) => { dash.department = e.target.value; dash.page = 1; load(); });
$('#filterCampus').addEventListener('change', (e) => { dash.campus = e.target.value; dash.page = 1; load(); });
$('#prevPage').addEventListener('click', () => { if (dash.page > 1) { dash.page--; load(); } });
$('#nextPage').addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(dash.total / dash.pageSize));
  if (dash.page < pages) { dash.page++; load(); }
});
let searchTimer = null;
$('#studentSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim();
  searchTimer = setTimeout(() => { dash.q = v; dash.page = 1; load(); }, 350);
});

load();
setInterval(() => {
  if (document.hidden) return;
  if ($('#drawer').classList.contains('open')) return; // don't disrupt an open drawer
  load({ chart: false });
}, 5000);
