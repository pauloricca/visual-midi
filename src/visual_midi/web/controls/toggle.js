import { postToggleState } from "../api.js";
import { createButton } from "../ui/button.js";
import { applyNodeSizing } from "../utils/layout.js";

export function renderToggle(node) {
  let enabled = Boolean(node.enabled);
  let requestId = 0;
  const button = createButton({
    tagName: "article",
    className: "button-control",
    color: node.color || "#d26a2e",
    ariaLabel: node.name,
    onClick: () => {
      const previousEnabled = enabled;
      const nextEnabled = !enabled;
      const currentRequestId = ++requestId;
      setEnabled(nextEnabled);
      void postToggleState(node.key, nextEnabled)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Toggle request failed: ${response.status}`);
          }
          const payload = await response.json();
          if (currentRequestId === requestId) {
            setEnabled(Boolean(payload.enabled));
          }
        })
        .catch(() => {
          if (currentRequestId === requestId) {
            setEnabled(previousEnabled);
          }
        });
    },
  });
  const wrapper = button.element;
  wrapper.dataset.key = node.key;
  wrapper.setAttribute("role", "switch");
  applyNodeSizing(wrapper, node);

  if (node.showLabel !== false) {
    const metaText = buildToggleMeta(node);
    const meta = document.createElement("div");
    meta.className = "button-meta";
    meta.textContent = metaText;

    const title = document.createElement("div");
    title.className = "button-title";
    title.textContent = node.name;

    wrapper.append(...(metaText ? [meta] : []), title);
  }

  setEnabled(enabled);
  return wrapper;

  function setEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    button.setActive(enabled);
    wrapper.setAttribute("aria-checked", enabled ? "true" : "false");
  }
}

function buildToggleMeta(node) {
  const parts = [];
  if (Number.isInteger(node.control)) {
    parts.push(`CH ${node.channel}  CC ${node.control}`);
  }
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join("\n");
}
