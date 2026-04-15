export const INERTIA_VELOCITY_THRESHOLD = 80;
export const INERTIA_FRICTION_PER_FRAME = 0.9;
export const INERTIA_MIN_VELOCITY = 8;
export const WHEEL_STEP_SCALE = 0.72;
export const WHEEL_DELTA_UNIT = 12;

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function quantizeSliderValue(state, value) {
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

export function sliderValueToRatio(state, value) {
  if (state.max === state.min) {
    return 0;
  }
  const valueRatio = clamp((value - state.min) / (state.max - state.min), 0, 1);
  return invertCurveRatio(valueRatio, state.curve);
}

export function sliderRatioToValue(state, ratio) {
  const curvedRatio = applyCurveRatio(clamp(ratio, 0, 1), state.curve);
  return state.min + curvedRatio * (state.max - state.min);
}

export function applyCurveRatio(ratio, curve) {
  const boundedRatio = clamp(ratio, 0, 1);
  const exponent = sliderCurveExponent(curve);
  if (exponent === 1) {
    return boundedRatio;
  }
  if (Number(curve) > 0) {
    return Math.pow(boundedRatio, exponent);
  }
  return 1 - Math.pow(1 - boundedRatio, exponent);
}

export function invertCurveRatio(ratio, curve) {
  const boundedRatio = clamp(ratio, 0, 1);
  const exponent = sliderCurveExponent(curve);
  if (exponent === 1) {
    return boundedRatio;
  }
  if (Number(curve) > 0) {
    return Math.pow(boundedRatio, 1 / exponent);
  }
  return 1 - Math.pow(1 - boundedRatio, 1 / exponent);
}

function sliderCurveExponent(curve) {
  const value = Number(curve);
  if (!Number.isFinite(value) || value === 0) {
    return 1;
  }
  return Math.pow(2, Math.min(Math.abs(value), 12));
}

export function quantizeTempoValue(value) {
  return Math.round(value * 10) / 10;
}

export function normalizeWheelDelta(event, axisDelta) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return axisDelta * 16;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return axisDelta * window.innerHeight;
  }
  return axisDelta;
}

export function computeWheelValueDelta(state, normalizedDelta) {
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
