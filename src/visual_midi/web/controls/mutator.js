import { postMutatorAction } from "../api.js";
import { refreshFromPayload } from "../app.js";
import { applyNodeSizing } from "../utils/layout.js";
import { createButton } from "../ui/button.js";
import { createSlider } from "../ui/slider.js";

export function renderMutator(node) {
  const wrapper = document.createElement("article");
  wrapper.className = "mutator-control";
  wrapper.dataset.key = node.key;
  applyNodeSizing(wrapper, node);
  wrapper.style.setProperty("--mutator-accent", node.color || "#d26a2e");

  const state = {
    ...node,
    pending: false,
  };

  const degree = createSlider({
    className: "mutator-degree",
    fillClassName: "mutator-degree-fill",
    value: Number(node.value) || 0,
    min: 0,
    max: 1,
    steps: null,
    orientation: "horizontal",
    color: node.color || "#d26a2e",
    wheelAxis: "horizontal",
    ariaLabel: `${node.name} mutation amount`,
  });

  const actions = document.createElement("div");
  actions.className = "mutator-actions";

  const mutateButton = createButton({
    className: "mutator-button",
    text: "Mutate",
    color: node.color || "#d26a2e",
    onClick: () => {
      void applyMutatorAction(state, degree, "mutate", undoButton);
    },
  });

  const undoButton = createButton({
    className: "mutator-button",
    text: "Undo",
    color: node.color || "#d26a2e",
    disabled: !node.canUndo,
    onClick: () => {
      void applyMutatorAction(state, degree, "undo", undoButton);
    },
  });

  actions.append(mutateButton.element, undoButton.element);
  wrapper.append(degree.element, actions);
  return wrapper;
}

async function applyMutatorAction(state, degree, action, undoButton) {
  if (state.pending) {
    return;
  }
  state.pending = true;
  try {
    const value = degree.getValue();
    const response = await postMutatorAction(state.key, value, action);
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    refreshFromPayload(payload);
    undoButton.setDisabled(action === "undo");
  } catch (_error) {
  } finally {
    state.pending = false;
  }
}
