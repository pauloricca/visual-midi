import { postTempoValue, postTransportState } from "../api.js";
import { WHEEL_DELTA_UNIT, clamp, normalizeWheelDelta, quantizeTempoValue } from "../utils/math.js";
import { applyNodeSizing } from "../utils/layout.js";
import { syncTransportState } from "./sequencer.js";
import { syncLfoTransportState } from "./lfo.js";

let currentTempoState = null;
let tempoShortcutsInstalled = false;

export function renderTempo(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "tempo-control";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--tempo-accent", node.color || "#d26a2e");

  const value = document.createElement("div");
  value.className = "tempo-value";

  const valueNumber = document.createElement("span");
  valueNumber.className = "tempo-value-number";

  const valueUnit = document.createElement("span");
  valueUnit.className = "tempo-value-unit";
  valueUnit.textContent = "BPM";

  value.append(valueNumber, valueUnit);

  const controls = document.createElement("div");
  controls.className = "tempo-transport";

  const transportButton = document.createElement("button");
  transportButton.type = "button";
  transportButton.className = "tempo-transport-button";
  transportButton.setAttribute("aria-label", node.playing ? "Stop transport" : "Start transport");

  controls.append(transportButton);
  wrapper.append(value, controls);

  const state = {
    ...node,
    element: wrapper,
    valueNode: valueNumber,
    transportButton,
    pendingTempoRequest: false,
    queuedValue: null,
    pendingTransportRequest: false,
    dragStartY: 0,
    dragStartValue: node.value,
    wheelRemainder: 0,
  };
  currentTempoState = state;

  updateTempoVisuals(state, node.value, node.playing);

  const commitPointerValue = (nextValue) => {
    const bounded = quantizeTempoValue(clamp(nextValue, state.min, state.max));
    if (bounded === state.value) {
      return;
    }
    updateTempoVisuals(state, bounded, state.playing);
    queueTempoUpdate(state, bounded);
  };

  wrapper.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".tempo-transport-button")) {
      return;
    }
    event.preventDefault();
    state.dragStartY = event.clientY;
    state.dragStartValue = state.value;
    wrapper.setPointerCapture(event.pointerId);
  });

  wrapper.addEventListener("pointermove", (event) => {
    if (!wrapper.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    const pixelStep = Math.max(2, (rect.height || 1) / 120);
    const delta = (state.dragStartY - event.clientY) / pixelStep;
    commitPointerValue(state.dragStartValue + delta * 0.1);
  });

  const releasePointer = (event) => {
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
  };

  wrapper.addEventListener("pointerup", releasePointer);
  wrapper.addEventListener("pointercancel", releasePointer);

  wrapper.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const normalizedDelta = normalizeWheelDelta(event, event.deltaY);
      state.wheelRemainder += -normalizedDelta;
      const steps = Math.trunc(state.wheelRemainder / WHEEL_DELTA_UNIT);
      if (steps === 0) {
        return;
      }
      state.wheelRemainder -= steps * WHEEL_DELTA_UNIT;
      commitPointerValue(state.value + steps * 0.1);
    },
    { passive: false }
  );

  transportButton.addEventListener("click", () => {
    void sendTransportState(state, !state.playing);
  });

  return wrapper;
}

export function clearTempoViews() {
  currentTempoState = null;
}

export function installTempoShortcuts() {
  if (tempoShortcutsInstalled) {
    return;
  }
  tempoShortcutsInstalled = true;
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isSpaceKey(event) || event.repeat || !currentTempoState) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void sendTransportState(currentTempoState, !currentTempoState.playing);
    },
    { capture: true }
  );
}

export function updateTempoVisuals(state, value, playing) {
  state.value = quantizeTempoValue(value);
  state.playing = Boolean(playing);
  state.valueNode.textContent = state.value.toFixed(1);
  state.transportButton.setAttribute("aria-label", state.playing ? "Stop transport" : "Start transport");
  state.transportButton.classList.toggle("is-active", state.playing);
}

function isSpaceKey(event) {
  return event.code === "Space" || event.key === " ";
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  const editable = target.closest("input, textarea, select, [contenteditable]");
  if (!editable) {
    return false;
  }
  return editable.getAttribute("contenteditable") !== "false";
}

function queueTempoUpdate(state, value) {
  state.queuedValue = value;
  if (state.pendingTempoRequest) {
    return;
  }
  void flushTempoUpdate(state);
}

async function flushTempoUpdate(state) {
  if (state.queuedValue === null) {
    return;
  }

  state.pendingTempoRequest = true;
  const value = state.queuedValue;
  state.queuedValue = null;

  try {
    const response = await postTempoValue(value);
    if (response.ok) {
      const payload = await response.json();
      updateTempoVisuals(state, payload.value, payload.playing);
      syncTransportState({ tempo: payload.value, playing: payload.playing });
      syncLfoTransportState({ tempo: payload.value, playing: payload.playing });
    }
  } catch (_error) {
  } finally {
    state.pendingTempoRequest = false;
    if (state.queuedValue !== null && state.queuedValue !== value) {
      void flushTempoUpdate(state);
    }
  }
}

async function sendTransportState(state, playing) {
  if (state.pendingTransportRequest) {
    return;
  }
  state.pendingTransportRequest = true;
  try {
    const response = await postTransportState(playing);
    if (response.ok) {
      const payload = await response.json();
      updateTempoVisuals(state, state.value, payload.playing);
      syncTransportState({ tempo: state.value, playing: payload.playing });
      syncLfoTransportState({ tempo: state.value, playing: payload.playing });
    }
  } catch (_error) {
  } finally {
    state.pendingTransportRequest = false;
  }
}
