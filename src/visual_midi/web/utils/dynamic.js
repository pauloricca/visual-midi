const controlValues = new Map();

export function resetDynamicControlValues() {
  controlValues.clear();
}

export function seedDynamicControlValuesFromLayout(node) {
  walkLayout(node, (control) => {
    const value = Number(control.value);
    if (Number.isFinite(value)) {
      setDynamicControlValue(control, value);
    }
  });
}

export function setDynamicControlValue(control, value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return;
  }
  if (control?.name) {
    controlValues.set(control.name, numericValue);
  }
  if (control?.key) {
    controlValues.set(control.key, numericValue);
  }
}

export function resolveDynamicNumber(source, fallback, options = {}) {
  let value = source;
  if (typeof value === "string") {
    const reference = value.trim();
    value = controlValues.has(reference) ? controlValues.get(reference) : Number(reference);
  }

  let numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    numericValue = Number(fallback);
  }
  if (!Number.isFinite(numericValue)) {
    numericValue = 0;
  }

  if (Number.isFinite(options.min)) {
    numericValue = Math.max(options.min, numericValue);
  }
  if (Number.isFinite(options.max)) {
    numericValue = Math.min(options.max, numericValue);
  }
  if (options.integer) {
    numericValue = Math.round(numericValue);
  }
  return numericValue;
}

export function installDynamicNumberAccessors(target, specs) {
  for (const [property, spec] of Object.entries(specs)) {
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: true,
      get() {
        return resolveDynamicNumber(spec.source, spec.fallback, spec);
      },
    });
  }
}

function walkLayout(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.name || node.key) {
    visit(node);
  }
  if (node.type === "tabs") {
    node.tabs.forEach((tab) => walkLayout(tab.content, visit));
    return;
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => walkLayout(child, visit));
  }
}
