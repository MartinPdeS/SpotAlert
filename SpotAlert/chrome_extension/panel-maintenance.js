import {APPLICATION_BUILD} from "./application-diagnostics.js";

/** Settings UI; engine commands retain ownership of persisted diagnostics. */
export function createMaintenanceView({$, element, guard, request, loadState, toast, getState, isPersonalDirty, clock}) {
  $("#open-extension-settings").addEventListener("click", guard(() => chrome.tabs.create({url: "chrome://extensions"})));
  $("#reload-dashboard").addEventListener("click", () => location.reload());
  $('#reload-extension').addEventListener('click', guard(() => {
    if (isPersonalDirty()) {
      toast('Save your profile changes before reloading the extension.', true);
      return;
    }
    const button = $('#reload-extension');
    button.disabled = true;
    button.textContent = 'Reloading…';
    chrome.runtime.reload();
  }));
  async function checkExtensionVersion() {
    try {
      const info = await request({type: "engine-info"});
      $("#extension-version").textContent = `SpotAlert ${info.version} · Application build ${APPLICATION_BUILD}`;
      const source = await (await fetch(chrome.runtime.getURL('application-diagnostics.js'), {cache: 'no-store'})).text();
      const diskBuild = source.match(/APPLICATION_BUILD\s*=\s*['"]([^'"]+)/)?.[1];
      $("#extension-update").hidden = info.build === APPLICATION_BUILD && (!diskBuild || diskBuild === info.build);
    } catch {
      $("#extension-update").hidden = false;
    }
  }
  checkExtensionVersion();
  setInterval(checkExtensionVersion, 15000);

  function renderDebug() {
    const debug = getState().debug || {enabled: false, captures: []};
    const captures = debug.captures || [];
    $("#debug-mode").checked = Boolean(debug.enabled);
    $("#debug-count").textContent = captures.length;
    $("#debug-status").textContent = debug.enabled ? "On · watches direct links in your matching listings. Latest 20 captures are kept." : "Debug capture is off.";
    $("#export-debug").disabled = !captures.length;
    $("#clear-debug").disabled = !captures.length;
    const opened = new Set([...$("#debug-captures").querySelectorAll("details[open]")].map(node => node.dataset.captureId));
    $("#debug-captures").replaceChildren(...captures.slice(0, 5).map(capture => {
      const card = element("details", {class: "debug-capture", "data-capture-id": capture.id},
      element("summary", {}, capture.listingName, element("span", {class: "muted"}, ` · ${capture.status === "opening" ? "Opening…" : capture.status === "error" ? "Failed" : capture.snapshot?.pageKind || "Captured"}`)),
      element("p", {class: "helper"}, `${capture.site} · ${clock(capture.at)}`),
      capture.error && element("p", {class: "form-error"}, capture.error),
      capture.tabId && element("button", {class: "text-button", onclick: guard(() => request({type: "open-debug", captureId: capture.id}))}, "Open captured tab ↗"),
      capture.snapshot && element("pre", {class: "debug-output"}, JSON.stringify(capture.snapshot, null, 2)),
      );
      card.open = opened.has(capture.id);
      return card;
    }));
  }
  $("#debug-mode").addEventListener("change", guard(async () => {
    const button = $("#debug-mode");
    button.disabled = true;
    try {
      await request({type: "set-debug", enabled: button.checked});
      await loadState();
    } finally {
      button.disabled = false;
    }
  }));
  $("#clear-debug").addEventListener("click", guard(async () => {
    await request({type: "clear-debug"});
    await loadState();
  }));
  $("#export-debug").addEventListener("click", () => {
    const captures = (getState().debug?.captures || []).map(({tabId, ...capture}) => capture);
    const blob = new Blob([JSON.stringify({version: 1, captures}, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    element("a", {href: url, download: "spotalert-debug-captures.json"}).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return {renderDebug};
}
