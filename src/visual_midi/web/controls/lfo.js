import { clamp, normalizeWheelDelta, quantizeSliderValue } from "../utils/math.js";
import { applyNodeSizing } from "../utils/layout.js";
import { queueSliderUpdate } from "./slider.js";

const LFO_STORAGE_PREFIX = "visual-midi:lfo:";
const LFO_RATE_MAX = 12;
const LFO_TEMPO_DIVISIONS = [
  { label: "4 bar", beats: 16 },
  { label: "2 bar", beats: 8 },
  { label: "bar", beats: 4 },
  { label: "1/2 bar", beats: 2 },
  { label: "1/4.", beats: 1.5 },
  { label: "1/4", beats: 1 },
  { label: "1/8.", beats: 0.75 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16.", beats: 0.375 },
  { label: "triplet", beats: 1 / 3 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32.", beats: 0.1875 },
  { label: "1/32", beats: 0.125 },
];
const lfoViews = new Set();
const transportState = {
  tempo: 120,
};

export function renderLfo(node) {
  return node.complex ? renderComplexLfo(node) : renderSimpleLfo(node);
}

export function syncLfoTransportState(nextTransport) {
  const tempo = Number(nextTransport?.tempo) || transportState.tempo || 120;
  const tempoChanged = tempo !== transportState.tempo;
  transportState.tempo = tempo;
  if (!tempoChanged) {
    return;
  }
  lfoViews.forEach((state) => {
    state.tempo = tempo;
    if (shouldQuantizeLfoRate(state) && state.rate > 0) {
      state.rate = rateForTempoDivision(state.tempoDivisionBeats, state);
      updateLfoVisuals(state, state.value);
      saveLfoSettings(state);
    }
  });
}

export function clearLfoViews() {
  lfoViews.clear();
}

function renderSimpleLfo(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "control control--vertical";
  wrapper.classList.add("control--lfo");
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--accent", node.color || "#d26a2e");

  const fill = document.createElement("div");
  fill.className = "control-fill";

  const chrome = document.createElement("div");
  chrome.className = "control-chrome";

  const title = document.createElement("div");
  title.className = "control-title";

  const meta = document.createElement("div");
  meta.className = "control-meta";
  const persisted = loadLfoSettings(node);
  meta.textContent = buildLfoMeta({
    ...node,
    depth: persisted.depth,
    rate: persisted.rate,
    waveform: persisted.waveform,
  });

  chrome.append(meta, title);
  wrapper.append(fill, chrome);

  const state = createLfoState(node, persisted, {
    element: wrapper,
    fill,
    title,
    meta,
    mode: "simple",
  });

  const hasTransition = Number(state.transitionDuration) > 0 && Number.isFinite(state.transitionFrom);
  updateLfoVisuals(
    state,
    quantizeSliderValue(state, hasTransition ? state.transitionFrom : state.value)
  );

  const endPointer = (event) => {
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
    saveLfoSettings(state);
  };

  wrapper.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    stopLfoVisualTransition(state);
    ensureLfoAnimation(state);
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.depthStart = state.depth;
    state.rateStart = shouldQuantizeLfoRate(state) ? normalizeLfoRate(state.rate, state) : state.rate;
    wrapper.setPointerCapture(event.pointerId);
  });

  wrapper.addEventListener("pointermove", (event) => {
    if (!wrapper.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    updateSimpleLfoFromPointer(state, event);
  });

  wrapper.addEventListener("pointerup", endPointer);
  wrapper.addEventListener("pointercancel", endPointer);

  wrapper.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const normalizedX = normalizeWheelDelta(event, event.deltaX);
      const normalizedY = normalizeWheelDelta(event, event.deltaY);
      if (normalizedY !== 0) {
        state.depth = clamp(state.depth + (-normalizedY / 320), 0, 1);
      }
      if (normalizedX !== 0) {
        if (shouldQuantizeLfoRate(state)) {
          setLfoRateFromNormalizedValue(
            state,
            normalizeLfoRate(state.rate, state) + normalizedX / 480
          );
        } else {
          setLfoRate(state, state.rate + normalizedX / 480);
        }
      }
      updateLfoVisuals(state, state.value);
      saveLfoSettings(state);
    },
    { passive: false }
  );

  if (hasTransition) {
    animateLfoVisualTransition(state, node.value, () => startLfoAnimation(state));
  } else {
    queueSliderUpdate(state, state.value);
    startLfoAnimation(state);
  }
  return wrapper;
}

function renderComplexLfo(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "lfo-complex";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--accent", node.color || "#d26a2e");

  const animatedFill = document.createElement("div");
  animatedFill.className = "lfo-complex-fill";

  const title = document.createElement("div");
  title.className = "lfo-complex-title";
  title.textContent = node.name;

  const grid = document.createElement("div");
  grid.className = "lfo-grid";
  const persisted = loadLfoSettings(node);
  const panels = {
    value: createLfoPanel({ label: "Center" }),
    depth: createLfoPanel({ label: "Depth" }),
    rate: createLfoPanel({ label: "Speed" }),
    shape: createLfoPanel({ label: "Wave" }),
  };

  grid.append(panels.value.element, panels.depth.element, panels.rate.element, panels.shape.element);
  wrapper.append(animatedFill, grid, title);

  const state = createLfoState(node, persisted, {
    element: wrapper,
    mode: "complex",
    animatedFill,
    panels,
  });

  attachLfoPanelInteraction(panels.value, state, "midpoint");
  attachLfoPanelInteraction(panels.depth, state, "depth");
  attachLfoPanelInteraction(panels.rate, state, "rate");
  attachLfoPanelInteraction(panels.shape, state, getLfoShapeParameter(state));

  const hasTransition = Number(state.transitionDuration) > 0 && Number.isFinite(state.transitionFrom);
  updateLfoVisuals(
    state,
    quantizeSliderValue(state, hasTransition ? state.transitionFrom : state.value)
  );
  if (hasTransition) {
    animateLfoVisualTransition(state, node.value, () => startLfoAnimation(state));
  } else {
    queueSliderUpdate(state, state.value);
    startLfoAnimation(state);
  }
  return wrapper;
}

function createLfoState(node, persisted, extraState) {
  const state = {
    ...node,
    ...extraState,
    pendingRequest: false,
    queuedValue: null,
    lastSentValue: null,
    dragStartX: 0,
    dragStartY: 0,
    depthStart: persisted.depth,
    rateStart: persisted.rate,
    depth: persisted.depth,
    rate: persisted.rate,
    midpoint: persisted.midpoint,
    waveform: persisted.waveform,
    jitter: persisted.jitter,
    phase: 0,
    noiseValue: 0,
    noiseTarget: 0,
    noiseCountdown: 0,
    sampleHoldValue: (Math.random() * 2) - 1,
    animationFrame: null,
    visualTransitionFrame: null,
    lastFrameTime: null,
    tempo: transportState.tempo,
    tempoDivisionBeats: persisted.tempoDivisionBeats,
  };
  if (shouldQuantizeLfoRate(state) && state.rate > 0) {
    const division = closestLfoTempoDivisionForRate(state.rate, state);
    state.tempoDivisionBeats = division.beats;
    state.rate = rateForTempoDivision(division.beats, state);
  }
  state.waveform = currentLfoWaveform(state);
  lfoViews.add(state);
  return state;
}

function createLfoPanel({ label }) {
  const element = document.createElement("section");
  element.className = "lfo-panel";

  const fill = document.createElement("div");
  fill.className = "lfo-panel-fill";

  const chrome = document.createElement("div");
  chrome.className = "lfo-panel-chrome";

  const labelNode = document.createElement("div");
  labelNode.className = "lfo-panel-label";
  labelNode.textContent = label;

  chrome.append(labelNode);
  element.append(fill, chrome);
  return { element, fill, labelNode };
}

function attachLfoPanelInteraction(panel, state, parameter) {
  const drag = {
    active: false,
    pointerId: null,
    startY: 0,
    startValue: 0,
  };

  panel.element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    stopLfoVisualTransition(state);
    ensureLfoAnimation(state);
    drag.active = true;
    drag.pointerId = event.pointerId;
    drag.startY = event.clientY;
    drag.startValue = getLfoParameterValue(state, parameter);
    panel.element.setPointerCapture(event.pointerId);
  });

  panel.element.addEventListener("pointermove", (event) => {
    if (!drag.active || !panel.element.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    const rect = panel.element.getBoundingClientRect();
    const travel = (drag.startY - event.clientY) / (rect.height || 1);
    setLfoParameterValue(state, parameter, drag.startValue, travel);
    updateLfoVisuals(state, state.value);
  });

  const finish = (event) => {
    if (!drag.active || drag.pointerId !== event.pointerId) {
      return;
    }
    drag.active = false;
    if (panel.element.hasPointerCapture(event.pointerId)) {
      panel.element.releasePointerCapture(event.pointerId);
    }
    saveLfoSettings(state);
  };

  panel.element.addEventListener("pointerup", finish);
  panel.element.addEventListener("pointercancel", finish);

  panel.element.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const normalizedDelta = normalizeWheelDelta(event, event.deltaY);
      setLfoParameterValue(state, parameter, getLfoParameterValue(state, parameter), normalizedDelta / 280);
      updateLfoVisuals(state, state.value);
      saveLfoSettings(state);
    },
    { passive: false }
  );
}

function updateSimpleLfoFromPointer(state, event) {
  const rect = state.element.getBoundingClientRect();
  const depthTravel = (state.dragStartY - event.clientY) / (rect.height || 1);
  const rateTravel = (event.clientX - state.dragStartX) / (rect.width || 1);
  state.depth = clamp(state.depthStart + depthTravel, 0, 1);
  if (shouldQuantizeLfoRate(state)) {
    setLfoRateFromNormalizedValue(state, state.rateStart + rateTravel);
  } else {
    setLfoRate(state, state.rateStart + rateTravel * getLfoRateMax(state));
  }
  updateLfoVisuals(state, state.value);
}

function updateLfoVisuals(state, value) {
  state.value = value;
  if (state.mode === "complex") {
    updateComplexLfoVisuals(state);
    return;
  }

  state.title.textContent = state.name;
  state.meta.textContent = buildLfoMeta(state);
  updateLfoRangeFill(state.fill, (state.value - state.min) / (state.max - state.min || 1));
}

function animateLfoVisualTransition(state, targetValue, onComplete) {
  const durationSeconds = Number(state.transitionDuration) || 0;
  const startValue = state.value;
  const endValue = quantizeSliderValue(state, targetValue);
  if (durationSeconds <= 0 || startValue === endValue) {
    updateLfoVisuals(state, endValue);
    queueSliderUpdate(state, endValue);
    onComplete();
    return;
  }

  const durationMs = durationSeconds * 1000;
  const startedAt = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / Math.max(durationMs, 1));
    const nextValue = quantizeSliderValue(
      state,
      startValue + ((endValue - startValue) * progress)
    );
    updateLfoVisuals(state, nextValue);
    if (progress >= 1) {
      state.visualTransitionFrame = null;
      queueSliderUpdate(state, endValue);
      onComplete();
      return;
    }
    state.visualTransitionFrame = window.requestAnimationFrame(tick);
  };

  state.visualTransitionFrame = window.requestAnimationFrame(tick);
}

function stopLfoVisualTransition(state) {
  if (state.visualTransitionFrame !== null) {
    window.cancelAnimationFrame(state.visualTransitionFrame);
    state.visualTransitionFrame = null;
  }
}

function ensureLfoAnimation(state) {
  if (state.animationFrame !== null) {
    return;
  }
  queueSliderUpdate(state, state.value);
  startLfoAnimation(state);
}

function buildLfoMeta(node) {
  const rateLabel = shouldQuantizeLfoRate(node)
    ? `${currentLfoTempoDivision(node).label} @ ${formatTempo(node.tempo)} BPM`
    : `${node.rate.toFixed(2)} Hz`;
  const parts = [
    `CH ${node.channel}  CC ${node.control}`,
    `DEPTH ${Math.round(node.depth * 100)}%`,
    `RATE ${rateLabel}`,
  ];
  if (shouldUseWaveformControl(node)) {
    parts.push(`WAVE ${formatWaveformName(currentLfoWaveform(node))}`);
  }
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
  }
  return parts.join("\n");
}

function updateComplexLfoVisuals(state) {
  state.panels.rate.labelNode.textContent = shouldQuantizeLfoRate(state)
    ? `Speed (${formatLfoSpeedLabel(state)})`
    : "Speed";
  state.panels.shape.labelNode.textContent = shouldUseWaveformControl(state)
    ? `Wave (${formatWaveformName(currentLfoWaveform(state))})`
    : "Jitter";
  updateLfoRangeFill(
    state.animatedFill,
    (state.value - state.min) / (state.max - state.min || 1)
  );
  updateLfoPanelFill(
    state.panels.value.fill,
    (state.midpoint - state.min) / (state.max - state.min || 1)
  );
  updateLfoPanelFill(state.panels.depth.fill, state.depth);
  updateLfoPanelFill(state.panels.rate.fill, normalizeLfoRate(state.rate, state));
  updateLfoPanelFill(
    state.panels.shape.fill,
    shouldUseWaveformControl(state) ? normalizeLfoWaveform(state) : state.jitter
  );
}

function updateLfoRangeFill(fill, valueRatio) {
  const boundedValue = clamp(valueRatio, 0, 1);
  fill.style.width = "100%";
  fill.style.transform = "";
  fill.style.top = "auto";
  fill.style.bottom = "0";
  fill.style.height = `${boundedValue * 100}%`;
}

function updateLfoPanelFill(fill, ratio) {
  fill.style.top = "auto";
  fill.style.bottom = "0";
  fill.style.transform = "";
  fill.style.width = "100%";
  fill.style.height = `${clamp(ratio, 0, 1) * 100}%`;
}

function getLfoParameterValue(state, parameter) {
  if (parameter === "midpoint") {
    return state.midpoint;
  }
  if (parameter === "depth") {
    return state.depth;
  }
  if (parameter === "rate") {
    return normalizeLfoRate(state.rate, state);
  }
  if (parameter === "waveform") {
    return normalizeLfoWaveform(state);
  }
  return state.jitter;
}

function setLfoParameterValue(state, parameter, startValue, travel) {
  if (parameter === "midpoint") {
    const range = state.max - state.min;
    state.midpoint = clamp(startValue + travel * range, state.min, state.max);
    return;
  }
  if (parameter === "depth") {
    state.depth = clamp(startValue + travel, 0, 1);
    return;
  }
  if (parameter === "rate") {
    setLfoRateFromNormalizedValue(state, startValue + travel);
    return;
  }
  if (parameter === "waveform") {
    setLfoWaveformFromNormalizedValue(state, startValue + travel);
    return;
  }
  state.jitter = clamp(startValue + travel, 0, 1);
}

function getLfoShapeParameter(state) {
  return shouldUseWaveformControl(state) ? "waveform" : "jitter";
}

function shouldUseWaveformControl(state) {
  return state.shapeControl !== "jitter";
}

function normalizeLfoRate(rate, state) {
  if (shouldQuantizeLfoRate(state)) {
    const options = lfoRateOptions(state);
    const selectedIndex = lfoRateOptionIndex(state);
    return options.length <= 1 ? 0 : selectedIndex / (options.length - 1);
  }

  const maxRate = getLfoRateMax(state);
  if (maxRate <= 0) {
    return 0;
  }
  return clamp(rate, 0, maxRate) / maxRate;
}

function denormalizeLfoRate(value, state) {
  if (shouldQuantizeLfoRate(state)) {
    const options = lfoRateOptions(state);
    const index = Math.round(clamp(value, 0, 1) * Math.max(options.length - 1, 0));
    const option = options[index] ?? options[0];
    if (!option || option.rate === 0) {
      return 0;
    }
    state.tempoDivisionBeats = option.beats;
    return option.rate;
  }

  return quantizeLfoRate(clamp(value, 0, 1) * getLfoRateMax(state), state);
}

function getLfoRateMax(state) {
  return Math.max(0, Number(state.maxSpeed ?? LFO_RATE_MAX) || 0);
}

function setLfoRate(state, rate) {
  state.rate = quantizeLfoRate(rate, state);
}

function setLfoRateFromNormalizedValue(state, value) {
  state.rate = denormalizeLfoRate(clamp(value, 0, 1), state);
}

function shouldQuantizeLfoRate(state) {
  return Boolean(state.quantizeSpeedToTempoDivisions);
}

function normalizeLfoWaveform(state) {
  const waveforms = getLfoWaveforms(state);
  if (waveforms.length <= 1) {
    return 0;
  }
  return lfoWaveformIndex(state) / (waveforms.length - 1);
}

function setLfoWaveformFromNormalizedValue(state, value) {
  const waveforms = getLfoWaveforms(state);
  const index = Math.round(clamp(value, 0, 1) * Math.max(waveforms.length - 1, 0));
  state.waveform = waveforms[index] ?? waveforms[0];
}

function currentLfoWaveform(state) {
  const waveforms = getLfoWaveforms(state);
  return waveforms.includes(state.waveform) ? state.waveform : waveforms[0];
}

function lfoWaveformIndex(state) {
  return getLfoWaveforms(state).indexOf(currentLfoWaveform(state));
}

function getLfoWaveforms(state) {
  if (!Array.isArray(state.waveforms) || state.waveforms.length === 0) {
    return ["sine"];
  }
  return state.waveforms;
}

function formatWaveformName(waveform) {
  if (waveform === "s&h") {
    return "S&H";
  }
  return waveform.replace(/_/g, " ");
}

function quantizeLfoRate(rate, state) {
  const boundedRate = clamp(rate, 0, getLfoRateMax(state));
  if (!shouldQuantizeLfoRate(state) || boundedRate <= 0) {
    return boundedRate;
  }
  const division = closestLfoTempoDivisionForRate(boundedRate, state);
  state.tempoDivisionBeats = division.beats;
  return rateForTempoDivision(division.beats, state);
}

function closestLfoTempoDivisionForRate(rate, state) {
  const divisions = availableLfoTempoDivisions(state);
  if (divisions.length === 0) {
    return LFO_TEMPO_DIVISIONS[0];
  }
  return divisions.reduce((closest, division) => {
    const closestDistance = Math.abs(rate - rateForTempoDivision(closest.beats, state));
    const nextDistance = Math.abs(rate - rateForTempoDivision(division.beats, state));
    return nextDistance < closestDistance ? division : closest;
  }, divisions[0]);
}

function currentLfoTempoDivision(state) {
  const matching = LFO_TEMPO_DIVISIONS.find((division) => division.beats === state.tempoDivisionBeats);
  return matching ?? closestLfoTempoDivisionForRate(state.rate, state);
}

function lfoRateOptions(state) {
  return [
    { label: "0", beats: 0, rate: 0 },
    ...availableLfoTempoDivisions(state).map((division) => ({
      ...division,
      rate: rateForTempoDivision(division.beats, state),
    })),
  ];
}

function lfoRateOptionIndex(state) {
  if (state.rate <= 0) {
    return 0;
  }
  const options = lfoRateOptions(state);
  const index = options.findIndex((option) => option.beats === state.tempoDivisionBeats);
  if (index >= 0) {
    return index;
  }
  const division = currentLfoTempoDivision(state);
  const fallbackIndex = options.findIndex((option) => option.beats === division.beats);
  return fallbackIndex >= 0 ? fallbackIndex : 0;
}

function formatLfoSpeedLabel(state) {
  if (state.rate <= 0) {
    return "0";
  }
  return formatTempoDivisionName(currentLfoTempoDivision(state));
}

function formatTempoDivisionName(division) {
  const match = /^1\/(\d+)(\.?)$/.exec(division.label);
  if (match === null) {
    return withNonBreakingSpaces(division.label);
  }

  const denominator = Number(match[1]);
  const suffix = match[2];
  const name = denominator === 1 ? "bar" : `${denominator}${ordinalSuffix(denominator)}`;
  if (suffix === ".") {
    return withNonBreakingSpaces(`${name}.`);
  }
  return withNonBreakingSpaces(name);
}

function withNonBreakingSpaces(value) {
  return value.replace(/ /g, "\u00a0");
}

function ordinalSuffix(value) {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) {
    return "th";
  }
  if (value % 10 === 1) {
    return "st";
  }
  if (value % 10 === 2) {
    return "nd";
  }
  if (value % 10 === 3) {
    return "rd";
  }
  return "th";
}

function availableLfoTempoDivisions(state) {
  const maxRate = getLfoRateMax(state);
  return LFO_TEMPO_DIVISIONS.filter((division) => rawRateForTempoDivision(division.beats, state) <= maxRate);
}

function rateForTempoDivision(beats, state) {
  return clamp(rawRateForTempoDivision(beats, state), 0, getLfoRateMax(state));
}

function rawRateForTempoDivision(beats, state) {
  const tempo = Math.max(Number(state.tempo) || transportState.tempo || 120, 1);
  const divisionBeats = Math.max(Number(beats) || 1, 0.001);
  return (tempo / 60) / divisionBeats;
}

function formatTempo(tempo) {
  const value = Number(tempo) || 120;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function getLfoShapeValue(state) {
  const cyclePosition = ((state.phase / (Math.PI * 2)) % 1 + 1) % 1;
  switch (currentLfoWaveform(state)) {
    case "triangle":
      return 1 - (4 * Math.abs(cyclePosition - 0.5));
    case "square":
      return cyclePosition < 0.5 ? 1 : -1;
    case "saw":
      return (cyclePosition * 2) - 1;
    case "ramp":
      return 1 - (cyclePosition * 2);
    case "random":
      return state.noiseValue;
    case "s&h":
      return state.sampleHoldValue;
    case "sine":
    default:
      return Math.sin(state.phase);
  }
}

function startLfoAnimation(state) {
  const tick = (now) => {
    if (state.lastFrameTime === null) {
      state.lastFrameTime = now;
    }
    const elapsedSeconds = Math.max((now - state.lastFrameTime) / 1000, 0);
    state.lastFrameTime = now;
    if (state.rate > 0) {
      const previousPhase = state.phase;
      state.phase = (state.phase + elapsedSeconds * state.rate * Math.PI * 2) % (Math.PI * 2);
      if (currentLfoWaveform(state) === "s&h" && state.phase < previousPhase) {
        state.sampleHoldValue = (Math.random() * 2) - 1;
      }

      state.noiseCountdown -= elapsedSeconds;
      if (state.noiseCountdown <= 0) {
        state.noiseCountdown = (0.12 + Math.random() * 0.18) / state.rate;
        state.noiseTarget = (Math.random() * 2) - 1;
      }
      state.noiseValue +=
        (state.noiseTarget - state.noiseValue) * Math.min(1, elapsedSeconds * 4 * state.rate);
    }

    const center = state.midpoint;
    const amplitude = ((state.max - state.min) / 2) * state.depth;
    const lfoShape = getLfoShapeValue(state);
    const compositeShape = shouldUseWaveformControl(state)
      ? lfoShape
      : ((1 - state.jitter) * lfoShape) + (state.jitter * state.noiseValue);
    const nextValue = quantizeSliderValue(
      state,
      clamp(center + compositeShape * amplitude, state.min, state.max)
    );

    if (nextValue !== state.value) {
      updateLfoVisuals(state, nextValue);
    }
    if (nextValue !== state.lastSentValue) {
      state.lastSentValue = nextValue;
      queueSliderUpdate(state, nextValue);
    }

    state.animationFrame = window.requestAnimationFrame(tick);
  };

  state.animationFrame = window.requestAnimationFrame(tick);
}

function loadLfoSettings(node) {
  const defaultWaveform = getLfoWaveforms(node)[0];
  try {
    const raw = window.localStorage.getItem(`${LFO_STORAGE_PREFIX}${node.key}`);
    if (!raw) {
      return {
        midpoint: node.value,
        depth: 0.35,
        rate: Math.min(1, getLfoRateMax(node)),
        tempoDivisionBeats: 1,
        waveform: defaultWaveform,
        jitter: 0,
      };
    }
    const parsed = JSON.parse(raw);
    const midpoint = Number(parsed.midpoint);
    const depth = Number(parsed.depth);
    const rate = Number(parsed.rate);
    const tempoDivisionBeats = Number(parsed.tempoDivisionBeats);
    const waveform = typeof parsed.waveform === "string" ? parsed.waveform : defaultWaveform;
    const jitter = Number(parsed.jitter);
    return {
      midpoint: clamp(Number.isFinite(midpoint) ? midpoint : node.value, node.min, node.max),
      depth: clamp(Number.isFinite(depth) ? depth : 0.35, 0, 1),
      rate: clamp(
        Number.isFinite(rate) ? rate : Math.min(1, getLfoRateMax(node)),
        0,
        getLfoRateMax(node)
      ),
      tempoDivisionBeats: Number.isFinite(tempoDivisionBeats) && tempoDivisionBeats > 0
        ? tempoDivisionBeats
        : 1,
      waveform: getLfoWaveforms(node).includes(waveform) ? waveform : defaultWaveform,
      jitter: clamp(Number.isFinite(jitter) ? jitter : 0, 0, 1),
    };
  } catch (_error) {
    return {
      midpoint: node.value,
      depth: 0.35,
      rate: Math.min(1, getLfoRateMax(node)),
      tempoDivisionBeats: 1,
      waveform: defaultWaveform,
      jitter: 0,
    };
  }
}

function saveLfoSettings(state) {
  try {
    window.localStorage.setItem(
      `${LFO_STORAGE_PREFIX}${state.key}`,
      JSON.stringify({
        midpoint: state.midpoint,
        depth: state.depth,
        rate: state.rate,
        tempoDivisionBeats: state.tempoDivisionBeats,
        waveform: currentLfoWaveform(state),
        jitter: state.jitter,
      })
    );
  } catch (_error) {
  }
}
