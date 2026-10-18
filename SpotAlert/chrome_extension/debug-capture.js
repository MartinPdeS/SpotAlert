import {PROFILE_KEY} from "./profile.js";
import {SUPPORTED_SITES, listingKey, samePage} from "./core.js";
import {inspectApplicationPage} from "./debug.js";

/** Optional capture lifecycle; never changes confirmed availability on failure. */
export function createDebugCapture({api, now, state, mutate, find, patchRun, waitForPage, debugRuns}) {
  async function captureApplications(id, generation, signal) {
    // Claim before opening, so repeated five-second checks cannot reopen a link.
    const work = await mutate(value => {
      const monitor = find(value, id);
      const debug = value.debug;
      if (!debug?.enabled || monitor.generation !== generation || signal.aborted) return [];
      const links = monitor.samples.filter(sample => sample.matched && sample.applicationUrl && !samePage(sample.applicationUrl, monitor.url));
      const keys = new Set(links.map(sample => `${id}:${listingKey(sample)}:${sample.applicationUrl}`));
      for (const key of Object.keys(debug.seen)) if (key.startsWith(id + ":") && !keys.has(key)) delete debug.seen[key];
      const captures = [];
      for (const listing of links) {
        const key = `${id}:${listingKey(listing)}:${listing.applicationUrl}`;
        if (debug.seen[key] || captures.length >= 3) continue;
        debug.seen[key] = true;
        const capture = {id: crypto.randomUUID(), monitorId: id, site: monitor.name, listingName: listing.name || "Floor plan", at: now(), status: "opening"};
        debug.captures.unshift(capture);
        captures.push({captureId: capture.id, url: listing.applicationUrl});
      }
      debug.captures = debug.captures.slice(0, 20);
      return captures;
    });
    if (work.length) await patchRun(id, generation, monitor => { monitor.phase = "capturing"; });
    for (const item of work) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, {once: true});
      debugRuns.set(item.captureId, controller);
      let result;
      let tabId = null;
      try {
        if (signal.aborted || !(await state()).debug?.enabled) throw new Error("Debug capture cancelled.");
        const tab = await api.tabs.create({url: "about:blank", active: false});
        tabId = tab.id;
        await waitForPage(tab.id, controller.signal, false);
        if (controller.signal.aborted) throw new Error("Debug capture cancelled.");
        await api.tabs.update(tab.id, {url: item.url});
        await waitForPage(tab.id, controller.signal, false);
        if (controller.signal.aborted) throw new Error("Debug capture cancelled.");
        const loaded = await api.tabs.get(tab.id);
        if (!SUPPORTED_SITES.some(site => new URL(site.url).origin === new URL(loaded.url).origin)) throw new Error("The link redirected outside supported websites; open the captured tab to inspect it manually.");
        const profile = (await api.storage.local.get(PROFILE_KEY))[PROFILE_KEY] || {};
        const snapshots = await api.scripting.executeScript({target: {tabId: tab.id}, func: inspectApplicationPage, args: [Object.values(profile)]});
        if (controller.signal.aborted) throw new Error("Debug capture cancelled.");
        const snapshot = snapshots[0]?.result;
        if (!snapshot?.pageKind) throw new Error("The destination page could not be inspected.");
        result = {status: "captured", snapshot};
      } catch (error) {
        result = {status: "error", error: error.message.replace(/https?:\/\/[^\s]+/g, "[destination URL]").slice(0, 500)};
      } finally {
        signal.removeEventListener("abort", abort);
        debugRuns.delete(item.captureId);
      }
      await mutate(value => {
        const capture = value.debug?.captures.find(capture => capture.id === item.captureId);
        if (capture) Object.assign(capture, result, {tabId});
      });
    }
    if (work.length && !signal.aborted) await patchRun(id, generation, monitor => { monitor.phase = monitor.enabled ? "waiting" : "paused"; });
  }
  return {captureApplications};
}
