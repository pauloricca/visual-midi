import { postSliderValue } from "../api.js";
import { createSlider } from "../ui/slider.js";
import { applyNodeSizing } from "../utils/layout.js";

export function renderSlider(node) {
  const state = {
    ...node,
    pendingRequest: false,
    queuedValue: null,
    visualTransitionFrame: null,
    slider: null,
  };

  const initialValue = Number.isFinite(node.transitionFrom) ? node.transitionFrom : node.value;
  const slider = createSlider({
    tagName: "article",
    className: `control control--${node.orientation}`,
    fillClassName: "control-fill",
    value: initialValue,
    min: node.min,
    max: node.max,
    steps: node.steps,
    speed: node.speed,
    curve: node.curve,
    orientation: node.orientation,
    color: node.color || "#d26a2e",
    inertia: node.inertia ?? 0,
    wheelMode: "legacy",
    ariaLabel: node.name,
    onChange: (value) => {
      stopSliderVisualTransition(state);
      queueSliderUpdate(state, value);
    },
  });

  state.slider = slider;
  const wrapper = slider.element;
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);

  if (node.showLabel !== false) {
    const chrome = document.createElement("div");
    chrome.className = "control-chrome";

    const title = document.createElement("div");
    title.className = "control-title";
    title.textContent = node.name;

    const meta = document.createElement("div");
    meta.className = "control-meta";
    meta.textContent = buildSliderMeta(node);

    chrome.append(meta, title);
    wrapper.append(chrome);
  }

  maybeAnimateSliderVisualTransition(state, node.value);
  return wrapper;
}

export function queueSliderUpdate(state, value) {
  state.queuedValue = value;
  if (state.pendingRequest) {
    return;
  }
  void flushSliderUpdate(state);
}

function maybeAnimateSliderVisualTransition(state, targetValue) {
  const durationSeconds = Number(state.transitionDuration) || 0;
  if (durationSeconds <= 0) {
    return;
  }

  const startValue = state.slider.getValue();
  const endValue = targetValue;
  if (startValue === endValue) {
    return;
  }

  const durationMs = durationSeconds * 1000;
  const startedAt = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / Math.max(durationMs, 1));
    state.slider.setValue(startValue + ((endValue - startValue) * progress), {
      silent: true,
    });
    if (progress >= 1) {
      state.visualTransitionFrame = null;
      return;
    }
    state.visualTransitionFrame = window.requestAnimationFrame(tick);
  };

  state.visualTransitionFrame = window.requestAnimationFrame(tick);
}

function stopSliderVisualTransition(state) {
  if (state.visualTransitionFrame !== null) {
    window.cancelAnimationFrame(state.visualTransitionFrame);
    state.visualTransitionFrame = null;
  }
}

function buildSliderMeta(node) {
  const parts = [`CH ${node.channel}  CC ${node.control}`];
  if (node.osc) {
    parts.push(`OSC ${node.osc.path}`);
    parts.push(`OSC Range ${node.osc.min}..${node.osc.max}`);
  }
  return parts.join("\n");
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
