import {ALARM_PREFIX, STORAGE_KEY, defaultMonitor, evaluateRule, sitePattern, siteError, errorKind, newListings, listingKey, safeListingUrl, samePage, inMonitoringHours, nextMonitoringTime, retrySeconds, SUPPORTED_SITES, validateSupportedMonitor, validateMonitor} from "./core.js";
import {PROFILE_KEY, validateProfile, fillApplicationForm} from "./profile.js";
import {inspectApplicationPage} from "./debug.js";
import {playAlertSound} from "./alerts.js";
import {openApplication, readPage} from "./page.js";

/** Persisted scheduling and page checks. No native process or timer loop. */
export function createEngine(api, now = () => Date.now(), timers = globalThis) {
  let writes = Promise.resolve();
  let checks = Promise.resolve();
  const running = new Map();
  const fastTimers = new Map();
  const debugRuns = new Map();
  function clearFastTimer(id) {
    if (fastTimers.has(id)) timers.clearTimeout(fastTimers.get(id));
    fastTimers.delete(id);
  }
  async function arm(monitor, when) {
    clearFastTimer(monitor.id);
    if (monitor.intervalSeconds < 30 && when - now() < 30000) {
      const timer = timers.setTimeout(() => {
        fastTimers.delete(monitor.id);
        return state().then((value) => {
          const current = value.monitors.find((item) => item.id === monitor.id);
          if (current?.enabled && current.intervalSeconds < 30 && current.nextCheckAt === when) return check(current.id, true);
        }).catch(console.error);
      }, Math.max(0, when - now()));
      timer?.unref?.();
      fastTimers.set(monitor.id, timer);
    }
    // Alarms survive worker suspension, but Chrome enforces a 30-second minimum.
    await api.alarms.create(alarmName(monitor.id), {when: Math.max(now() + 30000, when)});
  }
  const cancel = (id) => { running.get(id)?.abort(); running.delete(id); };

  async function state() {
    await writes;
    return (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {version: 2, monitors: []};
  }
  function mutate(update) {
    const operation = writes.then(async () => {
      const value = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {version: 2, monitors: []};
      const result = await update(value);
      await api.storage.local.set({[STORAGE_KEY]: value});
      const active = value.monitors.filter((monitor) => monitor.enabled).length;
      const available = value.monitors.filter((monitor) => monitor.available === true).length;
      await api.action.setBadgeBackgroundColor({color: available ? "#72deb6" : "#49685c"});
      await api.action.setBadgeText({text: available ? String(available) : active ? String(active) : ""});
      await api.action.setTitle({title: `SpotAlert · ${active} watching · ${available} available`});
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  const find = (value, id) => {
    const monitor = value.monitors.find((item) => item.id === id);
    if (!monitor) throw new Error("This monitor no longer exists.");
    return monitor;
  };
  const alarmName = (id) => ALARM_PREFIX + id;
  function history(monitor, event) {
    monitor.history.unshift({id: crypto.randomUUID(), at: now(), ...event});
    monitor.history = monitor.history.slice(0, 80);
  }
  async function initialize() {
    await mutate((value) => {
      value.debug ||= {enabled: false, captures: [], seen: {}};
      for (const capture of value.debug.captures || []) if (capture.status === "opening") { capture.status = "error"; capture.error = "Chrome restarted before capture completed."; }
      const previous = value.monitors || [];
      value.monitors = SUPPORTED_SITES.map((site) => {
        const existing = previous.find((monitor) => monitor.id === site.id && monitor.url === site.url)
          || previous.find((monitor) => monitor.url === site.url);
        const monitor = existing ? {...defaultMonitor(site.id), ...existing, ...validateMonitor(existing), id: site.id, name: site.name} : defaultMonitor(site.id);
        // Correct the originally shipped South East rule without replacing custom rules.
        if (existing && site.id === "ourdomain-amsterdam-south-east"
            && existing.rule.type === "css" && existing.rule.selector === 'td[data-selenium-id^="Availability_"]'
            && existing.rule.mode === "not_equals" && existing.rule.expected === "Get Notified") {
          monitor.rule = {...site.rule};
          monitor.available = null;
          monitor.samples = [];
          monitor.error = null;
          monitor.lastCheckedAt = null;
          monitor.lastDurationMs = null;
          history(monitor, {kind: "updated", message: "South East rule corrected to read application buttons."});
        }
        return monitor;
      });
      const retained = new Set(value.monitors.map((monitor) => monitor.id));
      const archived = previous.filter((monitor) => !retained.has(monitor.id) || !SUPPORTED_SITES.some((site) => site.url === monitor.url));
      value.archivedMonitors = [...(value.archivedMonitors || []), ...archived.map((monitor) => ({...monitor, enabled: false, phase: "paused", nextCheckAt: null}))];
      value.initialized = true;
      for (const monitor of value.monitors) {
        if (["queued", "refreshing", "reading", "capturing"].includes(monitor.phase)) {
          monitor.phase = monitor.enabled ? "waiting" : "paused";
          history(monitor, {kind: "interrupted", message: "Chrome restarted the worker; the interrupted check will retry."});
        }
      }
    });
    const value = await state();
    const alarms = await api.alarms.getAll();
    for (const alarm of alarms.filter((item) => item.name.startsWith(ALARM_PREFIX))) {
      if (!value.monitors.some((monitor) => monitor.enabled && alarmName(monitor.id) === alarm.name)) {
        await api.alarms.clear(alarm.name);
      }
    }
    for (const monitor of value.monitors.filter((item) => item.enabled)) {
      if (monitor.intervalSeconds < 30 || !alarms.some((alarm) => alarm.name === alarmName(monitor.id))) {
        await schedule(monitor.id, Math.max(now() + Math.min(30, monitor.intervalSeconds) * 1000, monitor.nextCheckAt || 0));
      }
    }
  }
  async function schedule(id, when) {
    await mutate((value) => {
      const monitor = value.monitors.find((item) => item.id === id);
      if (monitor?.enabled) {
        const next = nextMonitoringTime(when, monitor.hours);
        monitor.nextCheckAt = next;
        if (!monitor.error && !inMonitoringHours(now(), monitor.hours)) monitor.phase = "waiting-hours";
        return arm(monitor, next);
      }
    });
  }
  async function save(input) {
    const config = validateSupportedMonitor(input);
    if (!(await api.permissions.contains({origins: [sitePattern(config.url)]}))) {
      throw new Error("Allow access to this website before saving the monitor.");
    }
    const site = SUPPORTED_SITES.find((site) => site.url === config.url);
    if (input.id && input.id !== site.id) throw new Error("Choose a supported website from the list.");
    clearFastTimer(site.id); cancel(site.id); await api.alarms.clear(alarmName(site.id));
    return mutate((value) => {
      const existing = find(value, site.id);
      const monitor = {
        ...existing, ...config,
        enabled: false, phase: "paused", available: null, samples: [], error: null, errorKind: null, consecutiveErrors: 0,
        pendingArrivals: [], alert: null,
        nextCheckAt: null, tabId: existing?.url === config.url ? existing.tabId : null,
        lastCheckedAt: null, lastDurationMs: null,
        generation: crypto.randomUUID(),
      };
      value.monitors[value.monitors.indexOf(existing)] = monitor;
      history(monitor, {kind: "saved", message: "Rule saved. Preview it or start watching."});
      return monitor.id;
    });
  }
  async function setEnabled(id, enabled) {
    if (!enabled) { clearFastTimer(id); cancel(id); await api.alarms.clear(alarmName(id)); }
    await mutate((value) => {
      const monitor = find(value, id);
      monitor.enabled = Boolean(enabled);
      monitor.phase = enabled ? "waiting" : "paused";
      monitor.nextCheckAt = null;
      monitor.generation = crypto.randomUUID();
      history(monitor, {kind: enabled ? "started" : "paused", message: enabled ? "Monitoring started." : "Monitoring paused. The browser tab stays open."});
    });
    if (enabled) return check(id, true);
  }
  async function stopAll() {
    await mutate(async (value) => {
      for (const monitor of value.monitors) {
        clearFastTimer(monitor.id);
        cancel(monitor.id);
        if (monitor.enabled || ["queued", "refreshing", "reading", "capturing"].includes(monitor.phase)) {
          history(monitor, {kind: "paused", message: "All monitoring stopped. The browser tab stays open."});
        }
        monitor.enabled = false;
        monitor.phase = "paused";
        monitor.nextCheckAt = null;
        monitor.generation = crypto.randomUUID();
      }
      await Promise.all(value.monitors.map(monitor => api.alarms.clear(alarmName(monitor.id))));
    });
    return state();
  }
  async function setIntervalSeconds(id, seconds) {
    await mutate((value) => {
      const monitor = find(value, id);
      const config = validateMonitor({...monitor, intervalSeconds: seconds});
      monitor.intervalSeconds = config.intervalSeconds;
      history(monitor, {kind: "interval", message: `Refresh interval set to ${config.intervalSeconds} seconds.`});
      if (monitor.enabled && !running.has(id)) {
        monitor.nextCheckAt = nextMonitoringTime(now() + retrySeconds(monitor) * 1000, monitor.hours);
        return arm(monitor, monitor.nextCheckAt);
      }
    });
    return state();
  }
  async function patchRun(id, generation, update) {
    return mutate((value) => {
      const monitor = value.monitors.find((item) => item.id === id);
      if (!monitor || monitor.generation !== generation) return false;
      update(monitor);
      return true;
    });
  }
  async function tabFor(monitor, signal) {
    if (signal.aborted) throw new Error("Check cancelled.");
    if (monitor.tabId !== null) {
      try {
        const tab = await api.tabs.get(monitor.tabId);
        if (samePage(tab.url, monitor.url)) return tab;
      } catch { /* A closed tab is recreated at its next check. */ }
    }
    const tabs = await api.tabs.query({url: sitePattern(monitor.url)});
    const existing = tabs.find((tab) => samePage(tab.url, monitor.url));
    if (existing) return existing;
    if (signal.aborted) throw new Error("Check cancelled.");
    return api.tabs.create({url: monitor.url, active: false});
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
      const updated = (id, change) => { if (id === tabId && change.status === "complete") finish(); };
      const removed = (id) => { if (id === tabId) finish(new Error("The monitored tab was closed.")); };
      const aborted = () => finish(new Error("Check cancelled."));
      const timer = setTimeout(() => finish(new Error("Page load timed out. Check the tab for login or verification prompts.")), 20000);
      api.tabs.onUpdated.addListener(updated);
      api.tabs.onRemoved.addListener(removed);
      signal.addEventListener("abort", aborted, {once: true});
      if (signal.aborted) return aborted();
      if (refresh) api.tabs.reload(tabId, {bypassCache: true}).catch(finish);
      else api.tabs.get(tabId).then((tab) => { if (tab.status === "complete") finish(); }).catch(finish);
    });
  }
  async function executeRead(tabId, rule, waitMs = 12000) {
    const results = await api.scripting.executeScript({target: {tabId}, func: readPage, args: [rule, waitMs]});
    const result = results[0]?.result;
    if (!result) throw new Error("Chrome could not read the page. Check site access permissions.");
    if (result.error) throw Object.assign(new Error(result.error), {kind: result.errorKind});
    return result;
  }
  async function run(id, controller, scheduled) {
    const startedAt = now();
    let monitor;
    let generation;
    try {
      monitor = (await state()).monitors.find((item) => item.id === id);
      if (!monitor || controller.signal.aborted) return;
      if (scheduled && !inMonitoringHours(now(), monitor.hours)) {
        await mutate((value) => { const current = find(value, id); current.phase = "waiting-hours"; });
        await schedule(id, now());
        return;
      }
      generation = monitor.generation || crypto.randomUUID();
      const begun = await mutate((value) => {
        const current = find(value, id);
        if (controller.signal.aborted || current.generation !== monitor.generation) return false;
        current.generation = generation;
        current.phase = "refreshing";
        current.error = null;
        current.nextCheckAt = null;
        return true;
      });
      if (!begun || controller.signal.aborted) return;
      if (!(await api.permissions.contains({origins: [sitePattern(monitor.url)]}))) {
        throw new Error("Website access is missing. Edit this monitor and save it to grant access again.");
      }
      const tab = await tabFor(monitor, controller.signal);
      if (controller.signal.aborted) return;
      await patchRun(id, generation, (current) => { current.tabId = tab.id; });
      // A newly created tab is still loading; an existing complete tab is refreshed.
      await waitForPage(tab.id, controller.signal, tab.status === "complete");
      if (controller.signal.aborted) return;
      await patchRun(id, generation, (current) => { current.phase = "reading"; });
      const result = await executeRead(tab.id, monitor.rule);
      if (!samePage(result.url, monitor.url)) throw new Error("The tab navigated away from the saved URL. Check login or update the monitor URL.");
      const evaluated = evaluateRule(result.samples, monitor.rule, monitor.filters);
      let alert = null;
      if (controller.signal.aborted) return;
      const accepted = await patchRun(id, generation, (current) => {
        const previousTexts = current.samples.map((sample) => sample.text);
        const nextSamples = evaluated.matches.map((sample) => ({...sample, text: sample.text.slice(0, 2000), applicationUrl: safeListingUrl(sample.applicationUrl, current.url), pageUrl: safeListingUrl(sample.pageUrl, current.url) || current.url}));
        const changed = JSON.stringify(previousTexts) !== JSON.stringify(nextSamples.map((sample) => sample.text));
        const arrivals = newListings(current.samples, nextSamples);
        const eligible = new Map(nextSamples.filter((sample) => sample.matched).map((sample) => [listingKey(sample), sample]));
        const pendingMap = new Map((current.pendingArrivals || []).map((sample) => [listingKey(sample), sample]));
        for (const sample of arrivals) if (!pendingMap.has(listingKey(sample))) pendingMap.set(listingKey(sample), sample);
        const pending = [...pendingMap].filter(([key, sample]) => {
          const latest = eligible.get(key);
          return latest && !(Number.isFinite(sample.arrivalBaselineCount) && Number.isFinite(latest.availableCount) && latest.availableCount <= sample.arrivalBaselineCount);
        }).map(([key, sample]) => ({...eligible.get(key), arrivalBaselineCount: sample.arrivalBaselineCount ?? null}));
        current.pendingArrivals = current.notify ? pending : [];
        if (current.notify && pending.length && !(current.snoozedUntil > now())) {
          alert = {id: crypto.randomUUID(), at: now(), listings: pending, test: false};
          current.alert = alert;
          current.pendingArrivals = [];
          history(current, {kind: "arrival", message: `${pending.length} newly available ${pending.length === 1 ? "floor plan" : "floor plans"}`, listings: pending});
        }
        current.available = evaluated.available;
        current.samples = nextSamples;
        current.knownFloorplans = nextSamples.map(({id, name, index, rent, beds, baths}) => ({id, name, index, rent, beds, baths}));
        current.checks += 1;
        current.lastCheckedAt = now();
        current.lastDurationMs = now() - startedAt;
        current.error = null;
        current.errorKind = null;
        current.consecutiveErrors = 0;
        current.phase = current.enabled ? "waiting" : "paused";
        history(current, {
          kind: "check", available: evaluated.available, changed,
          message: evaluated.available ? "Availability detected" : "No availability detected",
          matchedCount: evaluated.matches.filter((sample) => sample.matched).length,
          totalCount: evaluated.matches.length,
          preview: nextSamples.filter((sample) => sample.matched).slice(0, 3).map((sample) => sample.text.slice(0, 120)),
        });
      });
      if (accepted && alert && !controller.signal.aborted) await deliverAlert(id, alert);
      if (accepted && !controller.signal.aborted) await captureApplications(id, generation, controller.signal);

    } catch (error) {
      if (generation && !controller.signal.aborted) {
        await patchRun(id, generation, (current) => {
          current.phase = "error";
          current.error = siteError(current, error);
          current.errorKind = errorKind(error);
          current.consecutiveErrors = (current.consecutiveErrors || 0) + 1;
          history(current, {kind: "error", message: current.error});
        });
      }
    } finally {
      if (generation && !controller.signal.aborted) {
        const current = (await state()).monitors.find((item) => item.id === id);
        if (current?.enabled && current.generation === generation) {
          await schedule(id, now() + retrySeconds(current) * 1000);
        }
      }
    }
  }
  function check(id, scheduled = false) {
    if (running.has(id)) return running.get(id).promise;
    clearFastTimer(id);
    const controller = new AbortController();
    running.set(id, controller);
    const queued = mutate((value) => {
      const monitor = value.monitors.find((item) => item.id === id);
      if (monitor && !controller.signal.aborted) monitor.phase = "queued";
    });
    const operation = Promise.all([checks, queued]).then(async () => {
      if (controller.signal.aborted) return;
      await run(id, controller, scheduled);
    });
    checks = operation.catch(() => {});
    controller.promise = operation.finally(() => {
      if (running.get(id) === controller) running.delete(id);
    });
    return controller.promise;
  }
  async function preview(input) {
    const config = validateSupportedMonitor(input);
    try {
      if (!(await api.permissions.contains({origins: [sitePattern(config.url)]}))) throw new Error("Allow access to preview this website.");
      const tab = await tabFor({...config, tabId: input.tabId ?? null}, new AbortController().signal);
      await waitForPage(tab.id, new AbortController().signal, false);
      const result = await executeRead(tab.id, config.rule, 0);
      if (!samePage(result.url, config.url)) throw new Error("The tab navigated away from the configured URL.");
      return {...result, ...evaluateRule(result.samples, config.rule, config.filters)};
    } catch (error) { throw new Error(siteError(config, error)); }
  }
  async function open(id) {
    const monitor = find(await state(), id);
    const tab = await tabFor(monitor, new AbortController().signal);
    await api.tabs.update(tab.id, {active: true});
    return tab.id;
  }
  async function openAffected(id) {
    const monitor = find(await state(), id);
    try {
      if (monitor.tabId !== null) {
        await api.tabs.get(monitor.tabId);
        await api.tabs.update(monitor.tabId, {active: true});
        return monitor.tabId;
      }
    } catch { /* Recreate only if the affected tab no longer exists. */ }
    return open(id);
  }
  async function openListing(id, listingId) {
    const monitor = find(await state(), id);
    const listing = [...(monitor.alert?.listings || []), ...monitor.samples].find((sample) => listingKey(sample) === listingId);
    if (!listing) throw new Error("This listing is no longer in the saved results. Run a new check.");
    const direct = safeListingUrl(listing.applicationUrl, monitor.url);
    if (direct) return (await api.tabs.create({url: direct, active: true})).id;
    const tab = await tabFor(monitor, new AbortController().signal);
    await api.tabs.update(tab.id, {active: true});
    await waitForPage(tab.id, new AbortController().signal, false);
    const result = (await api.scripting.executeScript({target: {tabId: tab.id}, func: openApplication, args: [listing]}))[0]?.result;
    if (!result?.opened) throw new Error(result?.reason || "Open this floor plan on the website to apply.");
    return tab.id;
  }
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
  async function deliverAlert(id, alert, soundOverride) {
    const monitor = find(await state(), id);
    const sound = soundOverride === undefined ? monitor.sound : Boolean(soundOverride);
    const notificationId = `${id}:${alert.id}`;
    await mutate((value) => {
      value.notificationTargets ||= {};
      value.notificationTargets[notificationId] = {id, listing: alert.listings[0] || null};
      const entries = Object.entries(value.notificationTargets).slice(-50);
      value.notificationTargets = Object.fromEntries(entries);
    });
    const message = alert.listings.map((sample) => {
      const link = safeListingUrl(sample.applicationUrl || sample.pageUrl, monitor.url) || monitor.url;
      return `${sample.name || "Apartment"}${sample.rent ? ` · ${sample.rent}` : ""}
${sample.context || sample.text}
${link}`;
    }).join("\n\n").slice(0, 1600) || "This is a test availability alert.";
    const results = await Promise.allSettled([
      api.notifications.create(notificationId, {type: "basic", iconUrl: api.runtime.getURL("icons/128.png"), title: `${alert.test ? "Test · " : ""}${monitor.name} · ${alert.listings.length || 1} available`, message, silent: true}),
      ...(sound ? [playAlertSound(api)] : []),
    ]);
    const failures = results.map((result, index) => result.status === "rejected" ? `${index === 0 ? "Desktop notification" : "Alert sound"} failed: ${result.reason.message}` : null).filter(Boolean);
    for (const message of failures) await mutate((value) => history(find(value, id), {kind: "warning", message}));
    return {desktop: results[0].status === "fulfilled", sound: sound ? results[1]?.status === "fulfilled" : false, errors: failures};
  }
  async function testAlert(id, sound) {
    let alert;
    await mutate((value) => {
      const monitor = find(value, id);
      const example = monitor.samples.find((sample) => sample.included !== false) || {id: "test", name: "Example apartment", rent: "Example rent", text: "Test notification", context: "This is a test; it does not indicate availability.", pageUrl: monitor.url};
      alert = {id: crypto.randomUUID(), at: now(), test: true, listings: [example]};
      monitor.alert = alert;
      history(monitor, {kind: "test", message: "Test availability alert"});
    });
    return deliverAlert(id, alert, sound);
  }
  async function snooze(id, minutes) {
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error("Choose a snooze duration between 0 and 1,440 minutes.");
    await mutate((value) => {
      const monitor = find(value, id);
      monitor.snoozedUntil = minutes ? now() + minutes * 60000 : null;
      history(monitor, {kind: "snooze", message: minutes ? `Alerts snoozed for ${minutes} minutes; monitoring continues.` : "Alerts resumed."});
    });
    return state();
  }
  async function openNotification(notificationId) {
    const value = await state();
    const target = value.notificationTargets?.[notificationId];
    const id = target?.id || notificationId.split(":")[0];
    if (target?.listing) {
      const monitor = find(value, id);
      const direct = safeListingUrl(target.listing.applicationUrl, monitor.url);
      if (direct) return (await api.tabs.create({url: direct, active: true})).id;
      // Preserve the target of an older notification even after newer alerts arrive.
      const tab = await tabFor(monitor, new AbortController().signal);
      await api.tabs.update(tab.id, {active: true});
      await waitForPage(tab.id, new AbortController().signal, false);
      await api.scripting.executeScript({target: {tabId: tab.id}, func: openApplication, args: [target.listing]});
      return tab.id;
    }
    return open(id);
  }
  async function dispatch(message) {
    switch (message.type) {
      case "set-debug": {
        if (typeof message.enabled !== "boolean") throw new Error("Choose whether debug capture is enabled.");
        if (!message.enabled) for (const controller of debugRuns.values()) controller.abort();
        await mutate(value => { value.debug ||= {captures: [], seen: {}}; value.debug.enabled = message.enabled; });
        return state();
      }
      case "clear-debug": await mutate(value => { if (value.debug) value.debug.captures = []; }); return state();
      case "open-debug": {
        const capture = (await state()).debug?.captures.find(item => item.id === message.captureId);
        if (!capture?.tabId) throw new Error("No destination tab was opened for this capture.");
        try { await api.tabs.update(capture.tabId, {active: true}); } catch { throw new Error("The captured tab has been closed."); }
        return {tabId: capture.tabId};
      }
      case "profile": return validateProfile((await api.storage.local.get(PROFILE_KEY))[PROFILE_KEY]);
      case "save-profile": {
        const profile = validateProfile(message.profile);
        await api.storage.local.set({[PROFILE_KEY]: profile});
        return {saved: true};
      }
      case "clear-profile": await api.storage.local.set({[PROFILE_KEY]: {}}); return {cleared: true};
      case "fill-application": {
        const profile = validateProfile((await api.storage.local.get(PROFILE_KEY))[PROFILE_KEY]);
        if (!Object.values(profile).some(Boolean)) throw new Error("Save your personal information first.");
        const [tab] = await api.tabs.query({active: true, currentWindow: true});
        if (!tab?.url || !SUPPORTED_SITES.some(site => new URL(site.url).origin === new URL(tab.url).origin)) throw new Error("Open an OurDomain application form in the active tab, then use SpotAlert’s side panel to fill it.");
        const results = await api.scripting.executeScript({target: {tabId: tab.id}, func: fillApplicationForm, args: [profile]});
        return results[0]?.result || {count: 0, fields: []};
      }
      case "state": return state();
      case "save": return {id: await save(message.monitor)};
      case "start": await setEnabled(message.id, true); return state();
      case "stop-all": return stopAll();
      case "pause": await setEnabled(message.id, false); return state();
      case "check": await check(message.id); return state();
      case "set-interval": return setIntervalSeconds(message.id, message.intervalSeconds);
      case "preview": return preview(message.monitor);
      case "open": return {tabId: await open(message.id)};
      case "open-affected": return {tabId: await openAffected(message.id)};
      case "open-listing": return {tabId: await openListing(message.id, message.listingId)};
      case "open-notification": return {tabId: await openNotification(message.notificationId)};
      case "snooze": return snooze(message.id, Number(message.minutes));
      case "test-alert": return testAlert(message.id, message.sound);
      default: throw new Error("Unknown SpotAlert command.");
    }
  }
  return {initialize, state, save, setEnabled, check, dispatch};
}
