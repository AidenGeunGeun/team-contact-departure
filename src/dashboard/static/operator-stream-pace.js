/**
 * OpenCode createPacedValue — 24ms paced text drain with adaptive step + snap.
 * @see packages/ui/src/components/message-part.tsx (OpenCode)
 */
export const TEXT_RENDER_PACE_MS = 24;
export const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/;

function step(size) {
  if (size <= 12) {
    return 2;
  }
  if (size <= 48) {
    return 4;
  }
  if (size <= 96) {
    return 8;
  }
  return Math.min(24, Math.ceil(size / 8));
}

function nextRevealIndex(text, start) {
  const end = Math.min(text.length, start + step(text.length - start));
  const max = Math.min(text.length, end + 8);
  for (let index = end; index < max; index += 1) {
    if (TEXT_RENDER_SNAP.test(text[index] ?? "")) {
      return index + 1;
    }
  }
  return end;
}

/**
 * Presentation clock for a growing target string (OpenCode createPacedValue).
 */
export function createPacedValue(options) {
  const { getTarget, onRender } = options;
  let shown = "";
  let timeoutId = 0;
  let streaming = true;

  function clearTimer() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = 0;
    }
  }

  function sync(text) {
    shown = text;
    onRender(shown, { streaming, done: shown.length >= getTarget().length });
  }

  function run() {
    timeoutId = 0;
    const text = getTarget();

    if (!streaming) {
      sync(text);
      return;
    }

    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text);
      return;
    }

    const end = nextRevealIndex(text, shown.length);
    sync(text.slice(0, end));

    if (end < text.length) {
      timeoutId = setTimeout(run, TEXT_RENDER_PACE_MS);
    }
  }

  function schedule() {
    const text = getTarget();

    if (!streaming) {
      clearTimer();
      sync(text);
      return;
    }

    if (!text.startsWith(shown) || text.length < shown.length) {
      clearTimer();
      sync(text);
      return;
    }

    if (text.length === shown.length || timeoutId) {
      return;
    }

    timeoutId = setTimeout(run, TEXT_RENDER_PACE_MS);
  }

  return {
    setStreaming(value) {
      streaming = Boolean(value);
      if (!streaming) {
        clearTimer();
        sync(getTarget());
        return;
      }
      schedule();
    },
    notifyTargetChanged() {
      schedule();
    },
    flush() {
      clearTimer();
      sync(getTarget());
    },
    reset() {
      clearTimer();
      shown = "";
      streaming = true;
    },
    getShown() {
      return shown;
    },
  };
}

/** Legacy helper for short label reveals (tool/thinking labels). */
export function createStreamPacer(options) {
  let target = "";
  const paced = createPacedValue({
    getTarget: () => target,
    onRender: (text, meta) => options.onRender(text, { catchingUp: !meta.streaming, done: meta.done, streaming: meta.streaming }),
  });

  return {
    setCatchUp(value) {
      paced.setStreaming(!value);
    },
    enqueue(delta) {
      if (!delta) {
        return;
      }
      target += delta;
      paced.notifyTargetChanged();
    },
    setTarget(text) {
      target = text ?? "";
      paced.notifyTargetChanged();
    },
    flush() {
      paced.flush();
    },
    reset() {
      target = "";
      paced.reset();
    },
    getTarget() {
      return target;
    },
    getRendered() {
      return paced.getShown();
    },
  };
}
