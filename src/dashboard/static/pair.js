const pairStatus = document.getElementById("pair-status");
const pairEmpty = document.getElementById("pair-empty");
const pairDetail = document.getElementById("pair-detail");
const pairCase = document.getElementById("pair-case");
const pairTitle = document.getElementById("pair-title");
const pairMeta = document.getElementById("pair-meta");
const pairFlipIndicator = document.getElementById("pair-flip-indicator");
const pairConditions = document.getElementById("pair-conditions");

function getPairIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get("pair_id") ?? params.get("id");
}

function setStatus(text, tone = "loading") {
  pairStatus.textContent = text;
  pairStatus.className = `health health--${tone}`;
}

function renderSummaryList(container, summary, jobDetail) {
  container.replaceChildren();
  const rows = [
    ["Target commit", summary.target_commit],
    ["Resolved commit", summary.resolved_commit_hash ?? "unknown"],
    ["Outcome", summary.outcome ?? "unknown"],
    ["Firmware commit proven", String(summary.firmware_commit_proven ?? "unknown")],
    ["Runner kind", summary.runner_kind],
    ["Verdict", jobDetail?.verdict ?? "unknown"],
    ["Artifacts", String(jobDetail?.artifact_count ?? 0)],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    container.append(dt, dd);
  }
}

function renderArtifactLinks(container, jobDetail) {
  container.replaceChildren();
  if (!jobDetail?.artifacts?.length) {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "No artifacts listed.";
    container.append(empty);
    return;
  }

  const keyArtifacts = jobDetail.artifacts.filter((item) =>
    ["frame-record.json", "frame-record.hex", "delivery-record.json", "observation-record.json", "evidence-summary.md"].includes(
      item.name,
    ),
  );
  const artifacts = keyArtifacts.length > 0 ? keyArtifacts : jobDetail.artifacts.slice(0, 5);

  for (const artifact of artifacts) {
    const link = document.createElement("a");
    link.className = "artifact-button";
    link.href = `/?job_id=${encodeURIComponent(jobDetail.job_id)}`;
    link.textContent = `${artifact.name} (${artifact.size} bytes)`;
    container.append(link);
  }
}

function renderCondition(label, value) {
  const item = document.createElement("li");
  const pill = document.createElement("span");
  pill.className = `status-pill ${value ? "status-pill--good" : "status-pill--warn"}`;
  pill.textContent = value ? "yes" : "no";
  item.append(`${label}: `, pill);
  return item;
}

function renderConditions(pair) {
  pairConditions.replaceChildren();
  pairConditions.append(
    renderCondition("Roles correctly assigned", pair.roles_correctly_assigned),
    renderCondition("Provenance complete", pair.provenance_complete),
    renderCondition("Frames delivered on both sides", pair.frames_delivered_on_both_sides),
    renderCondition("Meaningful outcomes on both sides", pair.meaningful_outcomes_on_both_sides),
    renderCondition("Outcomes differ", pair.outcomes_differ),
    renderCondition("Frame bytes equal", pair.frame_bytes_equal),
    renderCondition("Budget profile equal", pair.budget_profile_equal),
    renderCondition("Sanitizers used equal", pair.sanitizers_used_equal),
  );
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

async function loadPair() {
  const pairId = getPairIdFromQuery();
  if (!pairId) {
    setStatus("No pair selected", "warn");
    return;
  }

  try {
    const detail = await fetchJson(`/api/pairs/${encodeURIComponent(pairId)}`);
    const pair = detail.pair ?? detail;
    pairEmpty.classList.add("hidden");
    pairDetail.classList.remove("hidden");

    pairCase.textContent = `${detail.case_id} · ${detail.test_card_id}`;
    pairTitle.textContent = detail.pair_id;
    pairMeta.textContent = `Compared at ${detail.compared_at}. Resolved hashes differ: ${detail.resolved_commit_hashes_differ ? "yes" : "no"}.`;

    const demonstrated = pair.verdict_flip_demonstrated === true;
    pairFlipIndicator.textContent = demonstrated
      ? "Verdict flip demonstrated"
      : "Verdict flip not demonstrated";
    pairFlipIndicator.className = `status-pill ${demonstrated ? "status-pill--good" : "status-pill--warn"}`;

    renderConditions(pair);

    document.getElementById("pre-patch-job-id").textContent = pair.pre_patch.job_id;
    document.getElementById("post-patch-job-id").textContent = pair.post_patch.job_id;

    renderSummaryList(
      document.getElementById("pre-patch-summary"),
      pair.pre_patch,
      detail.pre_patch_job,
    );
    renderSummaryList(
      document.getElementById("post-patch-summary"),
      pair.post_patch,
      detail.post_patch_job,
    );
    renderArtifactLinks(document.getElementById("pre-patch-artifacts"), detail.pre_patch_job);
    renderArtifactLinks(document.getElementById("post-patch-artifacts"), detail.post_patch_job);

    setStatus("Pair loaded", "good");
  } catch (error) {
    pairEmpty.classList.remove("hidden");
    pairDetail.classList.add("hidden");
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "bad");
  }
}

void loadPair();
