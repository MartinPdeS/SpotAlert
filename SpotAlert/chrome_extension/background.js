import {ALARM_PREFIX} from "./core.js";
import {createEngine} from "./engine.js";

const engine = createEngine(chrome);
const ready = engine.initialize();
ready.catch(console.error);
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(console.error);
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({url: chrome.runtime.getURL("panel.html"), active: true}).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || ["audio", "listing-parser"].includes(message?.target)) return false;
  // Monitor commands come from the extension workspace.
  if (!sender.url?.startsWith(chrome.runtime.getURL("")) || sender.tab?.url?.startsWith("http")) return false;
  ready.then(() => engine.dispatch(message))
    .then((result) => respond({ok: true, result}))
    .catch((error) => respond({ok: false, error: error.message, details: {tabId: error.tabId}}));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  ready.then(async () => {
    const id = alarm.name.slice(ALARM_PREFIX.length);
    const monitor = (await engine.state()).monitors.find((item) => item.id === id);
    if (monitor?.enabled) await engine.check(id, true);
  }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => ready.catch(console.error));
