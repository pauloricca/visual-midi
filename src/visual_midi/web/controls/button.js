import { sendButtonGate } from "../api.js";
import { applyNodeSizing } from "../utils/layout.js";

export function renderButton(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "button-control";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--button-accent", node.color || "#d26a2e");

  if (node.showLabel !== false) {
    const meta = document.createElement("div");
    meta.className = "button-meta";
    meta.textContent = buildButtonMeta(node);

    const title = document.createElement("div");
    title.className = "button-title";
    title.textContent = node.name;

    wrapper.append(meta, title);
  }

  const activePointers = new Set();

  const setActive = (active) => {
    wrapper.classList.toggle("is-active", active);
  };

  const pressPointer = (pointerId) => {
    if (activePointers.has(pointerId)) {
      return;
    }
    activePointers.add(pointerId);
    if (activePointers.size === 1) {
      setActive(true);
      sendButtonGate(node.key, true);
    }
  };

  const releasePointer = (pointerId) => {
    if (!activePointers.has(pointerId)) {
      return;
    }
    activePointers.delete(pointerId);
    if (activePointers.size === 0) {
      setActive(false);
      sendButtonGate(node.key, false);
    }
  };

  wrapper.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    wrapper.setPointerCapture(event.pointerId);
    pressPointer(event.pointerId);
  });

  wrapper.addEventListener("pointerup", (event) => {
    releasePointer(event.pointerId);
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
  });

  wrapper.addEventListener("pointercancel", (event) => {
    releasePointer(event.pointerId);
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
  });

  wrapper.addEventListener("lostpointercapture", (event) => {
    releasePointer(event.pointerId);
  });

  wrapper.addEventListener("pointerleave", (event) => {
    if ((event.pointerType === "mouse" || event.pointerType === "pen") && activePointers.has(event.pointerId)) {
      releasePointer(event.pointerId);
      if (wrapper.hasPointerCapture(event.pointerId)) {
        wrapper.releasePointerCapture(event.pointerId);
      }
    }
  });

  return wrapper;
}

function buildButtonMeta(node) {
  const parts = [`CH ${node.channel}  CC ${node.control}`];
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push("OSC 0/1");
  }
  return parts.join("\n");
}
