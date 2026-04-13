import { postMemoryAction } from "../api.js";
import { refreshFromPayload } from "../app.js";
import { applyNodeSizing } from "../utils/layout.js";

const HOLD_TO_CLEAR_MS = 600;

export function renderMemory(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "memory-control";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--memory-accent", node.color || "#d26a2e");
  wrapper.style.setProperty("--memory-slot-count", String(node.slots.length));

  const title = node.showLabel === false ? null : document.createElement("div");
  if (title) {
    title.className = "memory-title";
    title.textContent = node.name;
  }

  const slots = document.createElement("div");
  slots.className = "memory-slots";

  const state = {
    ...node,
    pending: false,
  };

  node.slots.forEach((filled, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-slot";
    button.classList.toggle("is-filled", Boolean(filled));
    button.setAttribute(
      "aria-label",
      filled
        ? `${node.name} slot ${index + 1}, recall or hold to clear`
        : `${node.name} slot ${index + 1}, save`
    );

    const press = {
      pointerId: null,
      cleared: false,
      timer: null,
    };

    const clearPressTimer = () => {
      if (press.timer !== null) {
        window.clearTimeout(press.timer);
        press.timer = null;
      }
    };

    button.addEventListener("pointerdown", (event) => {
      if (state.pending) {
        return;
      }
      press.pointerId = event.pointerId;
      press.cleared = false;
      button.setPointerCapture(event.pointerId);
      if (!button.classList.contains("is-filled")) {
        return;
      }
      press.timer = window.setTimeout(() => {
        press.cleared = true;
        void applyMemoryAction(state, index, "clear", button);
      }, HOLD_TO_CLEAR_MS);
    });

    const finishPress = (event) => {
      if (press.pointerId !== event.pointerId) {
        return;
      }
      clearPressTimer();
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
      if (press.cleared || state.pending) {
        return;
      }
      const action = button.classList.contains("is-filled") ? "recall" : "save";
      void applyMemoryAction(state, index, action, button);
    };

    button.addEventListener("pointerup", finishPress);
    button.addEventListener("pointercancel", (event) => {
      if (press.pointerId !== event.pointerId) {
        return;
      }
      clearPressTimer();
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
    });
    button.addEventListener("lostpointercapture", clearPressTimer);
    slots.appendChild(button);
  });

  if (title) {
    wrapper.append(title);
  }
  wrapper.append(slots);
  return wrapper;
}

async function applyMemoryAction(state, slot, action, button) {
  if (state.pending) {
    return;
  }
  state.pending = true;
  try {
    const response = await postMemoryAction(state.key, slot, action);
    if (!response.ok) {
      return;
    }
    if (action === "save" || action === "clear") {
      updateMemorySlotVisual(state, slot, button, action === "save");
      return;
    }
    const payload = await response.json();
    refreshFromPayload(payload, {
      transitionSeconds: action === "recall" ? state.transition : 0,
    });
  } catch (_error) {
  } finally {
    state.pending = false;
  }
}

function updateMemorySlotVisual(state, slot, button, filled) {
  state.slots[slot] = filled;
  button.classList.toggle("is-filled", filled);
  button.setAttribute(
    "aria-label",
    filled
      ? `${state.name} slot ${slot + 1}, recall or hold to clear`
      : `${state.name} slot ${slot + 1}, save`
  );
}
