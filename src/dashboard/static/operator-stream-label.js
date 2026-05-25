import { clearTextShimmer, mountTextShimmer } from "./operator-text-shimmer.js";
import { createStreamPacer } from "./operator-stream-pace.js";

/** @type {WeakMap<HTMLElement, { pacer: ReturnType<createStreamPacer>, targetText: string, running: boolean }>} */
const labelEntries = new WeakMap();

function applyLabelRender(host, rendered, fullText, running, meta) {
  if (!fullText) {
    host.textContent = "";
    return;
  }
  if (meta.done) {
    if (running) {
      mountTextShimmer(host, fullText, true);
    } else {
      clearTextShimmer(host, fullText);
    }
    return;
  }
  host.textContent = rendered;
}

function ensureLabelEntry(host) {
  let entry = labelEntries.get(host);
  if (entry) {
    return entry;
  }
  const pacer = createStreamPacer({
    onRender(rendered, meta) {
      const current = labelEntries.get(host);
      if (!current) {
        return;
      }
      applyLabelRender(host, rendered, current.targetText, current.running, meta);
    },
  });
  entry = { pacer, targetText: "", running: false };
  labelEntries.set(host, entry);
  return entry;
}

export function resetPacedLabel(host) {
  if (!host) {
    return;
  }
  const entry = labelEntries.get(host);
  if (!entry) {
    return;
  }
  entry.pacer.reset();
  entry.targetText = "";
  entry.running = false;
}

export function revealPacedLabel(host, text, options = {}) {
  if (!host) {
    return;
  }
  const nextText = text ?? "";
  const running = Boolean(options.running);
  const catchUp = Boolean(options.catchUp);

  if (!nextText) {
    resetPacedLabel(host);
    host.textContent = "";
    return;
  }

  const entry = ensureLabelEntry(host);
  entry.targetText = nextText;
  entry.running = running;
  entry.pacer.setCatchUp(catchUp);
  entry.pacer.setTarget(nextText);
}
