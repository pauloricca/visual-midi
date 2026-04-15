export function createButton(options = {}) {
  const element = document.createElement(options.tagName || "button");
  const state = {
    element,
    activePointers: new Set(),
    pressedByKeyboard: false,
    suppressNextClick: false,
    disabled: Boolean(options.disabled),
    activeClassName: options.activeClassName || "is-active",
    onPress: typeof options.onPress === "function" ? options.onPress : null,
    onRelease: typeof options.onRelease === "function" ? options.onRelease : null,
    onClick: typeof options.onClick === "function" ? options.onClick : null,
  };

  element.className = withBaseClass(options.className, "ui-button");
  if (element.tagName === "BUTTON") {
    element.type = options.type || "button";
  } else {
    element.tabIndex = options.tabIndex ?? 0;
    element.setAttribute("role", "button");
  }
  if (options.text) {
    element.textContent = options.text;
  }
  if (options.ariaLabel) {
    element.setAttribute("aria-label", options.ariaLabel);
  }
  if (options.color) {
    element.style.setProperty("--button-accent", options.color);
    element.style.setProperty("--mutator-accent", options.color);
  }

  setDisabled(state, state.disabled);
  setActive(state, false);
  attachPointerHandlers(state);
  attachKeyboardHandlers(state);
  attachClickHandler(state);

  return {
    element,
    setDisabled: (disabled) => setDisabled(state, disabled),
    setActive: (active) => setActive(state, active),
    isActive: () => element.classList.contains(state.activeClassName),
  };
}

function attachPointerHandlers(state) {
  state.element.addEventListener("pointerdown", (event) => {
    if (state.disabled || !isPrimaryPointerButton(event)) {
      return;
    }
    event.preventDefault();
    state.element.setPointerCapture(event.pointerId);
    pressPointer(state, event.pointerId);
  });

  state.element.addEventListener("pointerup", (event) => {
    const shouldClick = state.onClick && state.activePointers.has(event.pointerId);
    releasePointer(state, event.pointerId);
    releasePointerCapture(state.element, event.pointerId);
    if (shouldClick && !state.disabled) {
      state.onClick({ source: "pointer", event });
      suppressNextClick(state);
    }
  });

  state.element.addEventListener("pointercancel", (event) => {
    releasePointer(state, event.pointerId);
    releasePointerCapture(state.element, event.pointerId);
  });

  state.element.addEventListener("lostpointercapture", (event) => {
    releasePointer(state, event.pointerId);
  });

  state.element.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      return;
    }
    releasePointer(state, event.pointerId);
    releasePointerCapture(state.element, event.pointerId);
  });
}

function attachKeyboardHandlers(state) {
  state.element.addEventListener("keydown", (event) => {
    if (state.disabled || (event.key !== " " && event.key !== "Enter")) {
      return;
    }
    event.preventDefault();
    if (state.pressedByKeyboard) {
      return;
    }
    state.pressedByKeyboard = true;
    press(state, "keyboard", event);
  });

  state.element.addEventListener("keyup", (event) => {
    if (event.key !== " " && event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    if (!state.pressedByKeyboard) {
      return;
    }
    state.pressedByKeyboard = false;
    release(state, "keyboard", event);
    if (state.onClick) {
      state.onClick({ source: "keyboard", event });
      suppressNextClick(state);
    }
  });

  state.element.addEventListener("blur", (event) => {
    if (!state.pressedByKeyboard) {
      return;
    }
    state.pressedByKeyboard = false;
    release(state, "keyboard", event);
  });
}

function attachClickHandler(state) {
  state.element.addEventListener("click", (event) => {
    if (state.disabled) {
      event.preventDefault();
      return;
    }
    if (state.suppressNextClick) {
      state.suppressNextClick = false;
      return;
    }
    if (state.onClick) {
      state.onClick({ source: "click", event });
    }
  });
}

function pressPointer(state, pointerId) {
  if (state.activePointers.has(pointerId)) {
    return;
  }
  state.activePointers.add(pointerId);
  if (state.activePointers.size === 1) {
    press(state, "pointer", null);
  }
}

function releasePointer(state, pointerId) {
  if (!state.activePointers.has(pointerId)) {
    return;
  }
  state.activePointers.delete(pointerId);
  if (state.activePointers.size === 0) {
    release(state, "pointer", null);
  }
}

function press(state, source, event) {
  setActive(state, true);
  if (state.onPress) {
    state.onPress({ source, event });
  }
}

function release(state, source, event) {
  setActive(state, false);
  if (state.onRelease) {
    state.onRelease({ source, event });
  }
}

function setActive(state, active) {
  state.element.classList.toggle(state.activeClassName, active);
  state.element.classList.toggle("is-pressed", active);
  if (state.element.getAttribute("role") === "button") {
    state.element.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function setDisabled(state, disabled) {
  state.disabled = Boolean(disabled);
  state.element.toggleAttribute("disabled", state.disabled);
  state.element.setAttribute("aria-disabled", state.disabled ? "true" : "false");
  if (state.disabled) {
    state.activePointers.clear();
    state.pressedByKeyboard = false;
    setActive(state, false);
  }
}

function suppressNextClick(state) {
  state.suppressNextClick = true;
  window.setTimeout(() => {
    state.suppressNextClick = false;
  }, 0);
}

function releasePointerCapture(element, pointerId) {
  if (element.hasPointerCapture(pointerId)) {
    element.releasePointerCapture(pointerId);
  }
}

function isPrimaryPointerButton(event) {
  return event.pointerType === "touch" || event.button === 0;
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
