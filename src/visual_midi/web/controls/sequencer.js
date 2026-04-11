import { postSequencerSteps } from "../api.js";
import { WHEEL_DELTA_UNIT, normalizeWheelDelta } from "../utils/math.js";
import { applyNodeSizing } from "../utils/layout.js";
import {
  formatMidiNote,
  formatPitchClass,
  formatScaleName,
  quantizeSequencerValue,
} from "../utils/music.js";

const sequencerViews = new Set();
let sequencerPlayheadTimer = null;
const transportState = {
  tempo: 120,
  playing: false,
};
const GATE_STEP = 0.05;

export function renderSequencer(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "sequencer-control";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--sequencer-accent", node.color || "#d26a2e");
  wrapper.style.setProperty("--sequencer-size", String(node.size));

  const chrome = document.createElement("div");
  chrome.className = "sequencer-chrome";

  const meta = document.createElement("div");
  meta.className = "sequencer-meta";
  meta.textContent = buildSequencerMeta(node);

  const title = document.createElement("div");
  title.className = "sequencer-title";
  title.textContent = node.name;

  chrome.append(meta, title);

  const editor = document.createElement("div");
  editor.className = "sequencer-editor";

  const surface = document.createElement("div");
  surface.className = "sequencer-surface";
  editor.appendChild(surface);

  const state = {
    ...node,
    element: wrapper,
    surface,
    currentStep: Number.isInteger(node.currentStep) ? node.currentStep : -1,
    anchorStep: Number.isInteger(node.currentStep) && node.currentStep >= 0 ? node.currentStep : 0,
    anchorTimeMs: performance.now(),
    pendingRequest: false,
    queuedSteps: null,
    steps: node.steps.map((step) => ({
      enabled: Boolean(step.enabled),
      value: quantizeSequencerValue(node, Number(step.value)),
      velocity: normalizeSequencerVelocity(step.velocity),
      gate: normalizeSequencerGate(node, step.gate),
    })),
    stepElements: [],
    velocityElements: [],
    gateElements: [],
  };

  state.steps.forEach((step, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sequencer-step";
    button.setAttribute("aria-label", `${node.name} step ${index + 1}`);

    const fill = document.createElement("div");
    fill.className = "sequencer-step-fill";

    const value = document.createElement("div");
    value.className = "sequencer-step-value";

    button.append(fill, value);
    surface.appendChild(button);
    state.stepElements.push({ button, fill, value });

    const drag = {
      active: false,
      pointerId: null,
      startY: 0,
      startValue: step.value,
      wasEnabled: step.enabled,
      didAdjust: false,
    };

    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      drag.active = true;
      drag.pointerId = event.pointerId;
      drag.startY = event.clientY;
      drag.startValue = state.steps[index].enabled
        ? state.steps[index].value
        : defaultSequencerValue(state);
      drag.wasEnabled = state.steps[index].enabled;
      drag.didAdjust = false;
      button.setPointerCapture(event.pointerId);
    });

    button.addEventListener("pointermove", (event) => {
      if (!drag.active || !button.hasPointerCapture(event.pointerId)) {
        return;
      }
      event.preventDefault();
      const delta = drag.startY - event.clientY;
      if (Math.abs(delta) < 4) {
        return;
      }
      const nextValue = quantizeSequencerValue(state, drag.startValue + delta / 8);
      updateSequencerStep(state, index, { enabled: true, value: nextValue });
      drag.didAdjust = true;
    });

    const releasePointer = (event, { commitTap } = { commitTap: true }) => {
      if (!drag.active || drag.pointerId !== event.pointerId) {
        return;
      }
      if (commitTap && !drag.didAdjust) {
        if (state.steps[index].enabled) {
          updateSequencerStep(state, index, { enabled: false, value: state.steps[index].value });
        } else {
          updateSequencerStep(state, index, {
            enabled: true,
            value: defaultSequencerValue(state),
          });
        }
      }
      drag.active = false;
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
    };

    button.addEventListener("pointerup", (event) => releasePointer(event));
    button.addEventListener("pointercancel", (event) => releasePointer(event, { commitTap: false }));
    button.addEventListener("lostpointercapture", () => {
      drag.active = false;
    });

    button.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const normalizedDelta = normalizeWheelDelta(event, event.deltaY);
        const direction = normalizedDelta > 0 ? 1 : -1;
        const magnitude = Math.max(1, Math.round(Math.abs(normalizedDelta) / WHEEL_DELTA_UNIT));
        const currentValue = state.steps[index].enabled
          ? state.steps[index].value
          : defaultSequencerValue(state);
        updateSequencerStep(state, index, {
          enabled: true,
          value: quantizeSequencerValue(state, currentValue + direction * magnitude),
        });
      },
      { passive: false }
    );
  });

  if (state.mode === "notes" && state.velocityRow) {
    renderSequencerParamRow({
      state,
      parent: editor,
      key: "velocity",
      label: "v",
      elements: state.velocityElements,
      formatValue: (value) => String(value),
      normalizeValue: normalizeSequencerVelocity,
      valueToRatio: (value) => (normalizeSequencerVelocity(value) - 1) / 126,
      pointerScale: 1,
      wheelStep: 1,
    });
  }

  if (state.mode === "notes" && state.gateRow) {
    renderSequencerParamRow({
      state,
      parent: editor,
      key: "gate",
      label: "h",
      elements: state.gateElements,
      formatValue: formatGateValue,
      normalizeValue: (value) => normalizeSequencerGate(state, value),
      valueToRatio: (value) =>
        (normalizeSequencerGate(state, value) - GATE_STEP) /
        (getSequencerMaxGateSteps(state) - GATE_STEP || 1),
      pointerScale: 0.02,
      wheelStep: GATE_STEP,
    });
  }

  wrapper.append(editor, chrome);
  state.steps.forEach((_step, index) => updateSequencerStepVisual(state, index));
  registerSequencerView(state);
  return wrapper;
}

export function syncTransportState(nextTransport, options = {}) {
  const now = performance.now();
  const tempo = Number(nextTransport?.tempo) || transportState.tempo || 120;
  const playing = Boolean(nextTransport?.playing);
  const tempoChanged = tempo !== transportState.tempo;
  const playingChanged = playing !== transportState.playing;
  transportState.tempo = tempo;
  transportState.playing = playing;

  sequencerViews.forEach((state) => {
    if (!transportState.playing) {
      state.currentStep = -1;
    }
    if (options.resetAnchors || tempoChanged || playingChanged) {
      const resolvedStep = transportState.playing
        ? state.currentStep >= 0
          ? state.currentStep
          : 0
        : state.currentStep;
      state.anchorStep = resolvedStep >= 0 ? resolvedStep : 0;
      state.anchorTimeMs = now;
    }
    syncSequencerPlayhead(state, now);
  });
}

export function clearSequencerViews() {
  sequencerViews.clear();
}

function buildSequencerMeta(node) {
  const parts = [`STEP ${node.subdivision}`];
  if (node.mode === "notes") {
    parts.unshift(`CH ${node.channel}  NOTES`);
    if (node.scale && Number.isInteger(node.root)) {
      parts.push(`${formatPitchClass(node.root)} ${formatScaleName(node.scale)}`);
    }
  } else {
    parts.unshift(`CH ${node.channel}`);
    if (Number.isInteger(node.control)) {
      parts.push(`CC ${node.control}`);
    }
    if (node.osc) {
      parts.push(`OSC ${node.osc.path}`);
    }
  }
  return parts.join("\n");
}

function updateSequencerStep(state, index, nextStep) {
  const previous = state.steps[index];
  state.steps[index] = {
    enabled: Boolean(nextStep.enabled ?? previous.enabled),
    value: quantizeSequencerValue(state, nextStep.value ?? previous.value),
    velocity: normalizeSequencerVelocity(nextStep.velocity ?? previous.velocity),
    gate: normalizeSequencerGate(state, nextStep.gate ?? previous.gate),
  };
  updateSequencerStepVisual(state, index);
  queueSequencerUpdate(state);
}

function updateSequencerStepVisual(state, index) {
  const step = state.steps[index];
  const element = state.stepElements[index];
  const percentage = ((step.value - state.min) / (state.max - state.min || 1)) * 100;
  element.button.classList.toggle("is-enabled", step.enabled);
  element.button.classList.toggle("is-current", index === state.currentStep);
  element.fill.style.height = step.enabled ? `${percentage}%` : "0%";
  element.value.textContent = formatSequencerValue(state, step.value, step.enabled);
  updateParamElement(
    state.velocityElements[index],
    step.velocity,
    (value) => (value - 1) / 126,
    `v ${step.velocity}`
  );
  updateParamElement(
    state.gateElements[index],
    step.gate,
    (value) =>
      (normalizeSequencerGate(state, value) - GATE_STEP) /
      (getSequencerMaxGateSteps(state) - GATE_STEP || 1),
    `h ${formatGateValue(step.gate)}`
  );
}

function formatSequencerValue(state, value, enabled) {
  if (!enabled) {
    return "";
  }
  if (state.mode === "notes") {
    return formatMidiNote(value);
  }
  return "";
}

function defaultSequencerValue(state) {
  if (state.mode === "notes" && Number.isInteger(state.root)) {
    return quantizeSequencerValue(state, state.root);
  }
  if (state.mode === "notes") {
    return quantizeSequencerValue(state, 60);
  }
  return quantizeSequencerValue(state, (state.min + state.max) / 2);
}

function queueSequencerUpdate(state) {
  state.queuedSteps = state.steps.map((step) => ({ ...step }));
  if (state.pendingRequest) {
    return;
  }
  void flushSequencerUpdate(state);
}

async function flushSequencerUpdate(state) {
  if (state.queuedSteps === null) {
    return;
  }
  state.pendingRequest = true;
  const steps = state.queuedSteps;
  state.queuedSteps = null;

  try {
    const response = await postSequencerSteps(state.key, steps);
    if (response.ok) {
      const payload = await response.json();
      state.steps = payload.steps.map((step) => ({
        enabled: Boolean(step.enabled),
        value: quantizeSequencerValue(state, Number(step.value)),
        velocity: normalizeSequencerVelocity(step.velocity),
        gate: normalizeSequencerGate(state, step.gate),
      }));
      if (Number.isInteger(payload.currentStep)) {
        state.currentStep = payload.currentStep;
        state.anchorStep = payload.currentStep >= 0 ? payload.currentStep : state.anchorStep;
        state.anchorTimeMs = performance.now();
      }
      state.steps.forEach((_step, index) => updateSequencerStepVisual(state, index));
    }
  } catch (_error) {
  } finally {
    state.pendingRequest = false;
    if (state.queuedSteps !== null) {
      void flushSequencerUpdate(state);
    }
  }
}

function renderSequencerParamRow({
  state,
  parent,
  key,
  label,
  elements,
  formatValue,
  normalizeValue,
  valueToRatio,
  pointerScale,
  wheelStep,
}) {
  const row = document.createElement("div");
  row.className = "sequencer-param-row";

  state.steps.forEach((step, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "sequencer-param-cell";
    cell.setAttribute("aria-label", `${state.name} step ${index + 1} ${label}`);

    const fill = document.createElement("div");
    fill.className = "sequencer-param-fill";

    const value = document.createElement("div");
    value.className = "sequencer-param-value";

    cell.append(fill, value);
    row.appendChild(cell);
    const element = { cell, fill, value, valueToRatio, formatValue, label };
    elements[index] = element;

    const drag = {
      active: false,
      pointerId: null,
      startY: 0,
      startValue: step[key],
    };

    cell.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      drag.active = true;
      drag.pointerId = event.pointerId;
      drag.startY = event.clientY;
      drag.startValue = state.steps[index][key];
      cell.setPointerCapture(event.pointerId);
    });

    cell.addEventListener("pointermove", (event) => {
      if (!drag.active || !cell.hasPointerCapture(event.pointerId)) {
        return;
      }
      event.preventDefault();
      const delta = drag.startY - event.clientY;
      updateSequencerStep(state, index, {
        [key]: normalizeValue(drag.startValue + delta * pointerScale),
      });
    });

    const releasePointer = (event) => {
      if (!drag.active || drag.pointerId !== event.pointerId) {
        return;
      }
      drag.active = false;
      if (cell.hasPointerCapture(event.pointerId)) {
        cell.releasePointerCapture(event.pointerId);
      }
    };

    cell.addEventListener("pointerup", releasePointer);
    cell.addEventListener("pointercancel", releasePointer);
    cell.addEventListener("lostpointercapture", () => {
      drag.active = false;
    });

    cell.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const normalizedDelta = normalizeWheelDelta(event, event.deltaY);
        const direction = normalizedDelta > 0 ? 1 : -1;
        const magnitude = Math.max(1, Math.round(Math.abs(normalizedDelta) / WHEEL_DELTA_UNIT));
        updateSequencerStep(state, index, {
          [key]: normalizeValue(state.steps[index][key] + direction * wheelStep * magnitude),
        });
      },
      { passive: false }
    );
  });

  parent.appendChild(row);
}

function updateParamElement(element, rawValue, ratioForValue, label) {
  if (!element) {
    return;
  }
  const ratio = Math.max(0, Math.min(1, ratioForValue(rawValue)));
  element.fill.style.width = `${ratio * 100}%`;
  element.value.textContent = label;
}

function normalizeSequencerVelocity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 127;
  }
  return Math.max(1, Math.min(127, Math.round(numeric)));
}

function normalizeSequencerGate(state, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  const maxGateSteps = getSequencerMaxGateSteps(state);
  return Math.round(Math.max(GATE_STEP, Math.min(maxGateSteps, numeric)) / GATE_STEP) * GATE_STEP;
}

function getSequencerMaxGateSteps(state) {
  const maxGateSteps = Number(state.maxGateSteps);
  return Number.isFinite(maxGateSteps) && maxGateSteps >= 1 ? maxGateSteps : 1;
}

function formatGateValue(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function registerSequencerView(state) {
  sequencerViews.add(state);
  syncSequencerPlayhead(state, performance.now());
  ensureSequencerPlayheadTimer();
}

function syncSequencerPlayhead(state, now) {
  if (!transportState.playing) {
    state.stepElements.forEach((element, index) => {
      element.button.classList.toggle("is-current", index === state.currentStep);
    });
    return;
  }
  const stepDurationMs = (60000 / Math.max(transportState.tempo, 1)) * state.subdivisionBeats;
  const elapsed = Math.max(0, now - state.anchorTimeMs);
  const stepOffset = Math.floor(elapsed / Math.max(stepDurationMs, 1));
  state.currentStep = ((state.anchorStep + stepOffset) % state.size + state.size) % state.size;
  state.stepElements.forEach((element, index) => {
    element.button.classList.toggle("is-current", index === state.currentStep);
  });
}

function ensureSequencerPlayheadTimer() {
  if (sequencerPlayheadTimer !== null) {
    return;
  }
  sequencerPlayheadTimer = window.setInterval(() => {
    if (!transportState.playing) {
      return;
    }
    const now = performance.now();
    sequencerViews.forEach((state) => syncSequencerPlayhead(state, now));
  }, 50);
}
