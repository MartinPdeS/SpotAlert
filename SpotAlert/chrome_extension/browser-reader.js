import { samePage, sitePattern } from "./core.js";
import { readerForRule } from "./sites/index.js";
import { readPage, inspectReadState } from "./page.js";

/** Browser tab lifecycle and listing reads; persisted state stays in the engine. */
export function createBrowserReader(api) {
  async function tabFor(monitor, signal) {
    if (signal.aborted) throw new Error("Check cancelled.");
    if (monitor.tabId !== null) {
      try {
        const tab = await api.tabs.get(monitor.tabId);
        if (samePage(tab.url, monitor.url)) return tab;
      } catch {
        /* A closed tab is recreated at its next check. */
      }
    }
    const tabs = await api.tabs.query({ url: sitePattern(monitor.url) });
    const existing = tabs.find((tab) => samePage(tab.url, monitor.url));
    if (existing) return existing;
    if (signal.aborted) throw new Error("Check cancelled.");
    return api.tabs.create({ url: monitor.url, active: false });
  }
  function waitForPage(tabId, signal, refresh) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(updated);
        api.tabs.onRemoved.removeListener(removed);
        signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const updated = (id, change) => {
        if (id === tabId && change.status === "complete") finish();
      };
      const removed = (id) => {
        if (id === tabId) finish(new Error("The monitored tab was closed."));
      };
      const aborted = () => finish(new Error("Check cancelled."));
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Page load timed out. Check the tab for login or verification prompts.",
            ),
          ),
        20000,
      );
      api.tabs.onUpdated.addListener(updated);
      api.tabs.onRemoved.addListener(removed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) return aborted();
      if (refresh) api.tabs.reload(tabId, { bypassCache: true }).catch(finish);
      else
        api.tabs
          .get(tabId)
          .then((tab) => {
            if (tab.status === "complete") finish();
          })
          .catch(finish);
    });
  }
  function waitForRead(signal) {
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, 250);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new Error("Check cancelled."));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function executeRead(
    tabId,
    rule,
    waitMs = 12000,
    signal = new AbortController().signal,
  ) {
    const deadline = Date.now() + waitMs;
    let emptyAttempts = 0;
    while (true) {
      if (signal.aborted) throw new Error("Check cancelled.");
      let results;
      try {
        // Keep injected work synchronous. The worker waits for late listings,
        // rather than leaving a Promise tied to a document being refreshed.
        results = await api.scripting.executeScript({
          target: { tabId },
          func: readPage,
          args: [rule, 0, readerForRule(rule)],
        });
      } catch (error) {
        if (
          /cannot access|missing host permission|manifest must request permission|extensions gallery cannot be scripted/i.test(
            error.message,
          )
        ) {
          throw Object.assign(
            new Error(
              "Chrome blocked access to this website. Open Chrome → Extensions → SpotAlert → Site access and allow the affected housing website, then reload its tab.",
            ),
            { kind: "permission" },
          );
        }
        if (!/frame|context|document|navigation|removed/i.test(error.message))
          throw error;
      }
      if (signal.aborted) throw new Error("Check cancelled.");
      const frame = results?.find((item) => item.frameId === 0) || results?.[0];
      const result = frame?.result;
      if (result) {
        emptyAttempts = 0;
        if (result.pending && Date.now() < deadline) {
          await waitForRead(signal);
          continue;
        }
        if (result.error)
          throw Object.assign(new Error(result.error), {
            kind: result.errorKind,
          });
        return result;
      }
      const inspection = (
        await api.scripting
          .executeScript({ target: { tabId }, func: inspectReadState })
          .catch(() => [])
      )?.[0]?.result;
      if (signal.aborted) throw new Error("Check cancelled.");
      if (inspection?.verification)
        throw Object.assign(
          new Error(
            "The website is showing a verification prompt. Open the affected tab and complete it, then check again.",
          ),
          { kind: "verification" },
        );
      if (inspection?.login)
        throw Object.assign(
          new Error(
            "The website requires a login. Open the affected tab and sign in, then check again.",
          ),
          { kind: "login" },
        );
      if (++emptyAttempts >= 2)
        throw Object.assign(
          new Error(
            "Chrome returned no page data after retrying. Open the affected tab and press Check now again once its listings are loaded.",
          ),
          { kind: "loading" },
        );
      await waitForPage(tabId, signal, false);
      await waitForRead(signal);
    }
  }
  return { tabFor, waitForPage, executeRead };
}
