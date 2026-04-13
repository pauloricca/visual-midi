import {
  INERTIA_FRICTION_PER_FRAME,
  INERTIA_MIN_VELOCITY,
  INERTIA_VELOCITY_THRESHOLD,
  clamp,
  computeWheelValueDelta,
  normalizeWheelDelta,
  quantizeSliderValue,
} from "../utils/math.js";
import { applyNodeSizing } from "../utils/layout.js";
import { queueSliderUpdate } from "./slider.js";

const LFO_STORAGE_PREFIX = "visual-midi:lfo:";
const LFO_RATE_MAX = 12;
const LFO_TAP_WINDOW_MS = 420;
const LFO_TAP_MOVE_PX = 10;
const LFO_TAP_MAX_MS = 280;
const LFO_TEMPO_DIVISIONS = [
  { label: "16 bar", beats: 64 },
  { label: "8 bar", beats: 32 },
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
  return renderUnifiedSlider(node);
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
      syncLfoAnimationState(state);
    }
  });
}

export function clearLfoViews() {
  lfoViews.forEach((state) => {
    stopLfoAnimation(state);
    stopLfoVisualTransition(state);
    stopSliderInertia(state);
  });
  lfoViews.clear();
}

function renderUnifiedSlider(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "slider-lfo-host";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--accent", node.color || "#d26a2e");
  suppressDoubleTapZoom(wrapper);

  const persisted = loadLfoSettings(node);
  if (persisted.depth <= 0 || persisted.rate <= 0) {
    persisted.midpoint = node.value;
  }
  const state = createLfoState(node, persisted, {
    element: wrapper,
    mode: null,
    viewMode: node.type === "lfo" ? "lfo" : "slider",
    fill: null,
    title: null,
    meta: null,
    animatedFill: null,
    panels: null,
    sliderPointerId: null,
    dragStartValue: persisted.midpoint,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerTime: 0,
    velocity: 0,
    inertiaFrame: null,
    wheelRemainder: 0,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
    pointerDownTime: 0,
  });

  mountCurrentLfoView(state);
  const hasTransition = Number(state.transitionDuration) > 0 && Number.isFinite(state.transitionFrom);
  updateLfoVisuals(
    state,
    quantizeSliderValue(state, hasTransition ? state.transitionFrom : state.value)
  );

  if (hasTransition) {
    animateLfoVisualTransition(state, node.value, () => syncLfoAnimationState(state));
  } else {
    syncInactiveLfoOutput(state);
    syncLfoAnimationState(state);
  }

  return wrapper;
}

function mountCurrentLfoView(state) {
  stopSliderInertia(state);
  if (state.viewMode === "lfo") {
    mountLfoControls(state);
  } else {
    mountSliderSurface(state);
  }
  state.element.classList.toggle("slider-lfo-host--lfo", state.viewMode === "lfo");
  state.element.classList.toggle("slider-lfo-host--slider", state.viewMode !== "lfo");
  updateLfoVisuals(state, state.value);
}

function mountSliderSurface(state) {
  const surface = document.createElement("section");
  surface.className = `control control--${state.orientation}`;
  surface.dataset.key = state.key;
  suppressDoubleTapZoom(surface);

  const fill = document.createElement("div");
  fill.className = "control-fill";

  const chrome = document.createElement("div");
  chrome.className = "control-chrome";

  const title = document.createElement("div");
  title.className = "control-title";

  const meta = document.createElement("div");
  meta.className = "control-meta";

  chrome.append(meta, title);
  surface.append(fill, chrome);
  state.element.replaceChildren(surface);
  state.mode = "slider";
  state.fill = fill;
  state.title = title;
  state.meta = meta;
  state.animatedFill = null;
  state.panels = null;

  surface.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (consumeLfoToggleGesture(state, event)) {
      return;
    }
    stopLfoVisualTransition(state);
    stopSliderInertia(state);
    state.sliderPointerId = event.pointerId;
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.dragStartValue = state.midpoint;
    state.lastPointerX = event.clientX;
    state.lastPointerY = event.clientY;
    state.lastPointerTime = performance.now();
    state.pointerDownTime = state.lastPointerTime;
    state.velocity = 0;
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener("pointermove", (event) => {
    if (!surface.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    updateSliderMidpointFromPointer(state, event, performance.now());
  });

  const finish = (event) => {
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
    rememberTapGesture(state, event);
    state.sliderPointerId = null;
    maybeStartSliderInertia(state);
    saveLfoSettings(state);
  };

  surface.addEventListener("pointerup", finish);
  surface.addEventListener("pointercancel", (event) => {
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
    state.sliderPointerId = null;
    stopSliderInertia(state);
    saveLfoSettings(state);
  });

  surface.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stopSliderInertia(state);
      const axisDelta = state.orientation === "vertical" ? event.deltaY : event.deltaX;
      if (axisDelta === 0) {
        return;
      }
      const normalizedDelta = normalizeWheelDelta(event, axisDelta);
      const valueDelta = computeWheelValueDelta(state, normalizedDelta);
      if (valueDelta === 0) {
        return;
      }
      setSliderMidpoint(state, state.midpoint + valueDelta);
      saveLfoSettings(state);
    },
    { passive: false }
  );
}

function mountLfoControls(state) {
  if (state.complex) {
    mountComplexLfoControls(state);
  } else {
    mountSimpleLfoControls(state);
  }
}

function mountSimpleLfoControls(state) {
  const surface = document.createElement("section");
  surface.className = "control control--vertical control--lfo";
  surface.dataset.key = state.key;
  suppressDoubleTapZoom(surface);

  const fill = document.createElement("div");
  fill.className = "control-fill";

  const chrome = document.createElement("div");
  chrome.className = "control-chrome";

  const title = document.createElement("div");
  title.className = "control-title";

  const meta = document.createElement("div");
  meta.className = "control-meta";

  chrome.append(meta, title);
  surface.append(fill, chrome);
  state.element.replaceChildren(surface);
  state.mode = "simple";
  state.fill = fill;
  state.title = title;
  state.meta = meta;
  state.animatedFill = null;
  state.panels = null;

  const endPointer = (event) => {
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
    rememberTapGesture(state, event);
    saveLfoSettings(state);
    syncLfoAnimationState(state);
  };

  surface.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (consumeLfoToggleGesture(state, event)) {
      return;
    }
    stopLfoVisualTransition(state);
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.pointerDownTime = performance.now();
    state.depthStart = state.depth;
    state.rateStart = shouldQuantizeLfoRate(state) ? normalizeLfoRate(state.rate, state) : state.rate;
    surface.setPointerCapture(event.pointerId);
  });

  surface.addEventListener("pointermove", (event) => {
    if (!surface.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    updateSimpleLfoFromPointer(state, event);
    syncLfoAnimationState(state);
  });

  surface.addEventListener("pointerup", endPointer);
  surface.addEventListener("pointercancel", endPointer);

  surface.addEventListener(
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
      syncLfoAnimationState(state);
    },
    { passive: false }
  );
}

function mountComplexLfoControls(state) {
  const surface = document.createElement("section");
  surface.className = "lfo-complex";
  surface.dataset.key = state.key;
  suppressDoubleTapZoom(surface);

  const animatedFill = document.createElement("div");
  animatedFill.className = "lfo-complex-fill";

  const title = document.createElement("div");
  title.className = "lfo-complex-title";
  title.textContent = state.name;

  const grid = document.createElement("div");
  grid.className = "lfo-grid";
  const panels = {
    value: createLfoPanel({ label: "Center" }),
    depth: createLfoPanel({ label: "Depth" }),
    rate: createLfoPanel({ label: "Speed" }),
    shape: createLfoPanel({ label: "Wave" }),
  };

  grid.append(panels.value.element, panels.depth.element, panels.rate.element, panels.shape.element);
  surface.append(animatedFill, grid, title);
  state.element.replaceChildren(surface);
  state.mode = "complex";
  state.fill = null;
  state.title = null;
  state.meta = null;
  state.animatedFill = animatedFill;
  state.panels = panels;

  attachLfoToggleGesture(surface, state);
  attachLfoPanelInteraction(panels.value, state, "midpoint");
  attachLfoPanelInteraction(panels.depth, state, "depth");
  attachLfoPanelInteraction(panels.rate, state, "rate");
  attachLfoPanelInteraction(panels.shape, state, getLfoShapeParameter(state));
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
  suppressDoubleTapZoom(element);

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
    if (consumeLfoToggleGesture(state, event)) {
      return;
    }
    stopLfoVisualTransition(state);
    ensureLfoAnimation(state);
    drag.active = true;
    drag.pointerId = event.pointerId;
    drag.startY = event.clientY;
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.pointerDownTime = performance.now();
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
    syncLfoAnimationState(state);
  });

  const finish = (event) => {
    if (!drag.active || drag.pointerId !== event.pointerId) {
      return;
    }
    drag.active = false;
    if (panel.element.hasPointerCapture(event.pointerId)) {
      panel.element.releasePointerCapture(event.pointerId);
    }
    rememberTapGesture(state, event);
    saveLfoSettings(state);
    syncLfoAnimationState(state);
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
      syncLfoAnimationState(state);
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

function consumeLfoToggleGesture(state, event) {
  const now = performance.now();
  const isSecondTap =
    now - state.lastTapTime < LFO_TAP_WINDOW_MS &&
    pointerDistance(event.clientX, event.clientY, state.lastTapX, state.lastTapY) <= LFO_TAP_MOVE_PX;
  if (!isSecondTap) {
    return false;
  }

  state.lastTapTime = 0;
  if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  toggleLfoControls(state);
  return true;
}

function attachLfoToggleGesture(element, state) {
  element.addEventListener("pointerdown", (event) => {
    if (event.target !== element) {
      return;
    }
    if (consumeLfoToggleGesture(state, event)) {
      event.preventDefault();
      return;
    }
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.pointerDownTime = performance.now();
  });

  element.addEventListener("pointerup", (event) => {
    rememberTapGesture(state, event);
  });
}

function rememberTapGesture(state, event) {
  if (event.type !== "pointerup") {
    return;
  }
  const now = performance.now();
  const duration = now - state.pointerDownTime;
  const moved = pointerDistance(event.clientX, event.clientY, state.dragStartX, state.dragStartY);
  if (duration > LFO_TAP_MAX_MS || moved > LFO_TAP_MOVE_PX) {
    return;
  }
  state.lastTapTime = now;
  state.lastTapX = event.clientX;
  state.lastTapY = event.clientY;
}

function pointerDistance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function suppressDoubleTapZoom(element) {
  let lastTouchEnd = 0;
  element.addEventListener(
    "dblclick",
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );
  element.addEventListener(
    "touchend",
    (event) => {
      const now = performance.now();
      if (now - lastTouchEnd < LFO_TAP_WINDOW_MS) {
        event.preventDefault();
      }
      lastTouchEnd = now;
    },
    { passive: false }
  );
  element.addEventListener(
    "gesturestart",
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );
}

function toggleLfoControls(state) {
  state.viewMode = state.viewMode === "lfo" ? "slider" : "lfo";
  saveLfoSettings(state);
  mountCurrentLfoView(state);
  syncLfoAnimationState(state);
}

function updateSliderMidpointFromPointer(state, event, now) {
  const rect = event.currentTarget.getBoundingClientRect();
  const speed = state.speed || 1;
  const travel =
    state.orientation === "vertical"
      ? -((event.clientY - state.dragStartY) / (rect.height || 1))
      : (event.clientX - state.dragStartX) / (rect.width || 1);
  const rawValue = state.dragStartValue + travel * (state.max - state.min) * speed;
  setSliderMidpoint(state, rawValue);
  updateSliderVelocity(state, event, now, rect);
}

function setSliderMidpoint(state, rawValue) {
  const nextMidpoint = quantizeSliderValue(state, clamp(rawValue, state.min, state.max));
  if (nextMidpoint === state.midpoint) {
    return;
  }
  state.midpoint = nextMidpoint;
  syncInactiveLfoOutput(state);
  updateLfoVisuals(state, state.value);
  syncLfoAnimationState(state);
}

function updateSliderVelocity(state, event, now, rect) {
  const speed = state.speed || 1;
  const pointerDelta =
    state.orientation === "vertical"
      ? -(event.clientY - state.lastPointerY) / (rect.height || 1)
      : (event.clientX - state.lastPointerX) / (rect.width || 1);
  const timeDelta = Math.max(now - state.lastPointerTime, 1);
  const instantVelocity = ((pointerDelta * (state.max - state.min) * speed) * 1000) / timeDelta;
  state.velocity = state.velocity * 0.35 + instantVelocity * 0.65;
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;
  state.lastPointerTime = now;
}

function maybeStartSliderInertia(state) {
  const scaledVelocity = state.velocity * (state.inertia ?? 1);
  if (Math.abs(scaledVelocity) < INERTIA_VELOCITY_THRESHOLD) {
    state.velocity = 0;
    return;
  }
  state.velocity = scaledVelocity;

  let previousTime = performance.now();
  const tick = (now) => {
    const elapsed = Math.max(now - previousTime, 1);
    previousTime = now;

    const previousMidpoint = state.midpoint;
    setSliderMidpoint(state, state.midpoint + (state.velocity * elapsed) / 1000);

    state.velocity *= Math.pow(INERTIA_FRICTION_PER_FRAME, elapsed / 16.67);
    const hitBoundary = state.midpoint === state.min || state.midpoint === state.max;
    if (
      Math.abs(state.velocity) < INERTIA_MIN_VELOCITY ||
      hitBoundary ||
      state.midpoint === previousMidpoint
    ) {
      state.velocity = 0;
      state.inertiaFrame = null;
      saveLfoSettings(state);
      return;
    }

    state.inertiaFrame = window.requestAnimationFrame(tick);
  };

  state.inertiaFrame = window.requestAnimationFrame(tick);
}

function stopSliderInertia(state) {
  if (state.inertiaFrame !== null) {
    window.cancelAnimationFrame(state.inertiaFrame);
    state.inertiaFrame = null;
  }
  state.velocity = 0;
}

function isLfoActive(state) {
  return state.depth > 0 && state.rate > 0;
}

function syncInactiveLfoOutput(state) {
  if (isLfoActive(state)) {
    return;
  }
  const nextValue = quantizeSliderValue(state, state.midpoint);
  if (nextValue !== state.value) {
    updateLfoVisuals(state, nextValue);
  }
  if (nextValue !== state.lastSentValue) {
    state.lastSentValue = nextValue;
    queueSliderUpdate(state, nextValue);
  }
}

function syncLfoAnimationState(state) {
  if (!isLfoActive(state)) {
    stopLfoAnimation(state);
    syncInactiveLfoOutput(state);
    return;
  }
  startLfoAnimation(state);
}

function stopLfoAnimation(state) {
  if (state.animationFrame !== null) {
    window.cancelAnimationFrame(state.animationFrame);
    state.animationFrame = null;
  }
  state.lastFrameTime = null;
}

function updateLfoVisuals(state, value) {
  state.value = value;
  if (state.mode === "slider") {
    state.title.textContent = state.name;
    state.meta.textContent = buildSliderMeta(state);
    if (state.orientation === "vertical") {
      state.fill.style.height = `${sliderValueRatio(state, state.value) * 100}%`;
      state.fill.style.width = "100%";
    } else {
      state.fill.style.width = `${sliderValueRatio(state, state.value) * 100}%`;
      state.fill.style.height = "100%";
    }
    return;
  }
  if (state.mode === "complex") {
    updateComplexLfoVisuals(state);
    return;
  }

  state.title.textContent = state.name;
  state.meta.textContent = buildLfoMeta(state);
  updateLfoRangeFill(state.fill, (state.value - state.min) / (state.max - state.min || 1));
}

function sliderValueRatio(state, value) {
  return (value - state.min) / (state.max - state.min || 1);
}

function buildSliderMeta(node) {
  const parts = [`CH ${node.channel}  CC ${node.control}`];
  if (isLfoActive(node)) {
    parts.push(`LFO ${Math.round(node.depth * 100)}% ${formatLfoSpeedLabel(node)}`);
  }
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push(`OSC Range ${node.osc.min}..${node.osc.max}`);
  }
  return parts.join("\n");
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
  syncLfoAnimationState(state);
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
    syncInactiveLfoOutput(state);
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
  if (state.animationFrame !== null || !isLfoActive(state)) {
    return;
  }
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

    if (isLfoActive(state)) {
      state.animationFrame = window.requestAnimationFrame(tick);
    } else {
      state.animationFrame = null;
      state.lastFrameTime = null;
      syncInactiveLfoOutput(state);
    }
  };

  state.animationFrame = window.requestAnimationFrame(tick);
}

function loadLfoSettings(node) {
  const defaultWaveform = getLfoWaveforms(node)[0];
  const defaultDepth = node.type === "lfo" ? 0.35 : 0;
  const defaultRate = node.type === "lfo" ? Math.min(1, getLfoRateMax(node)) : 0;
  try {
    const raw = window.localStorage.getItem(`${LFO_STORAGE_PREFIX}${node.key}`);
    if (!raw) {
      return {
        midpoint: node.value,
        depth: defaultDepth,
        rate: defaultRate,
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
      depth: clamp(Number.isFinite(depth) ? depth : defaultDepth, 0, 1),
      rate: clamp(
        Number.isFinite(rate) ? rate : defaultRate,
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
      depth: defaultDepth,
      rate: defaultRate,
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
