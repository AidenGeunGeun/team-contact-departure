const state = {
  jobs: [],
  selectedJobId: null,
  selectedArtifact: null,
  detail: null,
  pollHandle: null,
};

const elements = {
  health: document.querySelector("#health"),
  refreshTime: document.querySelector("#refresh-time"),
  refreshNow: document.querySelector("#refresh-now"),
  jobCount: document.querySelector("#job-count"),
  jobList: document.querySelector("#job-list"),
  emptyDetail: document.querySelector("#empty-detail"),
  detail: document.querySelector("#detail"),
  detailKind: document.querySelector("#detail-kind"),
  detailTitle: document.querySelector("#detail-title"),
  detailSummary: document.querySelector("#detail-summary"),
  detailState: document.querySelector("#detail-state"),
  detailRunner: document.querySelector("#detail-runner"),
  progressLabel: document.querySelector("#progress-label"),
  progressFill: document.querySelector("#progress-fill"),
  phaseLabel: document.querySelector("#phase-label"),
  verdictLabel: document.querySelector("#verdict-label"),
  verdictKindLabel: document.querySelector("#verdict-kind-label"),
  caveatPanel: document.querySelector("#caveat-panel"),
  staticPanel: document.querySelector("#static-panel"),
  staticMeta: document.querySelector("#static-meta"),
  eventsList: document.querySelector("#events-list"),
  artifactCount: document.querySelector("#artifact-count"),
  artifactList: document.querySelector("#artifact-list"),
  artifactPreview: document.querySelector("#artifact-preview"),
};

elements.refreshNow.addEventListener("click", () => refreshAll({ keepArtifact: true }));

function text(value, fallback = "pending") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value);
}

function titleize(value) {
  return text(value).replaceAll("_", " ").replaceAll("-", " ");
}

function terminal(job) {
  return ["succeeded", "failed", "cancelled"].includes(job?.state);
}

function formatTime(value) {
  if (!value) {
    return "unknown time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortHash(value) {
  if (!value) {
    return undefined;
  }
  return value.length > 14 ? value.slice(0, 12) : value;
}

function sizeLabel(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `${url} returned ${response.status}`);
  }
  return payload;
}

function setHealth(ok, message) {
  elements.health.textContent = message;
  elements.health.className = `health ${ok ? "health--ok" : "health--error"}`;
}

function statePillClass(stateName) {
  return `status-pill state-${stateName || "unknown"}`;
}

function runnerLabel(runnerKind) {
  if (runnerKind === "fake-smoke") {
    return "fake smoke evidence";
  }
  if (runnerKind === "static-source-evidence") {
    return "static PX4 source evidence";
  }
  return text(runnerKind, "unknown runner");
}

function runnerClass(runnerKind) {
  if (runnerKind === "fake-smoke") {
    return "runner-pill fake";
  }
  if (runnerKind === "static-source-evidence") {
    return "runner-pill static";
  }
  return "runner-pill";
}

function renderJobs() {
  const jobs = state.jobs;
  elements.jobCount.textContent = jobs.length === 0 ? "No run folders found" : `${jobs.length} run folder${jobs.length === 1 ? "" : "s"}`;
  elements.jobList.replaceChildren();

  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-card";
    empty.innerHTML = "<h2>No jobs yet</h2><p>Run <code>npm run smoke:offline</code> or ask the agent to launch a job, then refresh this page.</p>";
    elements.jobList.append(empty);
    return;
  }

  for (const job of jobs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `job-card${job.job_id === state.selectedJobId ? " is-selected" : ""}`;
    button.addEventListener("click", () => selectJob(job.job_id));

    const title = text(job.case_title || job.case_id, job.job_id);
    const commit = shortHash(job.resolved_commit_hash || job.target_commit) || "no commit yet";
    button.innerHTML = `
      <div class="job-card__top">
        <span class="${statePillClass(job.state)}">${titleize(job.state)}</span>
        <span class="artifact-type">${job.artifact_count} files</span>
      </div>
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text(job.test_card_title || job.test_card_id, "No test card"))}</p>
      </div>
      <div class="job-card__meta">
        <span>${escapeHtml(runnerLabel(job.runner_kind))}</span>
        <span>${escapeHtml(commit)}</span>
      </div>
      <div class="job-card__meta">
        <span>${escapeHtml(text(job.verdict, "verdict pending"))}</span>
        <span>${escapeHtml(formatTime(job.updated_at))}</span>
      </div>
    `;
    elements.jobList.append(button);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function selectJob(jobId) {
  state.selectedJobId = jobId;
  state.selectedArtifact = null;
  renderJobs();
  await loadDetail({ keepArtifact: false });
}

async function loadDetail({ keepArtifact }) {
  if (!state.selectedJobId) {
    elements.emptyDetail.classList.remove("hidden");
    elements.detail.classList.add("hidden");
    return;
  }

  const detail = await fetchJson(`/api/jobs/${encodeURIComponent(state.selectedJobId)}`);
  state.detail = detail;
  elements.emptyDetail.classList.add("hidden");
  elements.detail.classList.remove("hidden");
  renderDetail(detail);

  const artifactStillPresent = detail.artifacts.some((artifact) => artifact.name === state.selectedArtifact);
  if (!keepArtifact || !artifactStillPresent) {
    state.selectedArtifact = detail.artifacts[0]?.name ?? null;
  }
  renderArtifacts(detail);
  if (state.selectedArtifact) {
    await loadArtifact(state.selectedArtifact);
  } else {
    elements.artifactPreview.innerHTML = '<p class="preview-empty">No artifacts are available yet.</p>';
  }
}

function renderDetail(detail) {
  const caseTitle = text(detail.resolved_case?.title || detail.case_title || detail.case_id, detail.job_id);
  elements.detailKind.textContent = detail.job_id;
  elements.detailTitle.textContent = caseTitle;
  elements.detailSummary.textContent = text(detail.result?.summary || detail.status?.message, "Waiting for the runner to write a result.");
  elements.detailState.className = statePillClass(detail.state);
  elements.detailState.textContent = titleize(detail.state);
  elements.detailRunner.className = runnerClass(detail.runner_kind);
  elements.detailRunner.textContent = runnerLabel(detail.runner_kind);
  elements.progressLabel.textContent = `${detail.progress}%`;
  elements.progressFill.style.width = `${detail.progress}%`;
  elements.phaseLabel.textContent = text(detail.phase);
  elements.verdictLabel.textContent = titleize(detail.result?.verdict || detail.verdict || "pending");
  elements.verdictKindLabel.textContent = titleize(detail.result?.static_source?.verdict_kind || detail.verdict_kind || "pending");

  renderCaveats(detail);
  renderStaticMetadata(detail.result?.static_source);
  renderEvents(detail.recent_events || []);
}

function renderCaveats(detail) {
  const caveats = [];
  if (detail.runner_kind === "fake-smoke") {
    caveats.push("Fake/smoke evidence only. This job does not prove real PX4 runtime behavior.");
  }
  if (detail.runner_kind === "static-source-evidence") {
    caveats.push("Static-source evidence only. No SITL, fuzzing, or MAVLink replay was performed by this viewer.");
  }
  for (const caution of detail.result?.cautions || []) {
    if (!caveats.includes(caution)) {
      caveats.push(caution);
    }
  }
  for (const error of detail.errors || []) {
    caveats.push(`${error.file}: ${error.message}`);
  }

  if (caveats.length === 0) {
    elements.caveatPanel.classList.add("hidden");
    elements.caveatPanel.replaceChildren();
    return;
  }
  elements.caveatPanel.classList.remove("hidden");
  elements.caveatPanel.innerHTML = `<strong>Read before interpreting</strong><ul>${caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderStaticMetadata(staticSource) {
  if (!staticSource) {
    elements.staticPanel.classList.add("hidden");
    elements.staticMeta.replaceChildren();
    return;
  }
  elements.staticPanel.classList.remove("hidden");
  const lineRange = staticSource.source_region
    ? `${staticSource.source_region.start_line}-${staticSource.source_region.end_line}`
    : "not resolved";
  const diffPair = staticSource.diff_pre_hash && staticSource.diff_post_hash
    ? `${shortHash(staticSource.diff_pre_hash)}..${shortHash(staticSource.diff_post_hash)}`
    : "not available";
  const rows = [
    ["Resolved commit", staticSource.resolved_commit_hash],
    ["Target alias", staticSource.target_commit],
    ["File", staticSource.target_file],
    ["Function", staticSource.target_function],
    ["Line range", lineRange],
    ["Role", staticSource.role || "not labeled"],
    ["Diff pair", diffPair],
    ["PR URL", staticSource.pr_url, "link"],
  ];
  elements.staticMeta.innerHTML = rows
    .map(([label, value, kind]) => {
      const display = text(value, "not available");
      const body = kind === "link" && display.startsWith("http")
        ? `<a href="${escapeHtml(display)}" target="_blank" rel="noreferrer">${escapeHtml(display)}</a>`
        : escapeHtml(display);
      return `<div><dt>${escapeHtml(label)}</dt><dd>${body}</dd></div>`;
    })
    .join("");
}

function renderEvents(events) {
  elements.eventsList.replaceChildren();
  if (events.length === 0) {
    const item = document.createElement("li");
    item.innerHTML = "<strong>No events yet</strong><p>The runner has not written progress events.</p>";
    elements.eventsList.append(item);
    return;
  }
  for (const event of events.slice().reverse()) {
    const item = document.createElement("li");
    item.innerHTML = `
      <time>${escapeHtml(formatTime(event.timestamp))}</time>
      <strong>${escapeHtml(titleize(event.phase))} · ${escapeHtml(String(event.progress))}%</strong>
      <p>${escapeHtml(event.message)}</p>
    `;
    elements.eventsList.append(item);
  }
}

function renderArtifacts(detail) {
  const artifacts = detail.artifacts || [];
  elements.artifactCount.textContent = `${artifacts.length} file${artifacts.length === 1 ? "" : "s"}`;
  elements.artifactList.replaceChildren();
  if (artifacts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "No artifacts have been written yet.";
    elements.artifactList.append(empty);
    return;
  }
  for (const artifact of artifacts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `artifact-button${artifact.name === state.selectedArtifact ? " is-selected" : ""}`;
    button.textContent = `${artifact.name} · ${sizeLabel(artifact.size)}`;
    button.addEventListener("click", () => {
      state.selectedArtifact = artifact.name;
      renderArtifacts(detail);
      void loadArtifact(artifact.name);
    });
    elements.artifactList.append(button);
  }
}

async function loadArtifact(artifactName) {
  if (!state.selectedJobId) {
    return;
  }
  elements.artifactPreview.innerHTML = '<p class="preview-empty">Loading artifact...</p>';
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/artifacts/${encodeURIComponent(artifactName)}`, { cache: "no-store" });
    const content = await response.text();
    if (!response.ok) {
      throw new Error(content || `Artifact returned ${response.status}`);
    }
    renderPreview({ name: artifactName, type: response.headers.get("x-artifact-type") || artifactTypeFromName(artifactName) }, content);
  } catch (error) {
    elements.artifactPreview.innerHTML = `<p class="preview-error">${escapeHtml(error.message)}</p>`;
  }
}

function artifactTypeFromName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".patch") || lower.endsWith(".diff")) {
    return "diff";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "markdown";
  }
  if (lower.endsWith(".csv")) {
    return "csv";
  }
  return "text";
}

function renderPreview(artifact, content) {
  if (artifact.type === "json") {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      content = `${content}\n\n(JSON parse failed; showing raw text.)`;
    }
  }
  if (artifact.type === "diff") {
    const lines = content.split("\n").map((line) => {
      let className = "diff-line";
      if (line.startsWith("@@")) {
        className += " hunk";
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        className += " add";
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        className += " remove";
      }
      return `<span class="${className}">${escapeHtml(line) || " "}</span>`;
    });
    elements.artifactPreview.innerHTML = `<pre class="preview-pre">${lines.join("")}</pre>`;
    return;
  }
  elements.artifactPreview.innerHTML = `<pre class="preview-pre">${escapeHtml(content)}</pre>`;
}

async function refreshAll({ keepArtifact }) {
  try {
    const [health, jobsPayload] = await Promise.all([
      fetchJson("/api/health"),
      fetchJson("/api/jobs"),
    ]);
    setHealth(health.runs_available, health.runs_available ? "Runs directory available" : "Runs directory missing");
    state.jobs = jobsPayload.jobs;

    if (!state.selectedJobId && state.jobs.length > 0) {
      state.selectedJobId = state.jobs[0].job_id;
    }
    if (state.selectedJobId && !state.jobs.some((job) => job.job_id === state.selectedJobId)) {
      state.selectedJobId = state.jobs[0]?.job_id ?? null;
      state.selectedArtifact = null;
    }

    renderJobs();
    try {
      await loadDetail({ keepArtifact });
      elements.refreshTime.textContent = `Last refreshed ${formatTime(new Date().toISOString())}`;
    } catch (error) {
      elements.refreshTime.textContent = `Detail load failed: ${error.message}`;
    }
  } catch (error) {
    setHealth(false, error.message);
    elements.refreshTime.textContent = "Refresh failed; will retry";
  } finally {
    schedulePolling();
  }
}

function schedulePolling() {
  if (state.pollHandle) {
    clearTimeout(state.pollHandle);
  }
  const needsPolling =
    state.jobs.length === 0 || state.jobs.some((job) => !terminal(job)) || !terminal(state.detail);
  if (needsPolling) {
    state.pollHandle = setTimeout(() => refreshAll({ keepArtifact: true }), 1600);
  }
}

void refreshAll({ keepArtifact: false });
