import {
  INERTIA_FRICTION_PER_FRAME,
  INERTIA_MIN_VELOCITY,
  INERTIA_VELOCITY_THRESHOLD,
  clamp,
  computeWheelValueDelta,
  normalizeWheelDelta,
  quantizeSliderValue,
  sliderRatioToValue,
  sliderValueToRatio,
} from "../utils/math.js";

const DEFAULT_WHEEL_PIXELS = 240;
const WHEEL_AXIS_DEADZONE = 1.2;
const KEYBOARD_RATIO_STEP = 0.01;

export function createSlider(options) {
  const elementClassName = withBaseClass(options.className, "ui-slider");
  const fillClassName = withBaseClass(options.fillClassName, "ui-slider-fill");
  const state = {
    tagName: options.tagName || "div",
    className: elementClassName,
    fillClassName,
    value: Number(options.value) || 0,
    min: Number(options.min ?? 0),
    max: Number(options.max ?? 1),
    steps: normalizeSteps(options.steps),
    speed: Number(options.speed ?? 1) || 1,
    curve: Number(options.curve ?? 0) || 0,
    orientation: options.orientation === "horizontal" ? "horizontal" : "vertical",
    color: options.color || null,
    wheelMode: options.wheelMode || "ratio",
    wheelAxis: options.wheelAxis || "orientation",
    wheelPixels: Number(options.wheelPixels ?? DEFAULT_WHEEL_PIXELS) || DEFAULT_WHEEL_PIXELS,
    inertia: Number(options.inertia ?? 0) || 0,
    ariaLabel: options.ariaLabel || "",
    fillMode: options.fillMode || "fill",
    onChange: typeof options.onChange === "function" ? options.onChange : null,
    onCommit: typeof options.onCommit === "function" ? options.onCommit : null,
    onTap: typeof options.onTap === "function" ? options.onTap : null,
    element: document.createElement(options.tagName || "div"),
    fill: document.createElement("div"),
    dragStartX: 0,
    dragStartY: 0,
    dragStartRatio: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerTime: 0,
    velocity: 0,
    inertiaFrame: null,
    pointerId: null,
    pointerMoved: false,
    wheelRemainder: 0,
  };

  state.element.className = state.className;
  if (state.element.tagName === "BUTTON") {
    state.element.type = "button";
  }
  state.fill.className = state.fillClassName;
  state.element.append(state.fill);
  state.element.tabIndex = options.tabIndex ?? 0;
  state.element.setAttribute("role", "slider");
  if (state.ariaLabel) {
    state.element.setAttribute("aria-label", state.ariaLabel);
  }
  if (state.color) {
    state.element.style.setProperty("--accent", state.color);
  }

  setValue(state, state.value, { silent: true });
  attachPointerHandlers(state);
  attachWheelHandler(state);
  attachKeyboardHandler(state);

  return {
    element: state.element,
    fill: state.fill,
    getValue: () => state.value,
    setValue: (value, updateOptions = {}) => setValue(state, value, updateOptions),
    setRatio: (ratio, updateOptions = {}) =>
      setValue(state, sliderRatioToValue(state, ratio), updateOptions),
    stopInertia: () => stopInertia(state),
  };
}

function attachPointerHandlers(state) {
  state.element.addEventListener("pointerdown", (event) => {
    if (!isPrimaryPointerButton(event)) {
      return;
    }
    event.preventDefault();
    stopInertia(state);
    state.pointerId = event.pointerId;
    state.pointerMoved = false;
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.dragStartRatio = sliderValueToRatio(state, state.value);
    state.lastPointerX = event.clientX;
    state.lastPointerY = event.clientY;
    state.lastPointerTime = performance.now();
    state.velocity = 0;
    state.element.setPointerCapture(event.pointerId);
  });

  state.element.addEventListener("pointermove", (event) => {
    if (state.pointerId !== event.pointerId || !state.element.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    const rect = state.element.getBoundingClientRect();
    const travel =
      state.orientation === "vertical"
        ? -((event.clientY - state.dragStartY) / (rect.height || 1))
        : (event.clientX - state.dragStartX) / (rect.width || 1);
    if (Math.abs(event.clientX - state.dragStartX) > 3 || Math.abs(event.clientY - state.dragStartY) > 3) {
      state.pointerMoved = true;
    }
    const now = performance.now();
    const previousValue = state.value;
    setRatio(state, state.dragStartRatio + travel * state.speed, { source: "pointer" });
    if (state.value !== previousValue) {
      state.pointerMoved = true;
    }
    updateVelocity(state, event, now, rect);
  });

  const finish = (event) => {
    if (state.pointerId !== event.pointerId) {
      return;
    }
    if (state.element.hasPointerCapture(event.pointerId)) {
      state.element.releasePointerCapture(event.pointerId);
    }
    const wasTap = !state.pointerMoved;
    state.pointerId = null;
    state.pointerMoved = false;
    if (wasTap && state.onTap) {
      state.onTap({ source: "tap", value: state.value, event });
    }
    commit(state, "pointer");
    maybeStartInertia(state);
  };

  state.element.addEventListener("pointerup", finish);
  state.element.addEventListener("pointercancel", (event) => {
    if (state.pointerId !== event.pointerId) {
      return;
    }
    if (state.element.hasPointerCapture(event.pointerId)) {
      state.element.releasePointerCapture(event.pointerId);
    }
    state.pointerId = null;
    state.pointerMoved = false;
  });
}

function attachWheelHandler(state) {
  state.element.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      stopInertia(state);
      if (state.wheelMode === "legacy") {
        applyLegacyWheel(state, event);
        return;
      }
      applyRatioWheel(state, event);
    },
    { passive: false }
  );
}

function updateVelocity(state, event, now, rect) {
  if (state.inertia <= 0) {
    return;
  }
  const pointerDelta =
    state.orientation === "vertical"
      ? -(event.clientY - state.lastPointerY) / (rect.height || 1)
      : (event.clientX - state.lastPointerX) / (rect.width || 1);
  const timeDelta = Math.max(now - state.lastPointerTime, 1);
  const instantVelocity = ((pointerDelta * (state.max - state.min) * state.speed) * 1000) / timeDelta;
  state.velocity = state.velocity * 0.35 + instantVelocity * 0.65;
  state.lastPointerX = event.clientX;
  state.lastPointerY = event.clientY;
  state.lastPointerTime = now;
}

function maybeStartInertia(state) {
  if (state.inertia <= 0) {
    state.velocity = 0;
    return;
  }
  const scaledVelocity = state.velocity * state.inertia;
  if (Math.abs(scaledVelocity) < INERTIA_VELOCITY_THRESHOLD) {
    state.velocity = 0;
    return;
  }
  state.velocity = scaledVelocity;

  let previousTime = performance.now();
  const tick = (now) => {
    const elapsed = Math.max(now - previousTime, 1);
    previousTime = now;
    const previousValue = state.value;
    setValue(state, state.value + (state.velocity * elapsed) / 1000, { source: "inertia" });
    state.velocity *= Math.pow(INERTIA_FRICTION_PER_FRAME, elapsed / 16.67);
    const hitBoundary = state.value === state.min || state.value === state.max;
    if (
      Math.abs(state.velocity) < INERTIA_MIN_VELOCITY ||
      hitBoundary ||
      state.value === previousValue
    ) {
      state.velocity = 0;
      state.inertiaFrame = null;
      commit(state, "inertia");
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

function attachKeyboardHandler(state) {
  state.element.addEventListener("keydown", (event) => {
    const ratio = sliderValueToRatio(state, state.value);
    let nextRatio = ratio;
    const step = state.steps ? 1 / Math.max(state.steps - 1, 1) : KEYBOARD_RATIO_STEP;

    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      nextRatio = ratio + step;
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      nextRatio = ratio - step;
    } else if (event.key === "Home") {
      nextRatio = 0;
    } else if (event.key === "End") {
      nextRatio = 1;
    } else {
      return;
    }

    event.preventDefault();
    setRatio(state, nextRatio, { source: "keyboard" });
    commit(state, "keyboard");
  });
}

function applyLegacyWheel(state, event) {
  const axisDelta = state.orientation === "vertical" ? event.deltaY : event.deltaX;
  if (axisDelta === 0) {
    return;
  }
  const normalizedDelta = normalizeWheelDelta(event, axisDelta);
  const valueDelta = computeWheelValueDelta(state, normalizedDelta);
  if (valueDelta === 0) {
    return;
  }
  const nextValue =
    state.steps || state.max === state.min
      ? state.value + valueDelta
      : sliderRatioToValue(
          state,
          sliderValueToRatio(state, state.value) + valueDelta / (state.max - state.min)
        );
  setValue(state, nextValue, { source: "wheel" });
  commit(state, "wheel");
}

function applyRatioWheel(state, event) {
  const axisDelta = wheelAxisDelta(state, event);
  if (axisDelta === 0) {
    return;
  }
  const normalizedDelta = normalizeWheelDelta(event, axisDelta);
  if (normalizedDelta === 0) {
    return;
  }
  const ratioDelta = wheelRatioDelta(state, normalizedDelta);
  if (ratioDelta === 0) {
    return;
  }
  setRatio(state, sliderValueToRatio(state, state.value) + ratioDelta, { source: "wheel" });
  commit(state, "wheel");
}

function wheelAxisDelta(state, event) {
  const x = Number(event.deltaX) || 0;
  const y = Number(event.deltaY) || 0;
  if (state.wheelAxis === "vertical") {
    return Math.abs(x) > Math.abs(y) * WHEEL_AXIS_DEADZONE ? 0 : y;
  }
  if (state.wheelAxis === "horizontal") {
    return Math.abs(y) > Math.abs(x) * WHEEL_AXIS_DEADZONE ? 0 : x;
  }
  if (state.orientation === "vertical") {
    return Math.abs(x) > Math.abs(y) * WHEEL_AXIS_DEADZONE ? 0 : y;
  }
  return Math.abs(x) >= Math.abs(y) ? x : -y;
}

function wheelRatioDelta(state, normalizedDelta) {
  const rawDelta =
    state.orientation === "vertical"
      ? normalizedDelta / state.wheelPixels
      : -normalizedDelta / state.wheelPixels;
  if (!state.steps) {
    state.wheelRemainder = 0;
    return rawDelta * state.speed;
  }

  if (state.wheelRemainder !== 0 && Math.sign(state.wheelRemainder) !== Math.sign(rawDelta)) {
    state.wheelRemainder = 0;
  }
  state.wheelRemainder += rawDelta;
  const stepRatio = 1 / Math.max(state.steps - 1, 1);
  const stepCount = Math.trunc(Math.abs(state.wheelRemainder) / stepRatio);
  if (stepCount === 0) {
    return 0;
  }
  const ratioDelta = Math.sign(state.wheelRemainder) * stepRatio * stepCount;
  state.wheelRemainder -= ratioDelta;
  return ratioDelta;
}

function setRatio(state, ratio, options = {}) {
  setValue(state, sliderRatioToValue(state, ratio), options);
}

function setValue(state, value, options = {}) {
  const nextValue = quantizeSliderValue(state, clamp(value, state.min, state.max));
  if (nextValue === state.value && !options.force) {
    updateVisuals(state);
    return;
  }
  state.value = nextValue;
  updateVisuals(state);
  if (!options.silent && state.onChange) {
    state.onChange(nextValue, { source: options.source || "program" });
  }
}

function updateVisuals(state) {
  const ratio = sliderValueToRatio(state, state.value);
  state.element.setAttribute("aria-valuemin", String(state.min));
  state.element.setAttribute("aria-valuemax", String(state.max));
  state.element.setAttribute("aria-valuenow", String(state.value));
  state.element.style.setProperty("--ui-slider-ratio", String(ratio));
  if (state.fillMode === "bar") {
    state.fill.style.width = state.orientation === "vertical" ? "100%" : `${ratio * 100}%`;
    state.fill.style.height = state.orientation === "vertical" ? `${ratio * 100}%` : "100%";
    return;
  }
  if (state.orientation === "vertical") {
    state.fill.style.width = "100%";
    state.fill.style.height = `${ratio * 100}%`;
  } else {
    state.fill.style.width = `${ratio * 100}%`;
    state.fill.style.height = "100%";
  }
}

function commit(state, source) {
  if (state.onCommit) {
    state.onCommit(state.value, { source });
  }
}

function isPrimaryPointerButton(event) {
  return event.pointerType === "touch" || event.button === 0;
}

function normalizeSteps(steps) {
  const numeric = Number(steps);
  if (!Number.isFinite(numeric) || numeric <= 1) {
    return null;
  }
  return Math.round(numeric);
}

function withBaseClass(className, baseClass) {
  const classes = String(className || baseClass)
    .split(/\s+/)
    .filter(Boolean);
  if (!classes.includes(baseClass)) {
    classes.unshift(baseClass);
  }
  return classes.join(" ");
}
