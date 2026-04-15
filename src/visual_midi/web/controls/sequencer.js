import { postSequencerSteps } from "../api.js";
import { createSlider } from "../ui/slider.js";
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
    const stepSlider = createSlider({
      tagName: "button",
      className: "sequencer-step",
      fillClassName: "sequencer-step-fill",
      value: step.value,
      min: state.min,
      max: state.max,
      steps: Math.max(2, Math.round(state.max - state.min) + 1),
      orientation: "vertical",
      color: node.color || "#d26a2e",
      wheelAxis: "vertical",
      ariaLabel: `${node.name} step ${index + 1}`,
      onChange: (value) => {
        updateSequencerStep(state, index, { enabled: true, value });
      },
      onTap: () => {
        if (state.steps[index].enabled) {
          updateSequencerStep(state, index, { enabled: false, value: state.steps[index].value });
        } else {
          updateSequencerStep(state, index, {
            enabled: true,
            value: state.steps[index].value,
          });
        }
      },
    });
    const button = stepSlider.element;
    const fill = stepSlider.fill;

    const value = document.createElement("div");
    value.className = "sequencer-step-value";

    button.append(value);
    surface.appendChild(button);
    state.stepElements.push({ button, fill, value, slider: stepSlider });
  });

  if (state.mode === "notes" && state.velocityRow) {
    renderSequencerParamRow({
      state,
      parent: editor,
      key: "velocity",
      label: "velocity",
      shortLabel: "v",
      elements: state.velocityElements,
      normalizeValue: normalizeSequencerVelocity,
      resetValue: () => defaultSequencerVelocity(state),
      min: 1,
      max: 127,
      steps: 127,
      orientation: "horizontal",
    });
  }

  if (state.mode === "notes" && state.gateRow) {
    renderSequencerParamRow({
      state,
      parent: editor,
      key: "gate",
      label: "gate",
      shortLabel: "g",
      elements: state.gateElements,
      normalizeValue: (value) => normalizeSequencerGate(state, value),
      resetValue: () => defaultSequencerGate(state),
      min: GATE_STEP,
      max: getSequencerMaxGateSteps(state),
      steps: Math.max(2, Math.round((getSequencerMaxGateSteps(state) - GATE_STEP) / GATE_STEP) + 1),
      orientation: "horizontal",
    });
  }

  if (state.mode === "notes" && state.timingRow) {
    renderSequencerParamRow({
      state,
      parent: editor,
      key: "timing",
      label: "timing",
      shortLabel: "t",
      elements: state.timingElements,
      normalizeValue: normalizeSequencerTiming,
      resetValue: () => defaultSequencerTiming(state),
      min: -1,
      max: 1,
      steps: 201,
      orientation: "horizontal",
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
  element.slider.setValue(step.value, { silent: true });
  element.button.classList.toggle("is-enabled", step.enabled);
  element.button.classList.toggle("is-current", index === state.currentStep);
  if (!step.enabled) {
    element.fill.style.height = "0%";
  }
  element.value.textContent = formatSequencerValue(state, step.value, step.enabled);
  updateParamElement(
    state.velocityElements[index],
    step.velocity
  );
  updateParamElement(
    state.gateElements[index],
    step.gate
  );
  updateParamElement(
    state.timingElements[index],
    step.timing
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
  shortLabel,
  elements,
  normalizeValue,
  resetValue,
  min,
  max,
  steps,
  orientation = "horizontal",
}) {
  const row = document.createElement("div");
  row.className = `sequencer-param-row sequencer-param-row--${orientation}`;

  state.steps.forEach((step, index) => {
    const paramSlider = createSlider({
      tagName: "button",
      className: "sequencer-param-cell",
      fillClassName: "sequencer-param-fill",
      value: step[key],
      min,
      max,
      steps,
      orientation,
      color: state.color || "#d26a2e",
      wheelAxis: orientation,
      ariaLabel: `${state.name} step ${index + 1} ${label}`,
      onChange: (value) => {
        updateSequencerStep(state, index, { [key]: normalizeValue(value) });
      },
      onTap: () => {
        const now = performance.now();
        if (now - element.lastTapAt <= 350) {
          updateSequencerStep(state, index, { [key]: normalizeValue(resetValue()) });
          element.lastTapAt = 0;
        } else {
          element.lastTapAt = now;
        }
      },
    });
    const cell = paramSlider.element;
    const fill = paramSlider.fill;

    const value = document.createElement("div");
    value.className = "sequencer-param-value";
    value.textContent = shortLabel;

    cell.append(value);
    row.appendChild(cell);
    const element = {
      cell,
      fill,
      value,
      label,
      shortLabel,
      orientation,
      slider: paramSlider,
      lastTapAt: 0,
    };
    elements[index] = element;
    cell.addEventListener("dblclick", (event) => {
      event.preventDefault();
      updateSequencerStep(state, index, { [key]: normalizeValue(resetValue()) });
      element.lastTapAt = 0;
    });
  });

  parent.appendChild(row);
}

function updateParamElement(element, rawValue) {
  if (!element) {
    return;
  }
  element.slider.setValue(rawValue, { silent: true });
  element.value.textContent = element.shortLabel;
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
