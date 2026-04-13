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

  let chrome = null;
  if (node.showLabel !== false) {
    chrome = document.createElement("div");
    chrome.className = "sequencer-chrome";

    const meta = document.createElement("div");
    meta.className = "sequencer-meta";
    meta.textContent = buildSequencerMeta(node);

    const title = document.createElement("div");
    title.className = "sequencer-title";
    title.textContent = node.name;

    chrome.append(meta, title);
  }

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
      velocity: normalizeSequencerVelocity(step.velocity, defaultSequencerVelocity(node)),
      gate: normalizeSequencerGate(node, step.gate),
      timing: normalizeSequencerTiming(step.timing, defaultSequencerTiming(node)),
    })),
    stepElements: [],
    velocityElements: [],
    gateElements: [],
    timingElements: [],
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
      if (!isPrimaryPointerButton(event)) {
        return;
      }
      event.preventDefault();
      drag.active = true;
      drag.pointerId = event.pointerId;
      drag.startY = event.clientY;
      drag.startValue = state.steps[index].value;
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
            value: state.steps[index].value,
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
        const currentValue = state.steps[index].value;
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
      label: "velocity",
      elements: state.velocityElements,
      formatValue: (value) => String(value),
      normalizeValue: normalizeSequencerVelocity,
      valueToRatio: (value) => (normalizeSequencerVelocity(value) - 1) / 126,
      resetValue: () => defaultSequencerVelocity(state),
      orientation: "vertical",
      pointerScale: 1,
      wheelStep: 1,
    });
  }

  if (state.mode === "notes" && state.gateRow) {
    renderSequencerParamRow({
      state,
      parent: editor,
      key: "gate",
      label: "gate",
      elements: state.gateElements,
      formatValue: formatGateValue,
      normalizeValue: (value) => normalizeSequencerGate(state, value),
      valueToRatio: (value) =>
        (normalizeSequencerGate(state, value) - GATE_STEP) /
        (getSequencerMaxGateSteps(state) - GATE_STEP || 1),
      resetValue: () => defaultSequencerGate(state),
      orientation: "horizontal",
      pointerScale: 0.02,
      wheelStep: GATE_STEP,
    });
  }

  if (state.mode === "notes" && state.timingRow) {
    renderSequencerParamRow({
      state,
      parent: editor,
      key: "timing",
      label: "timing",
      elements: state.timingElements,
      formatValue: formatTimingValue,
      normalizeValue: normalizeSequencerTiming,
      valueToRatio: (value) => (normalizeSequencerTiming(value) + 1) / 2,
      resetValue: () => defaultSequencerTiming(state),
      orientation: "horizontal",
      pointerScale: 0.01,
      wheelStep: 0.01,
    });
  }

  wrapper.append(editor);
  if (chrome) {
    wrapper.append(chrome);
  }
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
    velocity: normalizeSequencerVelocity(
      nextStep.velocity ?? previous.velocity,
      defaultSequencerVelocity(state)
    ),
    gate: normalizeSequencerGate(state, nextStep.gate ?? previous.gate),
    timing: normalizeSequencerTiming(
      nextStep.timing ?? previous.timing,
      defaultSequencerTiming(state)
    ),
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
    `velocity ${step.velocity}`
  );
  updateParamElement(
    state.gateElements[index],
    step.gate,
    (value) =>
      (normalizeSequencerGate(state, value) - GATE_STEP) /
      (getSequencerMaxGateSteps(state) - GATE_STEP || 1),
    `gate ${formatGateValue(step.gate)}`
  );
  updateParamElement(
    state.timingElements[index],
    step.timing,
    (value) => (normalizeSequencerTiming(value) + 1) / 2,
    `timing ${formatTimingValue(step.timing)}`
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
        velocity: normalizeSequencerVelocity(step.velocity, defaultSequencerVelocity(state)),
        gate: normalizeSequencerGate(state, step.gate),
        timing: normalizeSequencerTiming(step.timing, defaultSequencerTiming(state)),
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
  resetValue,
  orientation = "horizontal",
  pointerScale,
  wheelStep,
}) {
  const row = document.createElement("div");
  row.className = `sequencer-param-row sequencer-param-row--${orientation}`;

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
    const element = { cell, fill, value, valueToRatio, formatValue, label, orientation };
    elements[index] = element;

    const drag = {
      active: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      startValue: step[key],
      didAdjust: false,
      lastTapAt: 0,
    };

    cell.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      drag.active = true;
      drag.pointerId = event.pointerId;
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      drag.startValue = state.steps[index][key];
      drag.didAdjust = false;
      cell.setPointerCapture(event.pointerId);
    });

    cell.addEventListener("pointermove", (event) => {
      if (!drag.active || !cell.hasPointerCapture(event.pointerId)) {
        return;
      }
      event.preventDefault();
      const delta =
        orientation === "horizontal" ? event.clientX - drag.startX : drag.startY - event.clientY;
      if (Math.abs(delta) < 4) {
        return;
      }
      updateSequencerStep(state, index, {
        [key]: normalizeValue(drag.startValue + delta * pointerScale),
      });
      drag.didAdjust = true;
    });

    const releasePointer = (event, { commitTap } = { commitTap: true }) => {
      if (!drag.active || drag.pointerId !== event.pointerId) {
        return;
      }
      if (commitTap && !drag.didAdjust) {
        const now = performance.now();
        if (now - drag.lastTapAt <= 350) {
          updateSequencerStep(state, index, { [key]: normalizeValue(resetValue()) });
          drag.lastTapAt = 0;
        } else {
          drag.lastTapAt = now;
        }
      }
      drag.active = false;
      if (cell.hasPointerCapture(event.pointerId)) {
        cell.releasePointerCapture(event.pointerId);
      }
    };

    cell.addEventListener("pointerup", releasePointer);
    cell.addEventListener("pointercancel", (event) => releasePointer(event, { commitTap: false }));
    cell.addEventListener("dblclick", (event) => {
      event.preventDefault();
      updateSequencerStep(state, index, { [key]: normalizeValue(resetValue()) });
      drag.lastTapAt = 0;
    });
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

function isPrimaryPointerButton(event) {
  return event.pointerType === "touch" || event.button === 0;
}

function updateParamElement(element, rawValue, ratioForValue, label) {
  if (!element) {
    return;
  }
  const ratio = Math.max(0, Math.min(1, ratioForValue(rawValue)));
  if (element.orientation === "vertical") {
    element.fill.style.width = "100%";
    element.fill.style.height = `${ratio * 100}%`;
  } else {
    element.fill.style.width = `${ratio * 100}%`;
    element.fill.style.height = "100%";
  }
  element.value.textContent = "";
}

function normalizeSequencerVelocity(value, defaultValue = 127) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultSequencerVelocity({ defaultVelocity: defaultValue });
  }
  return Math.max(1, Math.min(127, Math.round(numeric)));
}

function normalizeSequencerGate(state, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultSequencerGate(state);
  }
  const maxGateSteps = getSequencerMaxGateSteps(state);
  return Math.round(Math.max(GATE_STEP, Math.min(maxGateSteps, numeric)) / GATE_STEP) * GATE_STEP;
}

function normalizeSequencerTiming(value, defaultValue = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultSequencerTiming({ defaultTiming: defaultValue });
  }
  return Math.round(Math.max(-1, Math.min(1, numeric)) * 100) / 100;
}

function defaultSequencerVelocity(state) {
  const numeric = Number(state.defaultVelocity);
  if (!Number.isFinite(numeric)) {
    return 127;
  }
  return Math.max(1, Math.min(127, Math.round(numeric)));
}

function defaultSequencerGate(state) {
  const numeric = Number(state.defaultGate);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  const maxGateSteps = getSequencerMaxGateSteps(state);
  return Math.round(Math.max(GATE_STEP, Math.min(maxGateSteps, numeric)) / GATE_STEP) * GATE_STEP;
}

function defaultSequencerTiming(state) {
  return normalizeSequencerTiming(state.defaultTiming, 0);
}

function getSequencerMaxGateSteps(state) {
  const maxGateSteps = Number(state.maxGateSteps);
  return Number.isFinite(maxGateSteps) && maxGateSteps >= 1 ? maxGateSteps : 1;
}

function formatGateValue(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function formatTimingValue(value) {
  const normalized = normalizeSequencerTiming(value);
  if (normalized > 0) {
    return `+${formatGateValue(normalized)}`;
  }
  return formatGateValue(normalized);
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
