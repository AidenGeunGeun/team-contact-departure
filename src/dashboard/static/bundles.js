const bundleListStatus = document.getElementById("bundle-list-status");
const bundleCount = document.getElementById("bundle-count");
const bundleList = document.getElementById("bundle-list");

function setStatus(text, tone = "loading") {
  bundleListStatus.textContent = text;
  bundleListStatus.className = `health health--${tone}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function renderBundles(bundles) {
  bundleCount.textContent =
    bundles.length === 0 ? "No bundle folders found" : `${bundles.length} bundle folder${bundles.length === 1 ? "" : "s"}`;
  bundleList.replaceChildren();
  if (bundles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "Run create_evidence_bundle on a completed job to populate bundles/.";
    bundleList.append(empty);
    return;
  }

  for (const bundle of bundles) {
    const link = document.createElement("a");
    link.className = "job-card";
    link.href = `/bundle.html?bundle_id=${encodeURIComponent(bundle.bundle_id)}`;
    link.innerHTML = `
      <strong>${bundle.bundle_id}</strong>
      <span>${bundle.runner_kind} · ${bundle.replay_kind} replay</span>
      <span>${bundle.case_id}</span>
      <span>Verdict: ${bundle.recorded_verdict}</span>
    `;
    bundleList.append(link);
  }
}

async function main() {
  try {
    const payload = await fetchJson("/api/bundles");
    renderBundles(payload.bundles ?? []);
    setStatus("Bundles loaded", "ok");
  } catch (error) {
    setStatus("Failed to load bundles", "error");
    bundleCount.textContent = error instanceof Error ? error.message : String(error);
  }
}

void main();
