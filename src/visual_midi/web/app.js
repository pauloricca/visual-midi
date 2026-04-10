const titleNode = document.querySelector("#app-title");
const appHeader = document.querySelector(".app-header");
const layoutRoot = document.querySelector("#layout-root");
const qrPanel = document.querySelector("#qr-panel");
const qrLink = document.querySelector("#qr-link");
const qrImage = document.querySelector("#qr-image");

let currentVersion = null;
const gateRequestChains = new Map();
const sequencerViews = new Set();
let sequencerPlayheadTimer = null;
const transportState = {
  tempo: 120,
  playing: false,
};
const LFO_STORAGE_PREFIX = "visual-midi:lfo:";

const INERTIA_VELOCITY_THRESHOLD = 80;
const INERTIA_FRICTION_PER_FRAME = 0.9;
const INERTIA_MIN_VELOCITY = 8;
const WHEEL_STEP_SCALE = 0.72;
const WHEEL_DELTA_UNIT = 12;
const LFO_RATE_MAX = 12;
const SCALE_PATTERNS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  natural_minor: [0, 2, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  whole_tone: [0, 2, 4, 6, 8, 10],
  diminished_half_whole: [0, 1, 3, 4, 6, 7, 9, 10],
  diminished_whole_half: [0, 2, 3, 5, 6, 8, 9, 11],
};

function shouldHideQrPanel() {
  return new URLSearchParams(window.location.search).has("noqr");
}

function apiUrl(path) {
  const url = new URL(path, window.location.origin);
  if (shouldHideQrPanel()) {
    url.searchParams.set("noqr", "1");
  }
  return url.toString();
}

async function fetchConfig() {
  const response = await fetch(apiUrl("/api/config"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Config request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchVersion() {
  const response = await fetch("/api/version", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Version request failed: ${response.status}`);
  }
  return response.json();
}

function renderSlider(node) {
  const wrapper = document.createElement("article");
  wrapper.className = `control control--${node.orientation}`;
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--accent", node.color || "#d26a2e");

  const fill = document.createElement("div");
  fill.className = "control-fill";

  const chrome = document.createElement("div");
  chrome.className = "control-chrome";

  const top = document.createElement("div");
  top.className = "control-topline";

  const title = document.createElement("div");
  title.className = "control-title";

  const meta = document.createElement("div");
  meta.className = "control-meta";
  meta.textContent = buildSliderMeta(node);

  chrome.append(meta, title);
  wrapper.append(fill, chrome);

  const state = {
    ...node,
    element: wrapper,
    fill,
    title,
    pendingRequest: false,
    queuedValue: null,
    dragStartX: 0,
    dragStartY: 0,
    dragStartValue: node.value,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerTime: 0,
    velocity: 0,
    inertiaFrame: null,
    wheelRemainder: 0,
  };

  updateSliderVisuals(state, quantizeSliderValue(state, node.value));

  wrapper.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    stopInertia(state);
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.dragStartValue = state.value;
    state.lastPointerX = event.clientX;
    state.lastPointerY = event.clientY;
    state.lastPointerTime = performance.now();
    state.velocity = 0;
    wrapper.setPointerCapture(event.pointerId);
  });

  wrapper.addEventListener("pointermove", (event) => {
    if (!wrapper.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    updateFromPointer(state, event, performance.now());
  });

  wrapper.addEventListener("pointerup", (event) => {
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
    maybeStartInertia(state);
  });

  wrapper.addEventListener("pointercancel", (event) => {
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
    stopInertia(state);
  });

  wrapper.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stopInertia(state);
      const axisDelta = state.orientation === "vertical" ? event.deltaY : event.deltaX;
      if (axisDelta === 0) {
        return;
      }
      const normalizedDelta = normalizeWheelDelta(event, axisDelta);
      const valueDelta = computeWheelValueDelta(state, normalizedDelta);
      if (valueDelta === 0) {
        return;
      }
      const nextValue = quantizeSliderValue(
        state,
        clamp(state.value + valueDelta, state.min, state.max)
      );
      if (nextValue === state.value) {
        return;
      }
      updateSliderVisuals(state, nextValue);
      queueSliderUpdate(state, nextValue);
    },
    { passive: false }
  );

  return wrapper;
}

function renderLfo(node) {
  return node.complex ? renderComplexLfo(node) : renderSimpleLfo(node);
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
  meta.textContent = buildLfoMeta({ ...node, depth: persisted.depth, rate: persisted.rate });

  chrome.append(meta, title);
  wrapper.append(fill, chrome);

  const state = createLfoState(node, persisted, {
    element: wrapper,
    fill,
    title,
    meta,
    mode: "simple",
  });

  updateLfoVisuals(state, state.value);
  queueSliderUpdate(state, state.value);

  const endPointer = (event) => {
    if (wrapper.hasPointerCapture(event.pointerId)) {
      wrapper.releasePointerCapture(event.pointerId);
    }
    saveLfoSettings(state);
  };

  wrapper.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.depthStart = state.depth;
    state.rateStart = state.rate;
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
        state.rate = clamp(state.rate + normalizedX / 480, 0, getLfoRateMax(state));
      }
      updateLfoVisuals(state, state.value);
      saveLfoSettings(state);
    },
    { passive: false }
  );

  startLfoAnimation(state);
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
    jitter: createLfoPanel({ label: "Jitter" }),
  };

  grid.append(panels.value.element, panels.depth.element, panels.rate.element, panels.jitter.element);
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
  attachLfoPanelInteraction(panels.jitter, state, "jitter");

  updateLfoVisuals(state, state.value);
  queueSliderUpdate(state, state.value);
  startLfoAnimation(state);
  return wrapper;
}

function createLfoState(node, persisted, extraState) {
  return {
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
    jitter: persisted.jitter,
    phase: 0,
    noiseValue: 0,
    noiseTarget: 0,
    noiseCountdown: 0,
    animationFrame: null,
    lastFrameTime: null,
  };
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

function renderKeyboard(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "keyboard-control";
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--keyboard-accent", node.color || "#d26a2e");

  const chrome = document.createElement("div");
  chrome.className = "keyboard-chrome";

  const meta = document.createElement("div");
  meta.className = "keyboard-meta";
  meta.textContent = buildKeyboardMeta(node);

  const title = document.createElement("div");
  title.className = "keyboard-title";
  title.textContent = node.name;

  chrome.append(meta, title);

  const surface = document.createElement("div");
  surface.className = "keyboard-surface";

  const whiteLayer = document.createElement("div");
  whiteLayer.className = "keyboard-white-layer";

  const blackLayer = document.createElement("div");
  blackLayer.className = "keyboard-black-layer";

  const scaleMode = Boolean(node.scale && Number.isInteger(node.root));
  const notes = scaleMode
    ? buildScaleKeyboardNotes(node.start, node.size, node.root, node.scale)
    : buildKeyboardNotes(node.start, node.size);
  const activePointers = new Map();
  const activeNotes = new Map();

  const incrementNote = (note) => {
    activeNotes.set(note, (activeNotes.get(note) || 0) + 1);
  };

  const decrementNote = (note) => {
    const count = activeNotes.get(note) || 0;
    if (count <= 1) {
      activeNotes.delete(note);
      return;
    }
    activeNotes.set(note, count - 1);
  };

  const updateKeyVisual = (note, isActive) => {
    const key = surface.querySelector(`[data-note="${note}"]`);
    if (!key) {
      return;
    }
    key.classList.toggle("is-active", isActive);
  };

  const activatePointerNote = (pointerId, note) => {
    const existingNote = activePointers.get(pointerId);
    if (existingNote === note) {
      return;
    }
    if (existingNote !== undefined) {
      releasePointer(pointerId);
    }
    activePointers.set(pointerId, note);
    incrementNote(note);
    updateKeyVisual(note, true);
    sendKeyboardGate(node.channel, note, true);
  };

  const releasePointer = (pointerId) => {
    const note = activePointers.get(pointerId);
    if (note === undefined) {
      return;
    }
    activePointers.delete(pointerId);
    decrementNote(note);
    updateKeyVisual(note, activeNotes.has(note));
    sendKeyboardGate(node.channel, note, false);
  };

  if (scaleMode) {
    surface.classList.add("keyboard-surface--scale");
    whiteLayer.classList.add("keyboard-white-layer--scale");
    notes.forEach((item) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "keyboard-key keyboard-key--scale";
      if (item.isRoot) {
        key.classList.add("keyboard-key--root");
      }
      key.dataset.note = String(item.note);
      key.setAttribute("aria-label", `${formatMidiNote(item.note)} key`);
      key.textContent = formatMidiNote(item.note);
      whiteLayer.appendChild(key);
    });
    surface.append(whiteLayer);
  } else {
    notes
      .filter((item) => !item.isBlack)
      .forEach((item) => {
        const key = document.createElement("button");
        key.type = "button";
        key.className = "keyboard-key keyboard-key--white";
        key.dataset.note = String(item.note);
        key.dataset.black = "false";
        key.setAttribute("aria-label", `${formatMidiNote(item.note)} key`);
        whiteLayer.appendChild(key);
      });

    const whiteCount = Math.max(
      1,
      notes.reduce((count, item) => count + (item.isBlack ? 0 : 1), 0)
    );
    wrapper.style.setProperty("--white-key-count", String(whiteCount));

    notes
      .filter((item) => item.isBlack)
      .forEach((item) => {
        const key = document.createElement("button");
        key.type = "button";
        key.className = "keyboard-key keyboard-key--black";
        key.dataset.note = String(item.note);
        key.dataset.black = "true";
        key.setAttribute("aria-label", `${formatMidiNote(item.note)} key`);
        const leftPercent = ((item.whiteSlot + 1) / whiteCount) * 100;
        key.style.left = `${leftPercent}%`;
        key.style.width = `${(100 / whiteCount) * 0.64}%`;
        blackLayer.appendChild(key);
      });

    surface.append(whiteLayer, blackLayer);
  }
  wrapper.append(surface, chrome);

  const resolveNoteFromPointer = (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const key = target?.closest?.(".keyboard-key");
    if (!key || !surface.contains(key)) {
      return null;
    }
    return Number(key.dataset.note);
  };

  surface.addEventListener("pointerdown", (event) => {
    const note = resolveNoteFromPointer(event);
    if (note === null) {
      return;
    }
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    activatePointerNote(event.pointerId, note);
  });

  surface.addEventListener("pointermove", (event) => {
    if (!surface.hasPointerCapture(event.pointerId)) {
      return;
    }
    const note = resolveNoteFromPointer(event);
    if (note === null) {
      releasePointer(event.pointerId);
      return;
    }
    activatePointerNote(event.pointerId, note);
  });

  const endPointer = (event) => {
    releasePointer(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
  };

  surface.addEventListener("pointerup", endPointer);
  surface.addEventListener("pointercancel", endPointer);

  surface.addEventListener("lostpointercapture", (event) => {
    releasePointer(event.pointerId);
  });

  return wrapper;
}

function renderButton(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "button-control";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--button-accent", node.color || "#d26a2e");

  const meta = document.createElement("div");
  meta.className = "button-meta";
  meta.textContent = buildButtonMeta(node);

  const title = document.createElement("div");
  title.className = "button-title";
  title.textContent = node.name;

  wrapper.append(meta, title);

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

function renderTempo(node) {
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

function renderSequencer(node) {
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

  const surface = document.createElement("div");
  surface.className = "sequencer-surface";

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
    })),
    stepElements: [],
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

  wrapper.append(surface, chrome);
  state.steps.forEach((_step, index) => updateSequencerStepVisual(state, index));
  registerSequencerView(state);
  return wrapper;
}

function updateFromPointer(state, event, now) {
  const rect = state.element.getBoundingClientRect();
  const speed = state.speed || 1;
  const travel =
    state.orientation === "vertical"
      ? -((event.clientY - state.dragStartY) / (rect.height || 1))
      : (event.clientX - state.dragStartX) / (rect.width || 1);
  const rawValue = state.dragStartValue + travel * (state.max - state.min) * speed;
  const boundedValue = quantizeSliderValue(state, clamp(rawValue, state.min, state.max));
  if (boundedValue === state.value) {
    updateVelocity(state, event, now, rect);
    return;
  }

  updateSliderVisuals(state, boundedValue);
  queueSliderUpdate(state, boundedValue);
  updateVelocity(state, event, now, rect);
}

function updateSimpleLfoFromPointer(state, event) {
  const rect = state.element.getBoundingClientRect();
  const depthTravel = (state.dragStartY - event.clientY) / (rect.height || 1);
  const rateTravel = (event.clientX - state.dragStartX) / (rect.width || 1);
  state.depth = clamp(state.depthStart + depthTravel, 0, 1);
  state.rate = clamp(
    state.rateStart + rateTravel * getLfoRateMax(state),
    0,
    getLfoRateMax(state)
  );
  updateLfoVisuals(state, state.value);
}

function updateSliderVisuals(state, value) {
  state.value = value;
  const percentage = ((value - state.min) / (state.max - state.min || 1)) * 100;
  state.title.textContent = state.name;

  if (state.orientation === "vertical") {
    state.fill.style.height = `${percentage}%`;
    state.fill.style.width = "100%";
  } else {
    state.fill.style.width = `${percentage}%`;
    state.fill.style.height = "100%";
  }
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

function buildSliderMeta(node) {
  const parts = [`CH ${node.channel}  CC ${node.control}`];
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push(`OSC Range ${node.osc.min}..${node.osc.max}`);
  }
  return parts.join("\n");
}

function buildLfoMeta(node) {
  const parts = [
    `CH ${node.channel}  CC ${node.control}`,
    `DEPTH ${Math.round(node.depth * 100)}%`,
    `RATE ${node.rate.toFixed(2)} Hz`,
  ];
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
  }
  return parts.join("\n");
}

function updateComplexLfoVisuals(state) {
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
  updateLfoPanelFill(state.panels.jitter.fill, state.jitter);
}

function updateCenteredLfoFill(fill, normalizedPosition) {
  const fillSize = `${Math.abs(normalizedPosition) * 50}%`;
  fill.style.width = "100%";
  fill.style.transform = "";
  fill.style.height = fillSize;
  if (normalizedPosition >= 0) {
    fill.style.top = "auto";
    fill.style.bottom = "50%";
  } else {
    fill.style.top = "50%";
    fill.style.bottom = "auto";
  }
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

function computeLfoRelativeOffset(state) {
  const amplitude = ((state.max - state.min) / 2) * Math.max(state.depth, 0.0001);
  if (amplitude <= 0) {
    return 0;
  }
  return clamp((state.value - state.midpoint) / amplitude, -1, 1);
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
    state.rate = denormalizeLfoRate(clamp(startValue + travel, 0, 1), state);
    return;
  }
  state.jitter = clamp(startValue + travel, 0, 1);
}

function normalizeLfoRate(rate, state) {
  const maxRate = getLfoRateMax(state);
  if (maxRate <= 0) {
    return 0;
  }
  return clamp(rate, 0, maxRate) / maxRate;
}

function denormalizeLfoRate(value, state) {
  return clamp(value, 0, 1) * getLfoRateMax(state);
}

function getLfoRateMax(state) {
  return Math.max(0, Number(state.maxSpeed ?? LFO_RATE_MAX) || 0);
}

function queueSliderUpdate(state, value) {
  state.queuedValue = value;
  if (state.pendingRequest) {
    return;
  }
  void flushSliderUpdate(state);
}

function updateVelocity(state, event, now, rect) {
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

function maybeStartInertia(state) {
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

    const nextValue = quantizeSliderValue(
      state,
      clamp(state.value + (state.velocity * elapsed) / 1000, state.min, state.max)
    );

    if (nextValue !== state.value) {
      updateSliderVisuals(state, nextValue);
      queueSliderUpdate(state, nextValue);
    }

    state.velocity *= Math.pow(INERTIA_FRICTION_PER_FRAME, elapsed / 16.67);
    const hitBoundary = nextValue === state.min || nextValue === state.max;
    if (Math.abs(state.velocity) < INERTIA_MIN_VELOCITY || hitBoundary) {
      state.velocity = 0;
      state.inertiaFrame = null;
      return;
    }

    state.inertiaFrame = window.requestAnimationFrame(tick);
  };

  state.inertiaFrame = window.requestAnimationFrame(tick);
}

function stopInertia(state) {
  if (state.inertiaFrame !== null) {
    window.cancelAnimationFrame(state.inertiaFrame);
    state.inertiaFrame = null;
  }
  state.velocity = 0;
}

async function flushSliderUpdate(state) {
  if (state.queuedValue === null) {
    return;
  }

  state.pendingRequest = true;
  const value = state.queuedValue;
  state.queuedValue = null;

  try {
    await fetch("/api/slider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: state.key, value }),
    });
  } catch (_error) {
  } finally {
    state.pendingRequest = false;
    if (state.queuedValue !== null && state.queuedValue !== value) {
      void flushSliderUpdate(state);
    }
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
      state.phase = (state.phase + elapsedSeconds * state.rate * Math.PI * 2) % (Math.PI * 2);

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
    const lfoShape = Math.sin(state.phase);
    const compositeShape = ((1 - state.jitter) * lfoShape) + (state.jitter * state.noiseValue);
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
  try {
    const raw = window.localStorage.getItem(`${LFO_STORAGE_PREFIX}${node.key}`);
    if (!raw) {
      return { midpoint: node.value, depth: 0.35, rate: Math.min(1, getLfoRateMax(node)), jitter: 0 };
    }
    const parsed = JSON.parse(raw);
    const midpoint = Number(parsed.midpoint);
    const depth = Number(parsed.depth);
    const rate = Number(parsed.rate);
    const jitter = Number(parsed.jitter);
    return {
      midpoint: clamp(Number.isFinite(midpoint) ? midpoint : node.value, node.min, node.max),
      depth: clamp(Number.isFinite(depth) ? depth : 0.35, 0, 1),
      rate: clamp(
        Number.isFinite(rate) ? rate : Math.min(1, getLfoRateMax(node)),
        0,
        getLfoRateMax(node)
      ),
      jitter: clamp(Number.isFinite(jitter) ? jitter : 0, 0, 1),
    };
  } catch (_error) {
    return { midpoint: node.value, depth: 0.35, rate: Math.min(1, getLfoRateMax(node)), jitter: 0 };
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
        jitter: state.jitter,
      })
    );
  } catch (_error) {
  }
}

function sendKeyboardGate(channel, note, gate) {
  void queueGateRequest(`keyboard:${channel}:${note}`, "/api/keyboard", { channel, note, gate });
}

function sendButtonGate(key, gate) {
  void queueGateRequest(`button:${key}`, "/api/button", { key, gate });
}

function queueGateRequest(chainKey, url, payload) {
  const previous = gateRequestChains.get(chainKey) || Promise.resolve();
  const request = previous
    .catch(() => {})
    .then(() =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    )
    .catch(() => {})
    .finally(() => {
      if (gateRequestChains.get(chainKey) === request) {
        gateRequestChains.delete(chainKey);
      }
    });
  gateRequestChains.set(chainKey, request);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function quantizeSliderValue(state, value) {
  const bounded = clamp(value, state.min, state.max);
  if (!state.steps) {
    return bounded;
  }
  if (state.max === state.min) {
    return state.min;
  }

  const stepSize = (state.max - state.min) / (state.steps - 1);
  const stepIndex = Math.round((bounded - state.min) / stepSize);
  return clamp(state.min + stepIndex * stepSize, state.min, state.max);
}

function normalizeWheelDelta(event, axisDelta) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return axisDelta * 16;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return axisDelta * window.innerHeight;
  }
  return axisDelta;
}

function computeWheelValueDelta(state, normalizedDelta) {
  const directionMultiplier =
    normalizedDelta > 0
      ? state.orientation === "vertical"
        ? 1
        : -1
      : state.orientation === "vertical"
        ? -1
        : 1;

  if (state.steps) {
    state.wheelRemainder += Math.abs(normalizedDelta);
    const stepCount = Math.floor(state.wheelRemainder / WHEEL_DELTA_UNIT);
    if (stepCount === 0) {
      return 0;
    }
    state.wheelRemainder -= stepCount * WHEEL_DELTA_UNIT;
    const stepSize = (state.max - state.min) / (state.steps - 1);
    return stepSize * stepCount * directionMultiplier;
  }

  const speed = state.speed || 1;
  const baseStep = ((state.max - state.min) * WHEEL_STEP_SCALE * 0.01) * speed;
  const magnitude = Math.max(1, Math.abs(normalizedDelta) / WHEEL_DELTA_UNIT);
  return Math.max(1, Math.round(baseStep * magnitude)) * directionMultiplier;
}

function applyNodeSizing(element, node) {
  if (node.width) {
    element.dataset.width = node.width;
    element.style.setProperty("--node-width", node.width);
  }
  if (node.height) {
    element.dataset.height = node.height;
    element.style.setProperty("--node-height", node.height);
  }
}

function buildKeyboardNotes(start, size) {
  const notes = [];
  let whiteSlot = 0;

  for (let offset = 0; offset < size; offset += 1) {
    const note = start + offset;
    const isBlack = isBlackKey(note);
    if (isBlack) {
      notes.push({ note, isBlack: true, whiteSlot: Math.max(0, whiteSlot - 1) });
      continue;
    }
    notes.push({ note, isBlack: false, whiteSlot });
    whiteSlot += 1;
  }

  return notes;
}

function buildScaleKeyboardNotes(start, size, root, scaleName) {
  const allowed = new Set((SCALE_PATTERNS[scaleName] || []).map((interval) => (root + interval) % 12));
  const notes = [];
  for (let note = start; note <= 127 && notes.length < size; note += 1) {
    if (!allowed.has(note % 12)) {
      continue;
    }
    notes.push({ note, isRoot: note % 12 === root % 12 });
  }
  return notes;
}

function isBlackKey(note) {
  return [1, 3, 6, 8, 10].includes(note % 12);
}

function formatMidiNote(note) {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(note / 12) - 1;
  return `${noteNames[note % 12]}${octave}`;
}

function buildKeyboardMeta(node) {
  const end = node.start + node.size - 1;
  if (node.scale && Number.isInteger(node.root)) {
    return `CH ${node.channel}  ${formatPitchClass(node.root)} ${formatScaleName(node.scale)}  FROM ${formatMidiNote(node.start)}`;
  }
  return `CH ${node.channel}  NOTES ${formatMidiNote(node.start)}-${formatMidiNote(end)}`;
}

function buildButtonMeta(node) {
  const parts = [`CH ${node.channel}  CC ${node.control}`];
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push("OSC 0/1");
  }
  return parts.join("\n");
}

function updateTempoVisuals(state, value, playing) {
  state.value = quantizeTempoValue(value);
  state.playing = Boolean(playing);
  state.valueNode.textContent = state.value.toFixed(1);
  state.transportButton.setAttribute("aria-label", state.playing ? "Stop transport" : "Start transport");
  state.transportButton.classList.toggle("is-active", state.playing);
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
  state.steps[index] = {
    enabled: Boolean(nextStep.enabled),
    value: quantizeSequencerValue(state, nextStep.value),
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

function quantizeSequencerValue(state, value) {
  const bounded = Math.round(clamp(value, state.min, state.max));
  if (state.mode !== "notes" || !state.scale || !Number.isInteger(state.root)) {
    return bounded;
  }
  const allowed = new Set((SCALE_PATTERNS[state.scale] || []).map((interval) => (state.root + interval) % 12));
  let best = bounded;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let note = state.min; note <= state.max; note += 1) {
    if (!allowed.has(note % 12)) {
      continue;
    }
    const distance = Math.abs(note - bounded);
    if (distance < bestDistance || (distance === bestDistance && note < best)) {
      best = note;
      bestDistance = distance;
    }
  }
  return best;
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
    const response = await fetch("/api/sequencer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: state.key, steps }),
    });
    if (response.ok) {
      const payload = await response.json();
      state.steps = payload.steps.map((step) => ({
        enabled: Boolean(step.enabled),
        value: quantizeSequencerValue(state, Number(step.value)),
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

function syncTransportState(nextTransport, options = {}) {
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

function quantizeTempoValue(value) {
  return Math.round(value * 10) / 10;
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
    const response = await fetch("/api/tempo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (response.ok) {
      const payload = await response.json();
      updateTempoVisuals(state, payload.value, payload.playing);
      syncTransportState({ tempo: payload.value, playing: payload.playing });
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
    const response = await fetch("/api/transport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playing }),
    });
    if (response.ok) {
      const payload = await response.json();
      updateTempoVisuals(state, state.value, payload.playing);
      syncTransportState({ tempo: state.value, playing: payload.playing });
    }
  } catch (_error) {
  } finally {
    state.pendingTransportRequest = false;
  }
}

function formatScaleName(scaleName) {
  return scaleName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPitchClass(note) {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return noteNames[((note % 12) + 12) % 12];
}

function applyQrPanel(payload) {
  if (!payload.showQrPanel || shouldHideQrPanel()) {
    qrPanel.classList.add("qr-panel--hidden");
    return;
  }

  qrPanel.classList.remove("qr-panel--hidden");
  qrLink.href = payload.qr.url;
  qrLink.textContent = payload.qr.url;
  qrImage.src = payload.qr.image;
  qrImage.alt = `QR code for ${payload.qr.url}`;
}

async function loadApp() {
  const payload = await fetchConfig();
  currentVersion = payload.version;
  document.title = payload.title || "visual-midi";
  if (payload.title) {
    appHeader.hidden = false;
    titleNode.textContent = payload.title;
  } else {
    appHeader.hidden = true;
    titleNode.textContent = "";
  }
  sequencerViews.clear();
  layoutRoot.replaceChildren(renderLayoutWithConfig(payload.layout, payload));
  syncTransportState(payload.transport, { resetAnchors: true });
  applyQrPanel(payload);
  scheduleVersionPolling(payload.reloadPollMs);
}

function renderLayoutWithConfig(node, payload) {
  if (node.type === "slider") {
    return renderSlider({ ...node, inertia: payload.inertia });
  }
  if (node.type === "lfo") {
    return renderLfo(node);
  }
  if (node.type === "keyboard") {
    return renderKeyboard(node);
  }
  if (node.type === "button") {
    return renderButton(node);
  }
  if (node.type === "tempo") {
    return renderTempo(node);
  }
  if (node.type === "sequencer") {
    return renderSequencer(node);
  }
  if (node.type === "tabs") {
    return renderTabs(node, payload);
  }

  const group = document.createElement("section");
  group.className = `layout-group layout-group--${node.type}`;
  applyNodeSizing(group, node);
  for (const child of node.children) {
    group.appendChild(renderLayoutWithConfig(child, payload));
  }
  return group;
}

function renderTabs(node, payload) {
  const tabs = document.createElement("section");
  tabs.className = "layout-tabs";
  applyNodeSizing(tabs, node);

  const nav = document.createElement("div");
  nav.className = "layout-tabs-nav";
  nav.setAttribute("role", "tablist");

  const viewport = document.createElement("div");
  viewport.className = "layout-tabs-viewport";

  const track = document.createElement("div");
  track.className = "layout-tabs-track";
  const panelWidthPercent = 100 / node.tabs.length;
  track.style.width = `${node.tabs.length * 100}%`;
  viewport.appendChild(track);

  let activeIndex = 0;
  const buttons = [];

  const syncActiveTab = () => {
    track.style.transform = `translateX(-${activeIndex * panelWidthPercent}%)`;
    buttons.forEach((button, index) => {
      const isActive = index === activeIndex;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
      panels[index].setAttribute("aria-hidden", String(!isActive));
    });
  };

  const panels = [];
  node.tabs.forEach((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "layout-tab-button";
    button.textContent = tab.name;
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      activeIndex = index;
      syncActiveTab();
    });
    nav.appendChild(button);
    buttons.push(button);

    const panel = document.createElement("section");
    panel.className = "layout-tab-panel";
    panel.setAttribute("role", "tabpanel");
    panel.style.flexBasis = `${panelWidthPercent}%`;
    panel.appendChild(renderLayoutWithConfig(tab.content, payload));
    track.appendChild(panel);
    panels.push(panel);
  });

  tabs.append(nav, viewport);
  syncActiveTab();
  return tabs;
}

let pollTimer = null;

function scheduleVersionPolling(intervalMs) {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
  }

  pollTimer = window.setInterval(async () => {
    try {
      const payload = await fetchVersion();
      if (payload.version !== currentVersion) {
        await loadApp();
      }
    } catch (_error) {
    }
  }, intervalMs);
}

loadApp().catch((error) => {
  layoutRoot.innerHTML = `<p class="error-state">${error.message}</p>`;
});
