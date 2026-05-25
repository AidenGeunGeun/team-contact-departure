import { looksLikeMarkdown, renderMarkdown } from "./operator-markdown.js";
import { morphAssistantBody } from "./operator-markdown-morph.js";
import { revealPacedLabel, resetPacedLabel } from "./operator-stream-label.js";
import { createPacedValue, createStreamPacer } from "./operator-stream-pace.js";

const state = {
  config: null,
  session: { phase: "idle" },
  sse: null,
  sseConnected: false,
  stubSession: false,
  thinking: false,
  thinkingBuffer: "",
  thinkingStartedAt: null,
  thinkingDurationMs: null,
  assistantBuffer: "",
  assistantNode: null,
  activityCards: new Map(),
  contactByTool: new Map(),
  exploringGroup: null,
  currentTurn: null,
  thinkingRow: null,
  jobSnapshots: new Map(),
  selectedJobId: null,
  selectedPartId: null,
  transcript: null,
  reconnectTimer: null,
  scrollPinned: true,
  userScrolledAway: false,
  lastTimelineScrollTop: 0,
  touchScrollStartTop: 0,
  sseEverConnected: false,
  viewingSessionId: null,
  playbackMode: false,
  sessionCatalog: [],
  pendingDeleteSessionId: null,
  pendingDeleteTimer: null,
  replayedEventIds: new Set(),
  followUpCount: 0,
  hasSentPrompt: false,
  demoLaunching: false,
  demoViewPrepared: false,
  liveSyncTimer: null,
  inspectorCloseTimer: null,
  streamCatchUp: false,
  streamScrollScheduled: false,
  sseNeedsCatchUp: false,
};

let thinkingStreamPacer = null;
let assistantPacedValue = null;

function scheduleStreamScroll() {
  if (state.streamScrollScheduled || state.userScrolledAway) {
    return;
  }
  state.streamScrollScheduled = true;
  requestAnimationFrame(() => {
    state.streamScrollScheduled = false;
    if (!state.userScrolledAway) {
      scrollTimeline();
    }
  });
}

function ensureAssistantPacedValue() {
  if (!assistantPacedValue) {
    assistantPacedValue = createPacedValue({
      getTarget: () => state.assistantBuffer,
      onRender(shown) {
        if (!state.assistantNode) {
          return;
        }
        state.assistantNode.classList.remove("markdown-body");
        state.assistantNode.textContent = shown;
        scheduleStreamScroll();
      },
    });
  }
  return assistantPacedValue;
}

function resetAssistantPacing() {
  assistantPacedValue?.reset();
  assistantPacedValue?.setStreaming(true);
}

function ensureThinkingStreamPacer() {
  if (!thinkingStreamPacer) {
    thinkingStreamPacer = createStreamPacer({
      onRender(text, meta) {
        const content = thinkingContentEl();
        if (!content) {
          return;
        }
        const raw = text.trim();
        if (!raw) {
          content.replaceChildren();
          content.classList.remove("markdown-body", "reasoning-body", "is-streaming");
          return;
        }
        content.classList.add("reasoning-body", "is-streaming");
        content.classList.remove("markdown-body");
        content.textContent = raw;
        if (state.thinkingRow?.dataset.expanded === "true") {
          content.scrollTop = content.scrollHeight;
        }
        scheduleStreamScroll();
        if (meta.done && !meta.catchingUp) {
          content.classList.remove("is-streaming");
        }
      },
    });
  }
  return thinkingStreamPacer;
}

function resetStreamPacers() {
  resetAssistantPacing();
  thinkingStreamPacer?.reset();
  state.streamCatchUp = false;
}

function setStreamCatchUp(active) {
  state.streamCatchUp = Boolean(active);
  ensureAssistantPacedValue().setStreaming(!state.streamCatchUp);
  ensureThinkingStreamPacer().setCatchUp(state.streamCatchUp);
}

const elements = {
  app: document.querySelector("#operator-app"),
  statusPill: document.querySelector("#session-status"),
  sessionNotice: document.querySelector("#session-notice"),
  timeline: document.querySelector("#timeline"),
  inspector: document.querySelector("#inspector"),
  inspectorBackdrop: document.querySelector("#inspector-backdrop"),
  inspectorClose: document.querySelector("#inspector-close"),
  inspectorBody: document.querySelector("#inspector-body"),
  inspectorTitle: document.querySelector("#inspector-title"),
  inspectorSubtitle: document.querySelector("#inspector-subtitle"),
  sessionList: document.querySelector("#session-list"),
  newSessionButton: document.querySelector("#new-session"),
  sessionSidebarHide: document.querySelector("#session-sidebar-hide"),
  sessionSidebarShow: document.querySelector("#session-sidebar-show"),
  promptInput: document.querySelector("#prompt-input"),
  sendButton: document.querySelector("#send-prompt"),
  sessionDemoButton: document.querySelector("#session-demo"),
  composerHint: document.querySelector("#composer-hint"),
  jumpBottom: document.querySelector("#jump-bottom"),
};

function text(value, fallback = "—") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value);
}

function titleize(value) {
  return text(value, "unknown").replaceAll("_", " ").replaceAll("-", " ");
}

function terminalPhase(phase) {
  return phase === "completed" || phase === "failed";
}

function terminalJobState(jobState) {
  return jobState === "succeeded" || jobState === "failed" || jobState === "cancelled";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function setNotice(message, tone = "") {
  if (!message) {
    elements.sessionNotice.className = "session-notice hidden";
    elements.sessionNotice.textContent = "";
    return;
  }
  elements.sessionNotice.className = tone ? `session-notice session-notice--${tone}` : "session-notice";
  elements.sessionNotice.textContent = message;
}

function clearNotice() {
  setNotice("");
}

function updateStatusPill() {
  const phase = state.session.phase ?? "idle";
  let label = "Ready";
  let className = "ready";

  const sessionActive = state.demoLaunching || phase === "starting" || phase === "running";
  const hasTransport = state.sseConnected || state.liveSyncTimer;

  if (!hasTransport && !sessionActive) {
    label = "Reconnecting";
    className = "warn";
  } else if (state.thinking) {
    label = "Thinking";
    className = "thinking";
  } else if (state.demoLaunching || phase === "starting") {
    label = "Starting";
    className = "running";
  } else if (phase === "running") {
    label = "Running";
    className = "running";
  } else if (phase === "failed") {
    label = "Failed";
    className = "error";
  } else if (phase === "completed") {
    label = "Done";
    className = "ready";
  }

  elements.statusPill.textContent = label;
  elements.statusPill.className = `header-status ${className}`;
}

const PROMPT_MAX_HEIGHT_PX = 200;
let promptResizeFrame = 0;

function resizePromptInput() {
  const field = elements.promptInput;
  if (!field || field.disabled) {
    return;
  }
  field.style.height = "0";
  const nextHeight = Math.min(field.scrollHeight, PROMPT_MAX_HEIGHT_PX);
  field.style.height = `${Math.max(nextHeight, 24)}px`;
  field.style.overflowY = field.scrollHeight > PROMPT_MAX_HEIGHT_PX ? "auto" : "hidden";
}

function schedulePromptResize() {
  if (promptResizeFrame) {
    return;
  }
  promptResizeFrame = requestAnimationFrame(() => {
    promptResizeFrame = 0;
    resizePromptInput();
  });
}

function syncSendButton() {
  const working = isSessionWorking();
  const blank = elements.promptInput.value.trim() === "";
  if (working) {
    elements.sendButton.disabled = false;
    elements.sendButton.classList.add("is-stop");
    elements.sendButton.textContent = "■";
    elements.sendButton.setAttribute("aria-label", "Stop generation");
    return;
  }
  elements.sendButton.classList.remove("is-stop");
  elements.sendButton.textContent = "↑";
  elements.sendButton.setAttribute("aria-label", "Send");
  elements.sendButton.disabled = blank;
}

function syncDemoButtonVisibility() {
  const working = isSessionWorking();
  if (elements.sessionDemoButton) {
    elements.sessionDemoButton.hidden = working;
    elements.sessionDemoButton.disabled = working;
  }
}

function clearComposerHint() {
  elements.composerHint.textContent = "";
  elements.composerHint.classList.add("hidden");
  delete elements.composerHint.dataset.persistent;
}

function updateComposerChrome() {
  const working = isSessionWorking();

  elements.promptInput.disabled = false;
  syncDemoButtonVisibility();
  syncSendButton();
  elements.sendButton.classList.toggle("is-working", working && !elements.sendButton.classList.contains("is-stop"));

  if (!working) {
    clearComposerHint();
  }

  schedulePromptResize();
}

function setSessionSidebarCollapsed(collapsed) {
  elements.app.dataset.sidebarCollapsed = collapsed ? "true" : "false";
  try {
    localStorage.setItem("operator-sidebar-collapsed", collapsed ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function restoreSessionSidebarCollapsed() {
  try {
    if (localStorage.getItem("operator-sidebar-collapsed") === "1") {
      setSessionSidebarCollapsed(true);
    }
  } catch {
    // ignore storage failures
  }
}

function persistViewingSessionId() {
  try {
    if (state.viewingSessionId && state.viewingSessionId !== "demo-pending") {
      localStorage.setItem("operator-viewing-session", state.viewingSessionId);
    } else {
      localStorage.removeItem("operator-viewing-session");
    }
  } catch {
    // ignore storage failures
  }
}

function restoreViewingSessionId() {
  try {
    const stored = localStorage.getItem("operator-viewing-session");
    if (stored) {
      state.viewingSessionId = stored;
    }
  } catch {
    // ignore storage failures
  }
}

function markEventSeen(event) {
  if (event?.id) {
    state.replayedEventIds.add(event.id);
  }
}

function shouldSkipDuplicateEvent(event) {
  return Boolean(event?.id && state.replayedEventIds.has(event.id));
}

function resolveActiveSessionId() {
  const viewing = state.viewingSessionId;
  const live = state.session?.session_id;
  if (viewing && viewing !== "demo-pending") {
    return viewing;
  }
  return live ?? null;
}

function assistantMessageHasContent() {
  const node = document.querySelector("#timeline .message.assistant");
  if (!node) {
    return false;
  }
  if (node.textContent?.trim()) {
    return true;
  }
  return Boolean(node.querySelector("h1, h2, h3, p, li, pre, ul, ol"));
}

function removeEmptyAssistantShell() {
  const node = document.querySelector("#timeline .message.assistant");
  if (node && !assistantMessageHasContent()) {
    node.remove();
  }
}

function renderAssistantText(bodyText) {
  const text = bodyText ?? "";
  if (!text.trim() || assistantMessageHasContent()) {
    return Boolean(assistantMessageHasContent());
  }
  removeEmptyAssistantShell();
  settleThinkingRow();
  const article = document.createElement("article");
  article.className = "message assistant";
  appendToTurn(article);
  try {
    if (looksLikeMarkdown(text)) {
      morphAssistantBody(article, text, { final: true });
    } else {
      article.textContent = text;
    }
  } catch (error) {
    console.error("assistant fallback render failed", error);
    article.textContent = text;
  }
  scheduleStreamScroll();
  return true;
}

async function refreshTerminalSessionUi() {
  try {
    const { payload } = await fetchJson("/api/operator/state");
    if (!payload.state) {
      return;
    }
    state.session = payload.state;
    const phase = state.session.phase ?? "idle";
    if (phase !== "completed" && phase !== "failed") {
      updateStatusPill();
      return;
    }
    stopLiveSessionSync();
    state.demoLaunching = false;
    state.demoViewPrepared = false;
    state.followUpCount = 0;
    if (!state.playbackMode && state.stubSession) {
      if (state.session.selected_job_id) {
        state.selectedJobId = state.session.selected_job_id;
        state.selectedPartId = `job-${state.session.selected_job_id}`;
        highlightSelectedPart();
      }
      setNotice("Demo complete — simulated stream finished.");
    }
    setComposerEnabled(true);
    void refreshSessionCatalog();
    updateStatusPill();
    updateComposerChrome();
  } catch {
    // ignore transient refresh failures
  }
}

function assistantTextFromEvents(events) {
  return events
    .filter((event) => event.type === "assistant_text_delta")
    .map((event) => text(event.payload?.delta, ""))
    .join("");
}

function setComposerEnabled(enabled) {
  if (!enabled) {
    elements.promptInput.disabled = true;
    elements.sendButton.disabled = true;
    if (elements.sessionDemoButton) {
      elements.sessionDemoButton.disabled = true;
    }
    elements.sendButton.classList.add("is-working");
    return;
  }
  updateComposerChrome();
}

function openInspectorPanel() {
  if (state.inspectorCloseTimer) {
    window.clearTimeout(state.inspectorCloseTimer);
    state.inspectorCloseTimer = null;
  }
  elements.inspector.classList.remove("closing");
  elements.inspector.classList.add("open");
  elements.inspector.setAttribute("aria-hidden", "false");
  elements.app.dataset.inspectorOpen = "true";
  elements.inspectorBackdrop.setAttribute("aria-hidden", "false");
}

function closeInspectorPanel() {
  if (!elements.inspector.classList.contains("open")) {
    return;
  }
  if (elements.inspector.contains(document.activeElement)) {
    elements.promptInput.focus({ preventScroll: true });
  }
  elements.inspector.classList.add("closing");
  elements.inspector.classList.remove("open");
  elements.inspector.setAttribute("aria-hidden", "true");
  const finishClose = () => {
    state.inspectorCloseTimer = null;
    if (elements.inspector.classList.contains("open")) {
      return;
    }
    elements.inspector.classList.remove("closing");
    delete elements.app.dataset.inspectorOpen;
    elements.inspectorBackdrop.setAttribute("aria-hidden", "true");
  };
  state.inspectorCloseTimer = window.setTimeout(finishClose, 260);
}

function setSessionMode(active) {
  elements.app.dataset.session = active ? "active" : "idle";
}

function ensureTimelineVisible() {
  const empty = elements.timeline.querySelector(".timeline-empty");
  if (empty) {
    empty.remove();
  }
}

function isSessionWorking() {
  if (state.demoLaunching) {
    return false;
  }
  const phase = state.session.phase ?? "idle";
  return phase === "starting" || phase === "running";
}

function updateJumpButton() {
  if (!elements.jumpBottom) {
    return;
  }
  const { scrollHeight, clientHeight, distanceFromBottom } = readTimelineScroll();
  const hasContent = scrollHeight > clientHeight + 120;
  const show = hasContent && (state.userScrolledAway || distanceFromBottom > 96);
  elements.jumpBottom.hidden = !show;
  elements.jumpBottom.classList.toggle("visible", show);
}

function readTimelineScroll() {
  const { scrollTop, scrollHeight, clientHeight } = elements.timeline;
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  return { scrollTop, scrollHeight, clientHeight, distanceFromBottom };
}

function markUserScrolledAway() {
  state.userScrolledAway = true;
  state.scrollPinned = false;
  updateJumpButton();
}

function syncScrollFollowState() {
  const { scrollTop, distanceFromBottom } = readTimelineScroll();
  if (scrollTop < state.lastTimelineScrollTop - 2) {
    markUserScrolledAway();
  }
  state.lastTimelineScrollTop = scrollTop;

  if (state.userScrolledAway) {
    state.scrollPinned = false;
    if (distanceFromBottom < 24) {
      state.userScrolledAway = false;
      state.scrollPinned = true;
    }
  } else {
    state.scrollPinned = distanceFromBottom < 64;
  }
  updateJumpButton();
}

function preserveTimelineScrollWhile(appending) {
  const pinnedTop = state.userScrolledAway ? elements.timeline.scrollTop : null;
  appending();
  if (pinnedTop !== null) {
    elements.timeline.scrollTop = pinnedTop;
    state.lastTimelineScrollTop = pinnedTop;
    updateJumpButton();
    return;
  }
  scrollTimeline();
}

function scrollTimeline(forceFollow = false) {
  if (forceFollow) {
    state.scrollPinned = true;
    state.userScrolledAway = false;
  } else if (state.userScrolledAway || !state.scrollPinned) {
    updateJumpButton();
    return;
  }
  const { scrollHeight } = readTimelineScroll();
  elements.timeline.scrollTo({ top: scrollHeight, behavior: "instant" });
  state.lastTimelineScrollTop = elements.timeline.scrollTop;
  updateJumpButton();
}

function shellDescFromCommand(command) {
  const trimmed = command.trim();
  const contactTail = trimmed.match(/contact\s+--\s+(.+)$/i);
  const label = contactTail?.[1] ?? trimmed.replace(/^\$\s*/, "");
  return label.length > 88 ? `${label.slice(0, 85)}…` : label;
}

function kindLabelText(kindEl) {
  if (!kindEl) {
    return "";
  }
  return (
    kindEl.dataset.shimmerText ??
    kindEl.querySelector('[data-slot="text-shimmer-char-base"]')?.textContent ??
    kindEl.textContent ??
    ""
  );
}

function syncKindShimmer(card, running) {
  if (!card?.kindEl) {
    return;
  }
  const kind = kindLabelText(card.kindEl);
  if (!kind) {
    return;
  }
  revealPacedLabel(card.kindEl, kind, { running, catchUp: state.streamCatchUp });
}

function setActivityLine(card, kind, desc) {
  if (!card?.kindEl) {
    return;
  }
  const running = card.row?.dataset.state === "running";
  revealPacedLabel(card.kindEl, kind ?? "", {
    running: running && Boolean(kind),
    catchUp: state.streamCatchUp,
  });
  if (card.descEl) {
    if (desc) {
      card.descEl.hidden = false;
      revealPacedLabel(card.descEl, desc, { running: false, catchUp: state.streamCatchUp });
    } else {
      resetPacedLabel(card.descEl);
      card.descEl.textContent = "";
      card.descEl.hidden = true;
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderPathList(lines) {
  const cleaned = lines.map((line) => line.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "";
  }
  return `<ul class="activity-path-list">${cleaned
    .map((line) => `<li><code>${escapeHtml(line)}</code></li>`)
    .join("")}</ul>`;
}

function setActivityBodyContent(card, rawText, options = {}) {
  const body = card.bodyEl;
  if (!body) {
    return;
  }
  const text = rawText?.trim() ?? "";
  body.classList.remove("markdown-body", "activity-paths-body");
  if (!text) {
    body.innerHTML = "";
    return;
  }
  const format =
    options.format ??
    (looksLikeMarkdown(text) ? "markdown" : options.mono ? "command" : "text");
  if (format === "markdown") {
    body.classList.add("markdown-body");
    body.innerHTML = renderMarkdown(text);
    return;
  }
  if (format === "paths") {
    const lines = text.includes("\n") ? text.split("\n") : [text];
    body.classList.add("activity-paths-body");
    body.innerHTML = renderPathList(lines);
    return;
  }
  if (format === "command") {
    body.innerHTML = `<pre class="mono activity-command"><code>${escapeHtml(text)}</code></pre>`;
    return;
  }
  body.textContent = text;
}

function formatExploringSummary(tools) {
  const counts = { read: 0, search: 0, list: 0 };
  for (const tool of tools) {
    if (tool === "read") {
      counts.read += 1;
    } else if (tool === "glob" || tool === "grep") {
      counts.search += 1;
    } else if (tool === "list") {
      counts.list += 1;
    }
  }
  const parts = [];
  if (counts.read > 0) {
    parts.push(`${counts.read} read${counts.read > 1 ? "s" : ""}`);
  }
  if (counts.search > 0) {
    parts.push(`${counts.search} search${counts.search > 1 ? "es" : ""}`);
  }
  if (counts.list > 0) {
    parts.push(`${counts.list} list${counts.list > 1 ? "s" : ""}`);
  }
  return parts.join(", ");
}

function appendTimeline(node) {
  preserveTimelineScrollWhile(() => {
    ensureTimelineVisible();
    elements.timeline.appendChild(node);
  });
}

function beginTurn() {
  state.currentTurn = document.createElement("section");
  state.currentTurn.className = "session-turn";
  state.currentTurn.dataset.component = "session-turn";
  appendTimeline(state.currentTurn);
  return state.currentTurn;
}

function appendToTurn(node) {
  preserveTimelineScrollWhile(() => {
    if (!state.currentTurn) {
      beginTurn();
    }
    state.currentTurn.appendChild(node);
  });
}

function createMessage(role, bodyText, options = {}) {
  if (role === "user") {
    const wrap = document.createElement("div");
    wrap.dataset.component = "user-message";
    if (options.queued) {
      wrap.classList.add("is-queued");
      wrap.dataset.queued = "true";
    }
    const article = document.createElement("article");
    article.className = "message user";
    article.textContent = bodyText;
    wrap.appendChild(article);
    if (options.queued) {
      const badge = document.createElement("span");
      badge.className = "message-queue-badge";
      badge.textContent = "Queued";
      wrap.appendChild(badge);
    }
    appendToTurn(wrap);
    return article;
  }
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.dataset.component = "text-part";
  article.textContent = bodyText;
  appendToTurn(article);
  return article;
}

function ensureThinkingRow() {
  if (!state.thinkingRow) {
    const row = document.createElement("div");
    row.className = "thinking-row";
    row.dataset.slot = "session-turn-thinking";
    row.dataset.expanded = "false";
    row.hidden = true;
    row.innerHTML =
      '<button type="button" class="thinking-toggle" aria-expanded="false">' +
      '<span class="thinking-spinner" aria-hidden="true"></span>' +
      '<span class="thinking-label">Thinking</span>' +
      '<span class="thinking-meta"></span>' +
      '<span class="thinking-chevron" aria-hidden="true"></span>' +
      "</button>" +
      '<div class="thinking-body"><div class="thinking-content reasoning-body"></div></div>';
    row.querySelector(".thinking-toggle")?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleThinkingRow();
    });
    state.thinkingRow = row;
  }
  return state.thinkingRow;
}

function thinkingContentEl() {
  return state.thinkingRow?.querySelector(".thinking-content");
}

function formatThoughtDuration(durationMs) {
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? "Thought for 1 second" : `Thought for ${seconds} seconds`;
}

function readThinkingBuffer() {
  if (state.thinkingBuffer.trim()) {
    return state.thinkingBuffer;
  }
  const stored = state.thinkingRow?.dataset.thinkingText?.trim();
  return stored ?? "";
}

function syncThinkingContent() {
  const content = thinkingContentEl();
  if (!content) {
    return;
  }
  const raw = readThinkingBuffer();
  if (!raw.trim()) {
    content.replaceChildren();
    content.classList.remove("markdown-body", "reasoning-body");
    delete state.thinkingRow?.dataset.thinkingText;
    return;
  }
  state.thinkingBuffer = raw;
  state.thinkingRow.dataset.thinkingText = raw;
  content.classList.add("markdown-body", "reasoning-body");
  content.innerHTML = renderMarkdown(raw);
  if (state.thinkingRow?.dataset.expanded === "true") {
    content.scrollTop = content.scrollHeight;
  }
}

function revealThinkingRow() {
  const row = state.thinkingRow;
  if (!row || row.dataset.expanded !== "true") {
    return;
  }
  row.scrollIntoView({ block: "nearest", behavior: "instant" });
}

function toggleThinkingRow() {
  const row = state.thinkingRow;
  if (!row || !readThinkingBuffer().trim()) {
    return;
  }
  const open = row.dataset.expanded !== "true";
  row.dataset.expanded = open ? "true" : "false";
  row.classList.toggle("is-expanded", open);
  row.querySelector(".thinking-toggle")?.setAttribute("aria-expanded", open ? "true" : "false");
  syncThinkingContent();
  if (open) {
    revealThinkingRow();
  }
}

function appendThinkingDelta(delta) {
  if (!delta) {
    return;
  }
  state.thinkingBuffer += delta;
  const row = ensureThinkingRow();
  row.dataset.thinkingText = state.thinkingBuffer;
  row.classList.add("has-content");
  row.hidden = false;
  ensureThinkingStreamPacer().enqueue(delta);
}

function resetThinkingRow() {
  state.thinkingBuffer = "";
  state.thinkingDurationMs = null;
  ensureThinkingStreamPacer().reset();
  if (!state.thinkingRow) {
    return;
  }
  state.thinkingRow.dataset.expanded = "false";
  state.thinkingRow.classList.remove("is-expanded", "has-content", "is-settled");
  state.thinkingRow.querySelector(".thinking-toggle")?.setAttribute("aria-expanded", "false");
  delete state.thinkingRow.dataset.thinkingText;
  const content = thinkingContentEl();
  if (content) {
    content.replaceChildren();
    content.classList.remove("markdown-body", "reasoning-body");
  }
  const label = state.thinkingRow.querySelector(".thinking-label");
  const spinner = state.thinkingRow.querySelector(".thinking-spinner");
  spinner?.classList.remove("hidden");
  resetPacedLabel(label);
}

function settleThinkingRow() {
  state.thinking = false;
  if (state.thinkingBuffer.trim()) {
    ensureThinkingStreamPacer().setTarget(state.thinkingBuffer);
  }
  ensureThinkingStreamPacer().flush();
  const row = state.thinkingRow;
  if (!row) {
    updateStatusPill();
    return;
  }
  const label = row.querySelector(".thinking-label");
  row.querySelector(".thinking-spinner")?.classList.add("hidden");
  const thoughtText = readThinkingBuffer();
  if (thoughtText.trim()) {
    state.thinkingBuffer = thoughtText;
    row.dataset.thinkingText = thoughtText;
    syncThinkingContent();
    const durationLabel = formatThoughtDuration(state.thinkingDurationMs);
    revealPacedLabel(label, durationLabel, { running: false, catchUp: state.streamCatchUp });
    row.classList.add("is-settled", "has-content");
    row.hidden = false;
  } else {
    delete row.dataset.thinkingText;
    row.hidden = true;
  }
  updateStatusPill();
}

function beginAssistantMessage() {
  settleThinkingRow();
  state.assistantBuffer = "";
  const article = document.createElement("article");
  article.className = "message assistant";
  appendToTurn(article);
  state.assistantNode = article;
}

function appendAssistantDelta(delta) {
  if (!delta) {
    return;
  }
  if (!state.assistantNode) {
    beginAssistantMessage();
  }
  state.assistantBuffer += delta;
  state.assistantNode.textContent = state.assistantBuffer;
  scheduleStreamScroll();
}

function finishAssistantMessage() {
  const node = state.assistantNode;
  const text = state.assistantBuffer;
  if (node && text) {
    try {
      if (looksLikeMarkdown(text)) {
        morphAssistantBody(node, text, { final: true });
      } else {
        node.classList.remove("markdown-body");
        node.textContent = text;
      }
    } catch (error) {
      console.error("assistant render failed", error);
      node.textContent = text;
    }
  }
  state.assistantNode = null;
  state.assistantBuffer = "";
}

function setThinking(active, message) {
  state.thinking = active;
  const row = ensureThinkingRow();
  if (active) {
    resetThinkingRow();
    ensureTimelineVisible();
    if (!state.currentTurn) {
      beginTurn();
    }
    state.currentTurn.appendChild(row);
    row.hidden = false;
    row.classList.remove("is-settled");
    row.classList.add("stream-enter");
    const label = row.querySelector(".thinking-label");
    const meta = row.querySelector(".thinking-meta");
    const spinner = row.querySelector(".thinking-spinner");
    spinner?.classList.remove("hidden");
    const statusMessage = message ?? "Thinking";
    revealPacedLabel(label, "Thinking", { running: true, catchUp: state.streamCatchUp });
    if (statusMessage && statusMessage !== "Thinking") {
      revealPacedLabel(meta, statusMessage, { running: false, catchUp: state.streamCatchUp });
    } else {
      resetPacedLabel(meta);
      meta.textContent = "";
      meta.hidden = true;
    }
  } else {
    settleThinkingRow();
  }
  updateStatusPill();
}

function syncActivityRow(card) {
  const rowState = card.row.dataset.state ?? "running";
  const running = rowState === "running";
  const done = rowState === "completed" || rowState === "error";

  card.row.classList.toggle("is-running", running);

  const exploring = card.row.dataset.mode === "exploring";
  const bodyText = card.bodyEl?.textContent?.trim();
  const canExpand =
    (done || exploring) &&
    card.row.dataset.mode !== "job" &&
    Boolean(bodyText);
  card.row.classList.toggle("can-expand", canExpand);

  if (!canExpand && card.row.dataset.expanded === "true") {
    card.row.dataset.expanded = "false";
    card.toggle.setAttribute("aria-expanded", "false");
  }

  if (card.row.dataset.mode === "exploring") {
    const kind = running ? "Exploring" : "Explored";
    const desc = card.tools?.length ? formatExploringSummary(card.tools) : "";
    setActivityLine(card, kind, desc);
    card.kindEl?.classList.toggle("tool-status-settled", !running);
  } else {
    syncKindShimmer(card, running);
  }
}

function createActivityRow({ mode, expandable = true, selectable = false }) {
  const row = document.createElement("article");
  row.className = "activity-row stream-enter";
  row.dataset.component = "tool-part-wrapper";
  if (selectable) {
    row.classList.add("selectable");
  }
  row.dataset.mode = mode;
  row.dataset.state = "running";
  row.dataset.expanded = "false";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "activity-toggle";
  toggle.setAttribute("aria-expanded", "false");

  toggle.innerHTML =
    '<span class="activity-kind"></span><span class="activity-desc"></span><span class="activity-chevron" aria-hidden="true"></span>';

  const body = document.createElement("div");
  body.className = "activity-body";
  const bodyInner = document.createElement("div");
  bodyInner.className = "activity-body-inner";
  body.appendChild(bodyInner);

  if (expandable) {
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (row.dataset.state === "running" && row.dataset.mode !== "exploring") {
        return;
      }
      if (!row.classList.contains("can-expand")) {
        return;
      }
      const open = row.dataset.expanded !== "true";
      row.dataset.expanded = open ? "true" : "false";
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  row.append(toggle, body);
  const kindEl = toggle.querySelector(".activity-kind");
  const descEl = toggle.querySelector(".activity-desc");
  return {
    row,
    kindEl,
    descEl,
    labelEl: kindEl,
    metaEl: descEl,
    bodyEl: bodyInner,
    toggle,
    tools: [],
  };
}

function flushExploringGroup() {
  if (!state.exploringGroup) {
    return;
  }
  state.exploringGroup.row.dataset.state = "completed";
  setActivityLine(
    state.exploringGroup,
    "Explored",
    formatExploringSummary(state.exploringGroup.tools),
  );
  state.exploringGroup.kindEl?.classList.add("tool-status-settled");
  syncActivityRow(state.exploringGroup);
  state.exploringGroup = null;
}

function upsertExploring(payload) {
  const target = text(payload.explore_target, "");
  const toolName = text(payload.tool_name, "read");
  const nextState = payload.state ?? "running";

  if (!state.exploringGroup) {
    const card = createActivityRow({ mode: "exploring", expandable: true });
    setActivityLine(card, "Exploring", "");
    setActivityBodyContent(card, "");
    state.exploringGroup = { ...card, paths: new Set(), tools: [], toolIds: new Set() };
    appendToTurn(card.row);
    syncActivityRow(card);
  }

  if (target) {
    state.exploringGroup.paths.add(target);
  }
  const toolCallId = text(payload.tool_call_id, "");
  if (toolCallId) {
    if (!state.exploringGroup.toolIds.has(toolCallId)) {
      state.exploringGroup.toolIds.add(toolCallId);
      state.exploringGroup.tools.push(toolName);
    }
  } else {
    state.exploringGroup.tools.push(toolName);
  }
  state.exploringGroup.row.dataset.state = nextState;
  const paths = [...state.exploringGroup.paths].sort((left, right) => left.localeCompare(right));
  const summary = formatExploringSummary(state.exploringGroup.tools);
  setActivityLine(
    state.exploringGroup,
    nextState === "running" ? "Exploring" : "Explored",
    summary,
  );
  setActivityBodyContent(state.exploringGroup, paths.join("\n"), { format: "paths" });
  syncActivityRow(state.exploringGroup);
}

function upsertToolCard(payload, eventType) {
  const displayMode = text(payload.display_mode, "");
  if (displayMode === "exploring") {
    upsertExploring(payload);
    return;
  }
  flushExploringGroup();

  const toolCallId = text(payload.tool_call_id, "");
  if (!toolCallId) {
    return;
  }

  let card = state.activityCards.get(toolCallId);
  if (!card) {
    card = createActivityRow({
      mode: displayMode === "bash" ? "bash" : "tool",
      expandable: true,
    });
    card.row.dataset.toolCallId = toolCallId;
    state.activityCards.set(toolCallId, card);
    appendToTurn(card.row);
  }

  const nextState =
    payload.state ??
    (eventType === "tool_failed" ? "error" : eventType === "tool_completed" ? "completed" : "running");
  card.row.dataset.state = nextState;

  if (displayMode === "bash") {
    const command = text(payload.command, text(payload.title, "bash"));
    setActivityLine(card, "Shell", shellDescFromCommand(command));
    const bodyParts = [];
    if (payload.output_preview) {
      bodyParts.push(payload.output_preview);
    } else {
      bodyParts.push(`\`\`\`bash\n${command}\n\`\`\``);
    }
    setActivityBodyContent(card, bodyParts.join("\n\n"), { format: "markdown" });
    syncActivityRow(card);
    return;
  }

  const toolName = titleize(text(payload.tool_name, "tool"));
  const desc = text(payload.subtitle, text(payload.title, ""));
  setActivityLine(card, toolName, desc);
  if (payload.output_preview) {
    setActivityBodyContent(card, payload.output_preview, { format: "markdown" });
  }
  syncActivityRow(card);
}

function upsertContactCard(payload) {
  flushExploringGroup();
  const toolCallId = text(payload.tool_call_id, "");
  const key = toolCallId || text(payload.job_id, text(payload.title, "contact"));
  let card = state.contactByTool.get(key);
  if (!card) {
    const activity = createActivityRow({
      mode: "contact",
      expandable: true,
      selectable: Boolean(payload.job_id),
    });
    activity.row.dataset.partId = `contact-${key}`;
    activity.row.addEventListener("click", (event) => {
      if (event.target.closest(".activity-toggle")) {
        return;
      }
      const jobId = activity.row.dataset.jobId;
      if (jobId) {
        selectJob(jobId, activity.row.dataset.partId);
      }
    });
    card = activity;
    state.contactByTool.set(key, card);
    appendToTurn(card.row);
  }

  const nextState = text(payload.state, "running");
  card.row.dataset.state = nextState;
  const title = text(payload.title, "Contact");
  const detail = text(payload.detail, "");
  setActivityLine(card, "Shell", title);

  const bodyParts = [];
  if (payload.command) {
    bodyParts.push(`\`\`\`bash\n${payload.command}\n\`\`\``);
  }
  if (payload.output_preview) {
    bodyParts.push(payload.output_preview);
  } else if (detail && detail !== title) {
    bodyParts.push(detail);
  }
  setActivityBodyContent(card, bodyParts.join("\n\n"), { format: "markdown" });

  if (payload.job_id) {
    card.row.dataset.jobId = payload.job_id;
    card.row.classList.add("selectable");
    card.row.setAttribute("role", "button");
    card.row.setAttribute("tabindex", "0");
    card.row.setAttribute("aria-label", "Open evidence details");
  }
  syncActivityRow(card);
}

function upsertJobSnapshot(payload) {
  if (payload.manual_selection && payload.selected_job_id) {
    state.selectedJobId = payload.selected_job_id;
    state.selectedPartId = `job-${payload.selected_job_id}`;
    highlightSelectedPart();
    if (payload.auto_open === true) {
      openInspectorPanel();
      void renderInspector();
    } else if (elements.inspector.classList.contains("open")) {
      void renderInspector();
    }
    return;
  }

  const jobId = text(payload.job_id, "");
  if (!jobId) {
    return;
  }
  const previous = state.jobSnapshots.get(jobId) ?? {};
  state.jobSnapshots.set(jobId, { ...previous, ...payload });

  const card = document.querySelector(`[data-job-card="${jobId}"]`);
  if (card) {
    updateJobCard(card, state.jobSnapshots.get(jobId));
  } else {
    const node = createJobCard(state.jobSnapshots.get(jobId));
    appendToTurn(node);
  }
  if (state.selectedJobId === jobId && elements.inspector.classList.contains("open")) {
    void renderInspector();
  }
}

function createJobCard(snapshot) {
  const card = createActivityRow({ mode: "job", expandable: false, selectable: true });
  card.row.dataset.jobCard = snapshot.job_id;
  card.row.dataset.jobId = snapshot.job_id;
  card.row.dataset.partId = `job-${snapshot.job_id}`;
  card.row.setAttribute("role", "button");
  card.row.setAttribute("tabindex", "0");
  card.row.setAttribute("aria-label", "Open evidence details");
  card.toggle.setAttribute("aria-label", "Open evidence details");
  const openDetails = () => {
    void selectJob(card.row.dataset.jobId, card.row.dataset.partId);
  };
  card.toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    openDetails();
  });
  card.row.addEventListener("click", openDetails);
  card.row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetails();
    }
  });
  updateJobCard(card.row, snapshot);
  return card.row;
}

function updateJobCard(row, snapshot) {
  const kindEl = row.querySelector(".activity-kind");
  const descEl = row.querySelector(".activity-desc");
  const card = { row, kindEl, descEl, bodyEl: row.querySelector(".activity-body-inner"), toggle: row.querySelector(".activity-toggle") };
  row.dataset.state = snapshot.state ?? "running";
  const title =
    snapshot.case_title ??
    snapshot.case_id ??
    snapshot.runner_kind ??
    snapshot.job_id;
  const progress = snapshot.progress ?? 0;
  const bits = [
    titleize(title),
    titleize(snapshot.state),
    `${progress}%`,
    snapshot.verdict ? titleize(snapshot.verdict) : "",
  ].filter(Boolean);
  setActivityLine(card, "Evidence", bits.join(" · "));
  row.dataset.jobId = snapshot.job_id;
  row.classList.toggle("selected", state.selectedPartId === row.dataset.partId);
  syncActivityRow(card);
}

function highlightSelectedPart() {
  document.querySelectorAll(".activity-row.selected").forEach((node) => node.classList.remove("selected"));
  if (!state.selectedPartId) {
    return;
  }
  const selected = document.querySelector(`[data-part-id="${state.selectedPartId}"]`);
  if (selected) {
    selected.classList.add("selected");
  }
}

async function selectJob(jobId, partId, options = {}) {
  if (!jobId) {
    return;
  }
  state.selectedJobId = jobId;
  state.selectedPartId = partId ?? `job-${jobId}`;
  highlightSelectedPart();
  openInspectorPanel();
  if (options.notifyServer !== false) {
    await fetchJson("/api/operator/select-job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
  }
  await renderInspector();
}

function runnerLabel(kind) {
  if (kind === "static-source-evidence") {
    return "Static PX4 source evidence";
  }
  if (kind === "mavlink-parser-fuzz") {
    return "MAVLink parser library fuzz";
  }
  if (kind === "px4-sitl-probe") {
    return "PX4 SITL runtime probe";
  }
  if (kind === "px4-runtime-replay") {
    return "PX4 runtime replay";
  }
  return titleize(kind);
}

function detailBlock(title, innerHtml) {
  return `<section class="detail-block"><h3>${escapeHtml(title)}</h3>${innerHtml}</section>`;
}

function detailRows(rows) {
  return `<dl class="detail-list">${rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`)
    .join("")}</dl>`;
}

function renderInspectorFromSnapshot(snapshot) {
  const caveats = Array.isArray(snapshot.caveats) ? snapshot.caveats : [];
  const artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
  const caveatHtml =
    caveats.length > 0
      ? `<ul class="caveat-list">${caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "<p>No caveats recorded yet.</p>";

  const artifactHtml =
    artifacts.length > 0
      ? `${artifacts
          .map(
            (artifact) =>
              `<button type="button" class="artifact-link" data-artifact="${escapeHtml(artifact.name)}">${escapeHtml(artifact.name)}</button>`,
          )
          .join("")}<div class="artifact-preview" hidden></div>`
      : "<p class=\"part-detail\">Pending</p>";

  elements.inspectorTitle.textContent = snapshot.case_title ?? titleize(snapshot.case_id ?? "Evidence");
  elements.inspectorSubtitle.textContent = snapshot.job_id ?? "";
  elements.inspectorBody.innerHTML = [
    detailRows([
      ["Job", `<span class="mono">${escapeHtml(text(snapshot.job_id))}</span>`],
      ["Case", escapeHtml(text(snapshot.case_id))],
      ["Runner", escapeHtml(runnerLabel(snapshot.runner_kind))],
      ["State", `${escapeHtml(titleize(snapshot.state))} · ${escapeHtml(text(snapshot.progress, "0"))}%`],
      ["Verdict", escapeHtml(titleize(snapshot.verdict))],
      ["Confidence", escapeHtml(titleize(snapshot.confidence))],
      ["Commit", `<span class="mono">${escapeHtml(text(snapshot.resolved_commit_hash))}</span>`],
      [
        "PR",
        snapshot.pr_url
          ? `<a href="${escapeHtml(snapshot.pr_url)}" target="_blank" rel="noreferrer">Open</a>`
          : "—",
      ],
    ]),
    snapshot.summary ? detailBlock("Summary", `<p class="part-detail">${escapeHtml(snapshot.summary)}</p>`) : "",
    detailBlock("Caveats", caveatHtml),
    detailBlock("Artifacts", artifactHtml),
    state.transcript?.run_dir
      ? detailBlock(
          "Transcript",
          `<p class="part-detail mono">${escapeHtml(state.transcript.run_dir)}</p>`,
        )
      : "",
    renderInspectorExtras(snapshot),
  ].join("");

  elements.inspectorBody.querySelectorAll("[data-artifact]").forEach((button) => {
    button.addEventListener("click", async () => {
      const name = button.getAttribute("data-artifact");
      const preview = elements.inspectorBody.querySelector(".artifact-preview");
      preview.hidden = false;
      preview.textContent = "Loading artifact preview…";
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(snapshot.job_id)}/artifacts/${encodeURIComponent(name)}`,
        { cache: "no-store" },
      );
      const content = await response.text();
      if (!response.ok) {
        preview.textContent = content || `Could not load ${name}`;
        return;
      }
      preview.textContent = content;
    });
  });
}

async function renderInspector() {
  const jobId = state.selectedJobId;
  if (!jobId) {
    closeInspectorPanel();
    return;
  }

  const cached = state.jobSnapshots.get(jobId);
  if (cached?.stub || cached?.unavailable) {
    renderInspectorFromSnapshot(cached);
    return;
  }

  const { response, payload } = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!response.ok) {
    renderInspectorFromSnapshot(
      cached ?? {
        job_id: jobId,
        unavailable: true,
        summary: "Evidence details are not available on this machine yet.",
        caveats: ["Local runner dependencies or run folders may be missing."],
      },
    );
    return;
  }

  const detail = payload;
  const result = detail.result ?? {};
  const staticSource = result.static_source ?? {};
  let pairLinks = "";
  let bundleLinks = "";
  try {
    const pairsPayload = await fetchJson("/api/pairs");
    const pairs = pairsPayload.payload.pairs ?? [];
    const relatedPairs = pairs.filter(
      (pair) => pair.pre_patch_job_id === jobId || pair.post_patch_job_id === jobId,
    );
    if (relatedPairs.length > 0) {
      pairLinks = `<ul class="link-list">${relatedPairs
        .map((pair) => `<li><a href="/pair.html?pair_id=${encodeURIComponent(pair.pair_id)}">${pair.pair_id}</a></li>`)
        .join("")}</ul>`;
    }
    const bundlesPayload = await fetchJson("/api/bundles");
    const bundles = bundlesPayload.payload.bundles ?? [];
    const relatedBundles = bundles.filter((bundle) => bundle.job_id === jobId);
    if (relatedBundles.length > 0) {
      bundleLinks = `<ul class="link-list">${relatedBundles
        .map(
          (bundle) =>
            `<li><a href="/bundle.html?bundle_id=${encodeURIComponent(bundle.bundle_id)}">${bundle.bundle_id}</a></li>`,
        )
        .join("")}</ul>`;
    }
  } catch {
    // secondary references are optional
  }
  renderInspectorFromSnapshot({
    job_id: jobId,
    case_id: detail.case_id ?? staticSource.case_id,
    case_title: detail.case_title ?? detail.resolved_case?.title,
    runner_kind: detail.runner_kind ?? result.runner_kind,
    state: detail.state,
    phase: detail.phase,
    progress: detail.progress,
    verdict: detail.verdict ?? result.verdict,
    confidence: result.confidence,
    summary: result.summary ?? detail.summary,
    caveats: result.cautions ?? [],
    resolved_commit_hash:
      detail.resolved_commit_hash ??
      staticSource.resolved_commit_hash ??
      result.px4_runtime_replay?.resolved_commit_hash,
    pr_url: staticSource.pr_url ?? result.pr_url,
    artifacts: detail.artifacts ?? [],
    pairLinks,
    bundleLinks,
  });
}

function renderInspectorExtras(snapshot) {
  const extras = [];
  if (snapshot.pairLinks) {
    extras.push(detailBlock("Pairs", snapshot.pairLinks));
  }
  if (snapshot.bundleLinks) {
    extras.push(detailBlock("Bundles", snapshot.bundleLinks));
  }
  return extras.join("");
}

function resetTimelineForSessionView() {
  flushExploringGroup();
  state.activityCards.clear();
  state.contactByTool.clear();
  state.jobSnapshots.clear();
  state.selectedJobId = null;
  state.selectedPartId = null;
  state.currentTurn = null;
  state.thinkingRow = null;
  state.thinkingBuffer = "";
  state.thinkingStartedAt = null;
  state.thinkingDurationMs = null;
  resetStreamPacers();
  elements.timeline.innerHTML = "";
}

function formatSessionWhen(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function clearPendingDelete() {
  if (state.pendingDeleteTimer) {
    clearTimeout(state.pendingDeleteTimer);
    state.pendingDeleteTimer = null;
  }
  state.pendingDeleteSessionId = null;
}

function armSessionDelete(sessionId) {
  if (state.pendingDeleteSessionId === sessionId) {
    void deleteSession(sessionId);
    return;
  }
  clearPendingDelete();
  state.pendingDeleteSessionId = sessionId;
  state.pendingDeleteTimer = setTimeout(() => {
    clearPendingDelete();
    renderSessionList();
  }, 3200);
  renderSessionList();
}

async function deleteSession(sessionId) {
  clearPendingDelete();
  const { response, payload } = await fetchJson(
    `/api/operator/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
  if (response.status === 409 && payload.error === "session_busy") {
    setNotice("Wait for the session to finish before deleting it.", "warn");
    return;
  }
  if (!response.ok) {
    setNotice(text(payload.error, "Could not delete session."), "error");
    return;
  }
  if (payload.state) {
    state.session = payload.state;
  }
  const wasViewing = state.viewingSessionId === sessionId;
  await refreshSessionCatalog();
  if (wasViewing) {
    state.viewingSessionId = state.session.session_id ?? null;
    state.playbackMode = false;
    resetTimelineForSessionView();
    if (state.session.session_id) {
      await activateSession(state.session.session_id, { skipInspector: true });
    } else {
      ensureTimelineVisible();
      setSessionMode(false);
      setComposerEnabled(true);
      closeInspectorPanel();
    }
  }
  renderSessionList();
}

function renderDemoPendingSessionItem() {
  const shell = document.createElement("div");
  shell.className = "session-item-shell is-active";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-item";
  button.disabled = true;
  const title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = "Parser bounds demo";
  const meta = document.createElement("span");
  meta.className = "session-item-meta";
  const phase =
    state.session.phase === "running" || state.session.phase === "starting"
      ? state.session.phase
      : "starting";
  meta.textContent = `${titleize(phase)} · now`;
  button.append(title, meta);
  shell.append(button);
  return shell;
}

function renderSessionList() {
  if (!elements.sessionList) {
    return;
  }
  const liveId = state.session?.session_id ?? null;
  const activeId = state.demoLaunching ? "demo-pending" : state.viewingSessionId ?? liveId;
  const pendingDeleteId = state.pendingDeleteSessionId;
  elements.sessionList.replaceChildren();

  if (state.demoLaunching && (!liveId || liveId !== state.viewingSessionId)) {
    elements.sessionList.append(renderDemoPendingSessionItem());
  }

  if (state.sessionCatalog.length === 0 && !state.demoLaunching) {
    const empty = document.createElement("p");
    empty.className = "session-list-empty";
    empty.textContent = "Past chats appear here after you send a prompt.";
    elements.sessionList.append(empty);
    return;
  }
  for (const entry of state.sessionCatalog) {
    const shell = document.createElement("div");
    shell.className = "session-item-shell";
    if (entry.session_id === activeId) {
      shell.classList.add("is-active");
    }
    if (entry.session_id === pendingDeleteId) {
      shell.classList.add("is-delete-pending");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    const title = document.createElement("span");
    title.className = "session-item-title";
    title.textContent = entry.title || "Untitled session";
    const meta = document.createElement("span");
    meta.className = "session-item-meta";
    const phase =
      entry.session_id === liveId && (state.session.phase === "running" || state.session.phase === "starting")
        ? state.session.phase
        : entry.phase;
    meta.textContent = `${titleize(phase)} · ${formatSessionWhen(entry.updated_at)}`;
    button.append(title, meta);
    button.addEventListener("click", () => {
      clearPendingDelete();
      void activateSession(entry.session_id);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-item-delete";
    deleteButton.textContent = entry.session_id === pendingDeleteId ? "Confirm" : "Delete";
    deleteButton.setAttribute(
      "aria-label",
      entry.session_id === pendingDeleteId ? "Confirm delete session" : "Delete session",
    );
    if (entry.session_id === pendingDeleteId) {
      deleteButton.classList.add("is-armed");
    }
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      armSessionDelete(entry.session_id);
    });

    shell.append(button, deleteButton);
    elements.sessionList.append(shell);
  }
}

async function refreshSessionCatalog() {
  const { payload } = await fetchJson("/api/operator/sessions");
  state.sessionCatalog = payload.sessions ?? [];
  if (payload.state) {
    state.session = payload.state;
  }
  if (!state.viewingSessionId && state.session.session_id) {
    state.viewingSessionId = state.session.session_id;
  }
  renderSessionList();
}

async function activateSession(sessionId, options = {}) {
  if (!sessionId) {
    return;
  }
  state.viewingSessionId = sessionId;
  persistViewingSessionId();
  const liveId = state.session?.session_id ?? null;
  const isLive = sessionId === liveId;
  state.playbackMode = !isLive;
  state.replayedEventIds.clear();
  resetTimelineForSessionView();
  const { payload } = await fetchJson(`/api/operator/sessions/${encodeURIComponent(sessionId)}/events`);
  const events = payload.events ?? [];
  const livePhase = state.session?.phase ?? "completed";
  const shouldCatchUp = !isLive || livePhase === "running" || livePhase === "starting";
  if (shouldCatchUp) {
    setStreamCatchUp(true);
  }
  for (const event of events) {
    markEventSeen(event);
    handleOperatorEvent(event, { replay: true });
  }
  if (shouldCatchUp) {
    setStreamCatchUp(false);
  }
  const phase = isLive ? state.session.phase : "completed";
  setSessionMode(isLive && phase !== "idle");
  if (!isLive) {
    setComposerEnabled(false);
    stopLiveSessionSync();
  } else if (phase === "running" || phase === "starting") {
    updateComposerChrome();
    startLiveSessionSync();
  } else {
    setComposerEnabled(true);
    stopLiveSessionSync();
  }
  closeInspectorPanel();
  renderSessionList();
  syncDemoButtonVisibility();
}

async function startNewChat() {
  const { response, payload } = await fetchJson("/api/operator/new-session", { method: "POST" });
  if (response.status === 409) {
    setNotice("The current session is still running. Press Stop before starting a new chat.", "warn");
    return;
  }
  stopLiveSessionSync();
  state.session = payload.state ?? state.session;
  state.viewingSessionId = null;
  state.demoLaunching = false;
  state.demoViewPrepared = false;
  persistViewingSessionId();
  state.playbackMode = false;
  state.stubSession = false;
  resetTimelineForSessionView();
  ensureTimelineVisible();
  setSessionMode(false);
  setComposerEnabled(true);
  closeInspectorPanel();
  clearNotice();
  await refreshSessionCatalog();
  elements.promptInput.focus();
}

function handleOperatorEvent(event, options = {}) {
  try {
    handleOperatorEventInner(event, options);
  } catch (error) {
    console.error("operator event failed", event?.type, error);
  }
}

function handleOperatorEventInner(event, options = {}) {
  if (!options.force && !options.replay && shouldSkipDuplicateEvent(event)) {
    return;
  }
  markEventSeen(event);
  const payload = event.payload ?? {};
  const replay = options.replay === true;
  if (payload.stub === true) {
    state.stubSession = true;
    if (!replay) {
      setNotice("Stub session — simulated stream, not live Pi evidence.", "warn");
    }
  }

  switch (event.type) {
    case "session_started":
      if (!replay && payload.stub !== true) {
        state.stubSession = false;
      }
      setSessionMode(true);
      if (!replay && !state.stubSession) {
        clearNotice();
      }
      if (!replay) {
        updateComposerChrome();
      }
      flushExploringGroup();
      if (payload.continuation !== true && !replay && !state.demoViewPrepared) {
        state.activityCards.clear();
        state.contactByTool.clear();
        state.jobSnapshots.clear();
        state.selectedJobId = null;
        state.selectedPartId = null;
        state.thinkingRow = null;
        state.thinkingBuffer = "";
        elements.timeline.innerHTML = "";
      }
      if (!state.demoViewPrepared) {
        state.currentTurn = null;
      }
      break;
    case "user_prompt": {
      const promptText = text(payload.prompt);
      const existingUser = state.currentTurn?.querySelector('[data-component="user-message"] .message.user');
      if (existingUser && existingUser.textContent === promptText) {
        break;
      }
      beginTurn();
      createMessage("user", promptText, { queued: payload.queued === true });
      break;
    }
    case "assistant_text_start":
      beginAssistantMessage();
      break;
    case "assistant_text_delta":
      appendAssistantDelta(text(payload.delta, ""));
      break;
    case "assistant_text_end":
      finishAssistantMessage();
      break;
    case "thinking_status":
      if (payload.status === "thinking") {
        state.thinkingStartedAt = Date.now();
        setThinking(true, "Thinking");
      } else if (payload.status === "model_fallback") {
        setThinking(true, typeof payload.message === "string" ? payload.message : "Model fallback");
      } else {
        settleThinkingRow();
      }
      break;
    case "thinking_delta":
      break;
    case "thinking_end":
      if (typeof payload.duration_ms === "number" && payload.duration_ms > 0) {
        state.thinkingDurationMs = payload.duration_ms;
      } else if (state.thinkingStartedAt) {
        state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
      }
      state.thinkingStartedAt = null;
      settleThinkingRow();
      break;
    case "tool_started":
    case "tool_updated":
    case "tool_completed":
    case "tool_failed":
      upsertToolCard(payload, event.type);
      break;
    case "contact_cli":
      upsertContactCard(payload);
      break;
    case "evidence_job_updated":
      upsertJobSnapshot(payload);
      break;
    case "follow_up_queued":
      if (payload.state) {
        state.session = payload.state;
      }
      state.followUpCount = Number(payload.queue_length ?? state.session.follow_up_count ?? 0);
      if (!replay) {
        updateComposerChrome();
      }
      break;
    case "session_aborted":
      if (payload.state) {
        state.session = payload.state;
      }
      state.session.phase = "completed";
      state.followUpCount = 0;
      settleThinkingRow();
      flushExploringGroup();
      if (!replay) {
        clearComposerHint();
        setComposerEnabled(true);
        setNotice("Generation stopped.", "warn");
      }
      break;
    case "session_ready":
      if (payload.state) {
        state.session = payload.state;
      }
      break;
    case "session_failed":
      state.session.phase = "failed";
      settleThinkingRow();
      setComposerEnabled(true);
      if (payload.auth_recovery) {
        setNotice(payload.auth_recovery, "error");
      } else {
        setNotice(text(payload.error_message, "Session failed."), "error");
      }
      break;
    case "transcript_written":
      state.transcript = payload;
      if (state.selectedJobId) {
        void renderInspector();
      }
      break;
    case "session_completed":
      state.session = payload.state ?? state.session;
      state.session.phase = payload.status === "succeeded" ? "completed" : "failed";
      state.followUpCount = 0;
      state.demoLaunching = false;
      state.demoViewPrepared = false;
      if (!replay && state.session.session_id && !assistantMessageHasContent()) {
        void ensureAssistantSummary(state.session.session_id);
      }
      stopLiveSessionSync();
      settleThinkingRow();
      flushExploringGroup();
      state.currentTurn = null;
      if (!replay) {
        if (payload.interrupted) {
          setNotice("Generation stopped.", "warn");
        } else if (payload.stub || state.stubSession) {
          if (state.session.selected_job_id) {
            state.selectedJobId = state.session.selected_job_id;
            state.selectedPartId = `job-${state.session.selected_job_id}`;
            highlightSelectedPart();
          }
          setNotice("Demo complete — simulated stream finished.");
        }
        clearComposerHint();
        setComposerEnabled(true);
        void refreshSessionCatalog();
      }
      updateStatusPill();
      updateComposerChrome();
      break;
    default:
      break;
  }

  if (payload.state) {
    const incoming = payload.state;
    const current = state.session ?? {};
    const currentTerminal = current.phase === "completed" || current.phase === "failed";
    const incomingTerminal = incoming.phase === "completed" || incoming.phase === "failed";
    if (!currentTerminal || incomingTerminal) {
      state.session = { ...current, ...incoming };
    }
  }
  updateStatusPill();
  if (!replay && event.type === "session_started" && state.session.session_id) {
    state.viewingSessionId = state.session.session_id;
    state.demoLaunching = false;
    persistViewingSessionId();
    state.playbackMode = false;
    renderSessionList();
    startLiveSessionSync();
  }
}

function shouldAcceptLiveEvent(event) {
  const eventSessionId = event?.session_id;
  const liveId = state.session?.session_id ?? null;
  if (state.demoViewPrepared && state.viewingSessionId === "demo-pending" && eventSessionId && eventSessionId !== "none") {
    if (!liveId || liveId !== eventSessionId) {
      state.session = {
        ...state.session,
        session_id: eventSessionId,
        phase: state.session.phase === "idle" || state.session.phase === "completed" ? "starting" : state.session.phase,
      };
    }
    return true;
  }
  if (!liveId) {
    return !state.playbackMode;
  }
  if (state.playbackMode && state.viewingSessionId !== liveId) {
    return false;
  }
  if (eventSessionId && eventSessionId !== liveId && eventSessionId !== "none") {
    return false;
  }
  return true;
}

function hasRunningShellRows() {
  return Boolean(
    document.querySelector('#timeline .activity-row[data-state="running"]:not([data-mode="exploring"])'),
  );
}

const TIMELINE_RECONCILE_EVENT_TYPES = new Set([
  "tool_started",
  "tool_updated",
  "tool_completed",
  "tool_failed",
  "contact_cli",
  "evidence_job_updated",
]);

async function reconcileToolStatesFromLog(sessionId) {
  if (!sessionId) {
    return;
  }
  const { payload } = await fetchJson(`/api/operator/sessions/${encodeURIComponent(sessionId)}/events`);
  const events = payload.events ?? [];
  const latestByKey = new Map();
  for (const event of events) {
    if (!TIMELINE_RECONCILE_EVENT_TYPES.has(event.type)) {
      continue;
    }
    const toolCallId = event.payload?.tool_call_id;
    const jobId = event.payload?.job_id;
    const key = toolCallId ? `tool:${toolCallId}` : jobId ? `job:${jobId}` : `${event.type}:${event.id}`;
    latestByKey.set(key, event);
  }
  if (latestByKey.size === 0) {
    return;
  }
  setStreamCatchUp(true);
  for (const event of latestByKey.values()) {
    handleOperatorEvent(event, { replay: true, force: true });
  }
  setStreamCatchUp(false);
}

async function ensureAssistantSummary(sessionId) {
  if (!sessionId || assistantMessageHasContent()) {
    return;
  }
  try {
    const { payload } = await fetchJson(`/api/operator/sessions/${encodeURIComponent(sessionId)}/events`);
    const answer = assistantTextFromEvents(payload.events ?? []);
    if (answer.trim()) {
      renderAssistantText(answer);
    }
  } catch (error) {
    console.error("assistant summary fetch failed", error);
  }
}

async function replayMissedSessionEvents(sessionId = resolveActiveSessionId()) {
  if (!sessionId) {
    return;
  }
  try {
    const { payload } = await fetchJson(`/api/operator/sessions/${encodeURIComponent(sessionId)}/events`);
    const missed = (payload.events ?? []).filter((event) => !shouldSkipDuplicateEvent(event));
    if (missed.length === 0) {
      return;
    }
    setStreamCatchUp(true);
    for (const event of missed) {
      handleOperatorEvent(event, { replay: true });
    }
  } catch {
    // ignore transient replay failures
  } finally {
    setStreamCatchUp(false);
  }
}

async function syncLiveSessionView() {
  if (
    state.playbackMode &&
    state.viewingSessionId &&
    state.session?.session_id &&
    state.viewingSessionId !== state.session.session_id &&
    state.viewingSessionId !== "demo-pending"
  ) {
    return;
  }

  try {
    const { payload: statePayload } = await fetchJson("/api/operator/state");
    if (!statePayload.state) {
      return;
    }
    state.session = statePayload.state;
    const sessionId = state.session.session_id ?? resolveActiveSessionId();
    if (!sessionId) {
      return;
    }
    const phase = state.session.phase ?? "idle";
    if (phase === "idle") {
      stopLiveSessionSync();
      return;
    }

    if (!state.playbackMode && state.viewingSessionId !== sessionId) {
      state.viewingSessionId = sessionId;
      persistViewingSessionId();
      state.demoLaunching = false;
      renderSessionList();
    } else if (!state.viewingSessionId || state.viewingSessionId === "demo-pending") {
      state.viewingSessionId = sessionId;
      persistViewingSessionId();
      state.demoLaunching = false;
      renderSessionList();
    }

    const terminal = phase === "completed" || phase === "failed";
    if (!state.sseConnected) {
      await replayMissedSessionEvents(sessionId);
    }

    updateStatusPill();

    if (terminal) {
      const shouldUseHistoryCatchUp = !state.sseConnected;
      if (shouldUseHistoryCatchUp && !assistantMessageHasContent()) {
        await ensureAssistantSummary(sessionId);
      }
      if (shouldUseHistoryCatchUp && hasRunningShellRows()) {
        await reconcileToolStatesFromLog(sessionId);
      }
      stopLiveSessionSync();
      state.demoLaunching = false;
      state.demoViewPrepared = false;
      if (!state.playbackMode && state.stubSession) {
        if (state.session.selected_job_id) {
          state.selectedJobId = state.session.selected_job_id;
          state.selectedPartId = `job-${state.session.selected_job_id}`;
          highlightSelectedPart();
        }
        setNotice("Demo complete — simulated stream finished.");
      }
      setComposerEnabled(true);
      void refreshSessionCatalog();
      updateStatusPill();
      updateComposerChrome();
    }
  } catch {
    // ignore transient sync failures; next tick retries
  }
}

function liveSyncIntervalMs() {
  return state.sseConnected ? 2000 : 500;
}

function startLiveSessionSync() {
  stopLiveSessionSync();
  void syncLiveSessionView();
  state.liveSyncTimer = window.setInterval(() => {
    void syncLiveSessionView();
  }, liveSyncIntervalMs());
}

function restartLiveSessionSyncInterval() {
  if (!state.liveSyncTimer) {
    return;
  }
  window.clearInterval(state.liveSyncTimer);
  state.liveSyncTimer = window.setInterval(() => {
    void syncLiveSessionView();
  }, liveSyncIntervalMs());
}

function stopLiveSessionSync() {
  if (state.liveSyncTimer) {
    window.clearInterval(state.liveSyncTimer);
    state.liveSyncTimer = null;
  }
}

async function catchUpLiveSessionEvents() {
  await syncLiveSessionView();
}

function connectEvents() {
  if (state.sse) {
    state.sse.close();
  }
  const source = new EventSource("/api/operator/events");
  state.sse = source;

  source.onopen = () => {
    state.sseConnected = true;
    state.sseEverConnected = true;
    if (!state.stubSession) {
      clearNotice();
    } else if (elements.sessionNotice.textContent?.includes("Stream disconnected")) {
      setNotice("Stub session — simulated stream, not live Pi evidence.", "warn");
    }
    updateStatusPill();
    restartLiveSessionSyncInterval();
    if (state.sseNeedsCatchUp) {
      void replayMissedSessionEvents().then(() => {
        state.sseNeedsCatchUp = false;
      });
    }
  };

  source.onerror = () => {
    state.sseConnected = false;
    state.sseNeedsCatchUp = true;
    if (state.sseEverConnected) {
      setNotice("Stream disconnected. Reconnecting…", "warn");
    }
    updateStatusPill();
    startLiveSessionSync();
    restartLiveSessionSyncInterval();
  };

  const dispatchLiveEvent = (raw) => {
    try {
      const event = JSON.parse(raw);
      state.sseConnected = true;
      if (!shouldAcceptLiveEvent(event)) {
        return;
      }
      if (state.playbackMode && event.session_id === state.session?.session_id) {
        state.playbackMode = false;
        state.viewingSessionId = event.session_id;
      }
      handleOperatorEvent(event);
    } catch {
      // ignore malformed frames
    }
  };

  source.onmessage = (message) => {
    dispatchLiveEvent(message.data);
  };

  ["session_started", "session_ready", "session_failed", "session_completed"].forEach((name) => {
    source.addEventListener(name, (message) => {
      dispatchLiveEvent(message.data);
    });
  });

  const forwardTypes = [
    "user_prompt",
    "assistant_text_start",
    "assistant_text_delta",
    "assistant_text_end",
    "thinking_status",
    "thinking_delta",
    "thinking_end",
    "tool_started",
    "tool_updated",
    "tool_completed",
    "tool_failed",
    "contact_cli",
    "evidence_job_updated",
    "transcript_written",
    "follow_up_queued",
    "session_aborted",
  ];
  forwardTypes.forEach((name) => {
    source.addEventListener(name, (message) => {
      dispatchLiveEvent(message.data);
    });
  });
}

async function refreshState() {
  restoreViewingSessionId();
  const { payload } = await fetchJson("/api/operator/state");
  state.session = payload.state ?? state.session;
  state.followUpCount = state.session.follow_up_count ?? 0;
  state.hasSentPrompt = Boolean(state.session.session_id);
  if (state.session.phase === "starting" || state.session.phase === "running") {
    setSessionMode(true);
    setNotice("Session in progress on this server.", "warn");
    updateComposerChrome();
    startLiveSessionSync();
  } else {
    setComposerEnabled(true);
  }
  const phase = state.session.phase ?? "idle";
  await refreshSessionCatalog();
  const targetSessionId = state.viewingSessionId ?? state.session.session_id;
  if (targetSessionId && phase !== "idle") {
    await activateSession(targetSessionId, { skipInspector: true });
  } else if (targetSessionId && state.viewingSessionId && state.viewingSessionId !== state.session.session_id) {
    await activateSession(state.viewingSessionId, { skipInspector: true });
  }
  if (
    state.session.selected_job_id &&
    (phase === "running" || phase === "starting" || phase === "completed")
  ) {
    state.selectedJobId = state.session.selected_job_id;
    state.selectedPartId = `job-${state.session.selected_job_id}`;
    highlightSelectedPart();
  }
  updateStatusPill();
  syncDemoButtonVisibility();
}

elements.inspectorClose.addEventListener("click", () => {
  closeInspectorPanel();
});

elements.inspectorBackdrop.addEventListener("click", () => {
  closeInspectorPanel();
});

elements.newSessionButton?.addEventListener("click", () => {
  void startNewChat();
});

elements.sessionSidebarHide?.addEventListener("click", () => {
  setSessionSidebarCollapsed(true);
});

elements.sessionSidebarShow?.addEventListener("click", () => {
  setSessionSidebarCollapsed(false);
});

async function loadConfig() {
  const { payload } = await fetchJson("/api/operator/config");
  state.config = payload;
  if (elements.sessionDemoButton) {
    elements.sessionDemoButton.title = "Run the canonical parser-bounds demo.";
  }
}

function prepareDemoSessionView(demoPrompt) {
  state.stubSession = stubFromUrl;
  state.demoLaunching = true;
  state.demoViewPrepared = true;
  state.playbackMode = false;
  state.viewingSessionId = "demo-pending";
  state.replayedEventIds.clear();
  resetTimelineForSessionView();
  ensureTimelineVisible();
  closeInspectorPanel();
  setSessionMode(true);
  setComposerEnabled(false);
  if (stubFromUrl) {
    setNotice("Stub session — simulated stream, not live Pi evidence.", "warn");
  } else {
    clearNotice();
  }
  beginTurn();
  createMessage("user", demoPrompt);
  renderSessionList();
  startLiveSessionSync();
  updateStatusPill();
}

async function runDemo() {
  const demoPrompt = state.config?.demo_prompt;
  if (!demoPrompt) {
    setNotice("Demo prompt is not configured.", "warn");
    return;
  }
  if (isSessionWorking() || state.demoLaunching) {
    setNotice("Wait for the current turn to finish, or press Stop.", "warn");
    return;
  }
  prepareDemoSessionView(demoPrompt);
  await submitPrompt(demoPrompt, { stub: stubFromUrl, fresh: true });
}

const urlParams = new URL(window.location.href).searchParams;
const stubFromUrl = urlParams.get("stub") === "1";
const initialJobIdFromUrl = urlParams.get("job_id");

async function abortSession() {
  const { response, payload } = await fetchJson("/api/operator/stop", { method: "POST" });
  if (!response.ok) {
    setNotice(text(payload.error, "Could not stop session."), "warn");
    return;
  }
  if (payload.state) {
    state.session = payload.state;
  }
  state.session.phase = "completed";
  state.followUpCount = 0;
  state.demoLaunching = false;
  state.demoViewPrepared = false;
  stopLiveSessionSync();
  clearComposerHint();
  updateComposerChrome();
}

async function submitPrompt(prompt, options = {}) {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return;
  }
  if (isSessionWorking()) {
    clearNotice();
    const body = { prompt: trimmed };
    if (options.stub || stubFromUrl || state.stubSession) {
      body.stub = true;
    }
    const { response, payload } = await fetchJson("/api/operator/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setNotice(text(payload.error, "Could not queue follow-up."), "warn");
      return;
    }
    state.session = payload.state ?? state.session;
    state.followUpCount = state.session.follow_up_count ?? state.followUpCount;
    elements.promptInput.value = "";
    resizePromptInput();
    updateComposerChrome();
    return;
  }
  clearNotice();
  const body = { prompt: trimmed };
  if (options.stub || stubFromUrl) {
    body.stub = true;
  }
  if (options.fresh) {
    body.fresh = true;
  }
  if (options.stub || stubFromUrl) {
    state.stubSession = true;
  }
  const { response, payload } = await fetchJson("/api/operator/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 409) {
    setNotice(text(payload.error, "Prompt was not accepted."), "warn");
    return;
  }
  if (!response.ok) {
    setNotice(text(payload.error, "Could not start session."), "error");
    return;
  }
  state.hasSentPrompt = true;
  state.session = payload.state ?? state.session;
  state.viewingSessionId = state.session.session_id ?? state.viewingSessionId;
  state.demoLaunching = false;
  persistViewingSessionId();
  state.playbackMode = false;
  state.followUpCount = state.session.follow_up_count ?? 0;
  elements.promptInput.value = "";
  resizePromptInput();
  updateComposerChrome();
  setSessionMode(true);
  syncDemoButtonVisibility();
  renderSessionList();
  startLiveSessionSync();
  void refreshSessionCatalog();
  const { distanceFromBottom } = readTimelineScroll();
  if (!state.userScrolledAway && distanceFromBottom < 96) {
    state.scrollPinned = true;
    scrollTimeline();
  } else {
    markUserScrolledAway();
  }
}

elements.sendButton.addEventListener("click", () => {
  if (isSessionWorking()) {
    void abortSession();
    return;
  }
  void submitPrompt(elements.promptInput.value);
});

elements.sessionDemoButton?.addEventListener("click", () => {
  void runDemo();
});

elements.promptInput.addEventListener("input", () => {
  schedulePromptResize();
  syncSendButton();
});

elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitPrompt(elements.promptInput.value);
    return;
  }
  if (event.key === "Enter" && event.shiftKey) {
    schedulePromptResize();
  }
});

if (stubFromUrl) {
  setNotice("Stub mode — use Demo to preview the stream.", "warn");
}

elements.timeline.addEventListener(
  "scroll",
  () => {
    syncScrollFollowState();
  },
  { passive: true },
);

elements.timeline.addEventListener(
  "wheel",
  (event) => {
    if (event.deltaY < 0) {
      markUserScrolledAway();
    }
  },
  { passive: true },
);

elements.timeline.addEventListener(
  "touchstart",
  () => {
    state.touchScrollStartTop = elements.timeline.scrollTop;
  },
  { passive: true },
);

elements.timeline.addEventListener(
  "touchmove",
  () => {
    if (elements.timeline.scrollTop < (state.touchScrollStartTop ?? 0) - 2) {
      markUserScrolledAway();
    }
  },
  { passive: true },
);

elements.jumpBottom?.addEventListener("click", () => {
  scrollTimeline(true);
});

void (async function init() {
  restoreSessionSidebarCollapsed();
  await loadConfig();
  await refreshState();
  connectEvents();
  resizePromptInput();
  updateComposerChrome();
  updateJumpButton();
  renderSessionList();
  if (initialJobIdFromUrl) {
    await selectJob(initialJobIdFromUrl, undefined, { notifyServer: false });
  }
})();
