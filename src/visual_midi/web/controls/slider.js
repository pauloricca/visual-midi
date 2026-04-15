import { postSliderValue } from "../api.js";
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
import { applyNodeSizing } from "../utils/layout.js";

export function renderSlider(node) {
  const wrapper = document.createElement("article");
  wrapper.className = `control control--${node.orientation}`;
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--accent", node.color || "#d26a2e");
  const showLabel = node.showLabel !== false;

  const fill = document.createElement("div");
  fill.className = "control-fill";

  let title = null;
  if (showLabel) {
    const chrome = document.createElement("div");
    chrome.className = "control-chrome";

    title = document.createElement("div");
    title.className = "control-title";

    const meta = document.createElement("div");
    meta.className = "control-meta";
    meta.textContent = buildSliderMeta(node);

    chrome.append(meta, title);
    wrapper.append(fill, chrome);
  } else {
    wrapper.append(fill);
  }

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
    visualTransitionFrame: null,
    wheelRemainder: 0,
  };

  const initialValue = Number.isFinite(node.transitionFrom)
    ? node.transitionFrom
    : node.value;
  updateSliderVisuals(state, quantizeSliderValue(state, initialValue));
  maybeAnimateSliderVisualTransition(state, node.value);

  wrapper.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    stopInertia(state);
    stopVisualTransition(state);
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
      const nextValue = quantizeSliderValue(state, wheelDeltaToSliderValue(state, valueDelta));
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

export function queueSliderUpdate(state, value) {
  state.queuedValue = value;
  if (state.pendingRequest) {
    return;
  }
  void flushSliderUpdate(state);
}

export function updateSliderVisuals(state, value) {
  state.value = value;
  const percentage = sliderValueToRatio(state, value) * 100;
  if (state.title) {
    state.title.textContent = state.name;
  }

  if (state.orientation === "vertical") {
    state.fill.style.height = `${percentage}%`;
    state.fill.style.width = "100%";
  } else {
    state.fill.style.width = `${percentage}%`;
    state.fill.style.height = "100%";
  }
}

function maybeAnimateSliderVisualTransition(state, targetValue) {
  const durationSeconds = Number(state.transitionDuration) || 0;
  if (durationSeconds <= 0) {
    return;
  }

  const startValue = state.value;
  const endValue = quantizeSliderValue(state, targetValue);
  if (startValue === endValue) {
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
    updateSliderVisuals(state, nextValue);
    if (progress >= 1) {
      state.visualTransitionFrame = null;
      return;
    }
    state.visualTransitionFrame = window.requestAnimationFrame(tick);
  };

  state.visualTransitionFrame = window.requestAnimationFrame(tick);
}

function buildSliderMeta(node) {
  const parts = [`CH ${node.channel}  CC ${node.control}`];
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push(`OSC Range ${node.osc.min}..${node.osc.max}`);
  }
  return parts.join("\n");
}

function updateFromPointer(state, event, now) {
  const rect = state.element.getBoundingClientRect();
  const speed = state.speed || 1;
  const travel =
    state.orientation === "vertical"
      ? -((event.clientY - state.dragStartY) / (rect.height || 1))
      : (event.clientX - state.dragStartX) / (rect.width || 1);
  const rawRatio = sliderValueToRatio(state, state.dragStartValue) + travel * speed;
  const rawValue = sliderRatioToValue(state, rawRatio);
  const boundedValue = quantizeSliderValue(state, clamp(rawValue, state.min, state.max));
  if (boundedValue === state.value) {
    updateVelocity(state, event, now, rect);
    return;
  }

  updateSliderVisuals(state, boundedValue);
  queueSliderUpdate(state, boundedValue);
  updateVelocity(state, event, now, rect);
}

function wheelDeltaToSliderValue(state, valueDelta) {
  if (state.max === state.min) {
    return state.min;
  }
  if (state.steps) {
    return clamp(state.value + valueDelta, state.min, state.max);
  }
  const ratioDelta = valueDelta / (state.max - state.min);
  return sliderRatioToValue(state, sliderValueToRatio(state, state.value) + ratioDelta);
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

function stopVisualTransition(state) {
  if (state.visualTransitionFrame !== null) {
    window.cancelAnimationFrame(state.visualTransitionFrame);
    state.visualTransitionFrame = null;
  }
}

async function flushSliderUpdate(state) {
  if (state.queuedValue === null) {
    return;
  }

  state.pendingRequest = true;
  const value = state.queuedValue;
  state.queuedValue = null;

  try {
    await postSliderValue(state.key, value);
  } catch (_error) {
  } finally {
    state.pendingRequest = false;
    if (state.queuedValue !== null && state.queuedValue !== value) {
      void flushSliderUpdate(state);
    }
  }
}
