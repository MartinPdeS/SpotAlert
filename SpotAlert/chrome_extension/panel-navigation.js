/** Accessible tab selection and keyboard navigation; no application state writes. */
export function createNavigation($) {
  let visited = false;
  const workspaceTabs = ["searches", "monitoring", "personal", "clients", "settings"];
  function switchTab(name) {
    if (!workspaceTabs.includes(name)) throw new Error("Unknown workspace tab.");
    const changed = $(`#${name}-tab`).getAttribute("aria-selected") !== "true";
    visited = true;
    for (const tab of workspaceTabs) {
      const active = tab === name;
      $(`#${tab}-tab`).setAttribute("aria-selected", String(active));
      $(`#${tab}-tab`).tabIndex = active ? 0 : -1;
      $(`#${tab}-view`).hidden = !active;
    }
    if (changed) window.scrollTo({top: 0, behavior: "instant"});
  }
  for (const name of workspaceTabs) {
    $(`#${name}-tab`).addEventListener("click", () => switchTab(name));
    $(`#${name}-tab`).addEventListener("keydown", event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : workspaceTabs.length - 1;
        const adjacent = workspaceTabs[(workspaceTabs.indexOf(name) + direction) % workspaceTabs.length];
        const next = event.key === "Home" ? workspaceTabs[0]
          : event.key === "End" ? workspaceTabs.at(-1) : adjacent;
        switchTab(next);
        $(`#${next}-tab`).focus();
      }
    });
  }
  return {switchTab, hasVisited: () => visited};
}
