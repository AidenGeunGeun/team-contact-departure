function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return html;
}

function renderMarkdownBlock(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      const code = escapeHtml(codeLines.join("\n"));
      const langClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      chunks.push(`<pre class="mono"><code${langClass}>${code}</code></pre>`);
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const text = line.replace(/^#+\s+/, "");
      chunks.push(`<h${level}>${inlineMarkdown(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(`<li>${inlineMarkdown(lines[index].replace(/^[-*]\s+/, ""))}</li>`);
        index += 1;
      }
      chunks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^#{1,3}\s+/.test(lines[index]) && !/^[-*]\s+/.test(lines[index]) && !lines[index].startsWith("```")) {
      paragraph.push(lines[index]);
      index += 1;
    }
    chunks.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return chunks.join("");
}

export function looksLikeMarkdown(source) {
  if (!source) {
    return false;
  }
  return /(^|\n)#{1,3}\s|```|(^|\n)[-*]\s|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\//m.test(source);
}

export function healStreamingTail(text) {
  if (!text) {
    return "";
  }
  let healed = text;
  const boldPairs = (healed.match(/\*\*/g) ?? []).length;
  if (boldPairs % 2 === 1) {
    healed += "**";
  }
  const ticks = (healed.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    healed += "`";
  }
  return healed;
}

export function splitStreamingMarkdown(source) {
  if (!source) {
    return { stable: "", tail: "" };
  }
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.endsWith("\n")) {
    return { stable: normalized, tail: "" };
  }
  const lastNewline = normalized.lastIndexOf("\n");
  if (lastNewline === -1) {
    return { stable: "", tail: normalized };
  }
  return {
    stable: normalized.slice(0, lastNewline + 1),
    tail: normalized.slice(lastNewline + 1),
  };
}

export function buildStreamingAssistantHtml(source) {
  if (!source) {
    return "";
  }
  const { stable, tail } = splitStreamingMarkdown(source);
  let html = stable ? renderMarkdownBlock(stable) : "";
  if (tail) {
    const healed = healStreamingTail(tail);
    html += `<p class="stream-tail">${inlineMarkdown(healed)}</p>`;
  }
  return html;
}

export function renderStreamingMarkdown(source) {
  return buildStreamingAssistantHtml(source);
}

export function renderMarkdown(source) {
  if (!source?.trim()) {
    return "";
  }
  return renderMarkdownBlock(source.trim());
}
