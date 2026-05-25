import morphdom from "./vendor/morphdom.js";
import { buildStreamingAssistantHtml, renderMarkdown } from "./operator-markdown.js";

export function morphAssistantBody(node, source, options = {}) {
  if (!node) {
    return;
  }
  const text = source ?? "";
  if (!text) {
    node.replaceChildren();
    node.classList.remove("markdown-body");
    return;
  }

  const temp = document.createElement("div");
  temp.innerHTML = options.final ? renderMarkdown(text) : buildStreamingAssistantHtml(text);
  node.classList.add("markdown-body");
  if (!node.firstElementChild && temp.childNodes.length > 0) {
    node.replaceChildren(...temp.childNodes);
    return;
  }
  morphdom(node, temp, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      if (fromEl.isEqualNode(toEl)) {
        return false;
      }
      return true;
    },
  });
}
