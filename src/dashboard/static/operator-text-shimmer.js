function createTextShimmerNode(text, active) {
  const root = document.createElement("span");
  root.dataset.component = "text-shimmer";
  root.dataset.active = active ? "true" : "false";
  root.setAttribute("aria-hidden", "true");

  const char = document.createElement("span");
  char.dataset.slot = "text-shimmer-char";

  const base = document.createElement("span");
  base.dataset.slot = "text-shimmer-char-base";
  base.setAttribute("aria-hidden", "true");
  base.textContent = text;

  const sweep = document.createElement("span");
  sweep.dataset.slot = "text-shimmer-char-shimmer";
  sweep.dataset.run = active ? "true" : "false";
  sweep.setAttribute("aria-hidden", "true");
  sweep.textContent = text;

  char.append(base, sweep);
  root.appendChild(char);
  return root;
}

function readShimmerText(host) {
  return (
    host.dataset.shimmerText ??
    host.querySelector('[data-slot="text-shimmer-char-base"]')?.textContent ??
    host.textContent ??
    ""
  );
}

export function mountTextShimmer(host, text, active = true) {
  if (!host) {
    return;
  }
  host.dataset.shimmerText = text;
  const existing = host.querySelector('[data-component="text-shimmer"]');
  if (existing) {
    existing.dataset.active = active ? "true" : "false";
    const base = existing.querySelector('[data-slot="text-shimmer-char-base"]');
    const sweep = existing.querySelector('[data-slot="text-shimmer-char-shimmer"]');
    if (base) {
      base.textContent = text;
    }
    if (sweep) {
      sweep.textContent = text;
      sweep.dataset.run = active ? "true" : "false";
    }
    return;
  }
  host.replaceChildren(createTextShimmerNode(text, active));
}

export function setTextShimmerActive(host, active) {
  if (!host) {
    return;
  }
  const existing = host.querySelector('[data-component="text-shimmer"]');
  if (!existing) {
    mountTextShimmer(host, readShimmerText(host), active);
    return;
  }
  existing.dataset.active = active ? "true" : "false";
  const sweep = existing.querySelector('[data-slot="text-shimmer-char-shimmer"]');
  if (sweep) {
    sweep.dataset.run = active ? "true" : "false";
  }
}

export function clearTextShimmer(host, text) {
  if (!host) {
    return;
  }
  delete host.dataset.shimmerText;
  host.textContent = text;
}
