const bundleStatus = document.getElementById("bundle-status");
const bundleEmpty = document.getElementById("bundle-empty");
const bundleDetail = document.getElementById("bundle-detail");
const bundleCase = document.getElementById("bundle-case");
const bundleTitle = document.getElementById("bundle-title");
const bundleMeta = document.getElementById("bundle-meta");
const bundleReplayKind = document.getElementById("bundle-replay-kind");
const bundleReplayCommand = document.getElementById("bundle-replay-command");
const bundleManifest = document.getElementById("bundle-manifest");
const bundleArtifacts = document.getElementById("bundle-artifacts");

function getBundleIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get("bundle_id") ?? params.get("id");
}

function setStatus(text, tone = "loading") {
  bundleStatus.textContent = text;
  bundleStatus.className = `health health--${tone}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function renderArtifacts(paths) {
  bundleArtifacts.replaceChildren();
  if (!paths?.length) {
    const item = document.createElement("li");
    item.textContent = "No artifact paths recorded.";
    bundleArtifacts.append(item);
    return;
  }
  for (const path of paths) {
    const item = document.createElement("li");
    item.textContent = path;
    bundleArtifacts.append(item);
  }
}

async function main() {
  const bundleId = getBundleIdFromQuery();
  if (!bundleId) {
    setStatus("No bundle id", "warn");
    return;
  }

  try {
    const detail = await fetchJson(`/api/bundles/${encodeURIComponent(bundleId)}`);
    bundleEmpty.classList.add("hidden");
    bundleDetail.classList.remove("hidden");
    bundleCase.textContent = `${detail.case_id} · ${detail.test_card_id}`;
    bundleTitle.textContent = detail.bundle_id;
    bundleMeta.textContent = `Recorded verdict: ${detail.recorded_verdict}. ${detail.replay_kind} replay — ${detail.manifest.replay_kind_reason}`;
    bundleReplayKind.textContent = `${detail.replay_kind} replay`;
    bundleReplayCommand.textContent = detail.replay_command;
    bundleManifest.textContent = JSON.stringify(detail.manifest, null, 2);
    renderArtifacts(detail.artifact_paths);
    setStatus("Bundle loaded", "ok");
  } catch (error) {
    setStatus("Failed to load bundle", "error");
    bundleEmpty.classList.remove("hidden");
    bundleDetail.classList.add("hidden");
    bundleMeta.textContent = error instanceof Error ? error.message : String(error);
  }
}

void main();
