export function applyNodeSizing(element, node) {
  if (node.width) {
    element.dataset.width = node.width;
    element.style.setProperty("--node-width", node.width);
  }
  if (node.height) {
    element.dataset.height = node.height;
    element.style.setProperty("--node-height", node.height);
  }
}

export function applyGroupTracks(element, node) {
  if (!Array.isArray(node.children)) {
    return;
  }

  const tracks = node.children.map((child) => {
    if (node.type === "rows" && child.height) {
      return child.height;
    }
    if (node.type === "columns" && child.width) {
      return child.width;
    }
    return "minmax(0, 1fr)";
  });

  if (node.type === "rows") {
    element.style.gridTemplateRows = tracks.join(" ");
  }
  if (node.type === "columns") {
    element.style.gridTemplateColumns = tracks.join(" ");
  }
}
