import { sendButtonGate } from "../api.js";
import { createButton } from "../ui/button.js";
import { applyNodeSizing } from "../utils/layout.js";

export function renderButton(node) {
  const button = createButton({
    tagName: "article",
    className: "button-control",
    color: node.color || "#d26a2e",
    ariaLabel: node.name,
    onPress: () => sendButtonGate(node.key, true),
    onRelease: () => sendButtonGate(node.key, false),
  });
  const wrapper = button.element;
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);

  if (node.showLabel !== false) {
    const metaText = buildButtonMeta(node);
    const meta = document.createElement("div");
    meta.className = "button-meta";
    meta.textContent = metaText;

    const title = document.createElement("div");
    title.className = "button-title";
    title.textContent = node.name;

    wrapper.append(...(metaText ? [meta] : []), title);
  }

  return wrapper;
}

function buildButtonMeta(node) {
  const parts = [];
  if (Number.isInteger(node.control)) {
    parts.push(`CH ${node.channel}  CC ${node.control}`);
  }
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push("OSC 0/1");
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join("\n");
}
