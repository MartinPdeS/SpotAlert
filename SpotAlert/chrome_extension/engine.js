import {createApplicationContext} from "./application-context.js";
import {createEngineStore} from "./engine-store.js";
import {recoverEngineState} from "./engine-recovery.js";
import {createDebugCapture} from "./debug-capture.js";
import {BUILD_SENSITIVE_COMMANDS, validateCommand} from "./contracts.js";
import {readBackground, BACKGROUND_RETRY_MS} from './background-reader.js';
import {createTestProfile} from "./test-profiles.js";
import {createProfileStore} from "./profile-store.js";
import {createScheduler} from "./scheduler.js";
import {createApplicationRunner} from "./application-runner.js";
import {createSearchActions} from "./search-actions.js";
import {validateSearch} from "./searches.js";
import {siteForUrl, readerForRule, pageConfig} from './sites/index.js';
import {clientQuestionnaire, parseClientReply} from "./clients.js";
import {ALARM_PREFIX, evaluateRule, sitePattern, siteError, errorKind, safeListingUrl, samePage, inMonitoringHours, nextMonitoringTime, retrySeconds, SUPPORTED_SITES, validateSupportedMonitor, validateMonitor} from "./core.js";
import {PROFILE_KEY, PROFILES_KEY, validateProfile, fillApplicationForm, selectMoveInDate} from "./profile.js";
import {prepareCanvasSignature} from "./application.js";
import {APPLICATION_BUILD} from "./application-diagnostics.js";
import {EMAIL_KEY, sendEmailAlert} from "./email.js";
import {readPage, inspectReadState} from "./page.js";

/** Coordinate persisted monitor state, browser reads, and optional profile storage. */
export function createEngine(api, now = () => Date.now(), timers = globalThis) {
  let checks = Promise.resolve();
  let batchCheck = null;
  const running = new Map();
  const debugRuns = new Map();
  const applications = new Map();
  const applicationTabs = new Set();
  const preparationControllers = new Map();
  const deliveryRetries = new Set();
  const cancel = (id) => { running.get(id)?.abort(); running.delete(id); };
  const {state, mutate} = createEngineStore(api);
  const {claimApplicationTab, withApplicationTab, currentApplicationTab} = createApplicationContext({
    api, state, applicationTabs, preparationControllers,
  });
  const find = (value, id) => {
    const monitor = value.monitors.find((item) => item.id === id);
    if (!monitor) throw new Error("This monitor no longer exists.");
    return monitor;
  };
  const {captureApplications} = createDebugCapture({
    api, now, state, mutate, find, patchRun, waitForPage, debugRuns,
  });
  function history(monitor, event) {
    monitor.history.unshift({id: crypto.randomUUID(), at: now(), ...event});
    monitor.history = monitor.history.slice(0, 80);
  }
  const {FOLDER_KEY, profileFolder, refreshSearchProfiles, saveLibrary, profileLibrary} = createProfileStore(api, mutate);
  const {clearFastTimer, arm, alarmName} = createScheduler(api, now, timers, state, check);
  const {applicationStatus, stopApplication, runApplication, openListing} = createApplicationRunner({
    api, now, state, mutate, find, applications, preparationControllers,
    applicationTabs, claimApplicationTab, waitForPage, profileLibrary, assignedProfile,
  });
  async function reschedule(id) {
    clearFastTimer(id);
    cancel(id);
    await api.alarms.clear(alarmName(id));
    const monitor = (await state()).monitors.find(item => item.id === id);
    if (monitor?.enabled) await schedule(id, now() + monitor.intervalSeconds * 1000);
  }
  const {reconcileSearchLocations, readinessFor, repeatSearchAction, matchSearches} = createSearchActions({
    api, now, state, mutate, find, history, profileLibrary, check,
    clearFastTimer, cancel, alarmName, applications, runApplication, reschedule,
  });

  async function assignedProfile(monitor) {
    const library = await profileLibrary();
    const id = library.activeId;
    const entry = library.profiles.find(item => item.id === id);
    if (!entry) throw new Error("The assigned applicant profile was deleted. Choose a profile for this location.");
    return entry;
  }
  async function initialize() {
    await mutate(value => recoverEngineState(value, now, history));
    const savedLibrary = (await api.storage.local.get(PROFILES_KEY))[PROFILES_KEY];
    if (savedLibrary) await mutate(value => refreshSearchProfiles(value, savedLibrary));
    await reconcileSearchLocations();
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
    const config = {...validateSupportedMonitor(input), notify: false, sound: false};
    if (!(await api.permissions.contains({origins: [sitePattern(config.url)]}))) {
      throw new Error("Allow access to this website before saving the monitor.");
    }
    const site = SUPPORTED_SITES.find((site) => site.url === config.url);
    if (input.id && input.id !== site.id) throw new Error("Choose a supported website from the list.");
    clearFastTimer(site.id); cancel(site.id); await api.alarms.clear(alarmName(site.id));
    return mutate((value) => {
      value.alertPreferences = {notify: false, popup: false, desktop: false, sound: false};
      for (const item of value.monitors) Object.assign(item, value.alertPreferences);
      const existing = find(value, site.id);
      const monitor = {
        ...existing, ...config,
        generalIntervalSeconds: config.intervalSeconds,
        enabled: false, phase: "paused", available: null, samples: [], error: null, errorKind: null, consecutiveErrors: 0,
        pendingArrivals: [], alert: null, backgroundRetryAt: null, readFallbackReason: null, readMethod: null,
        nextCheckAt: null, tabId: existing?.url === config.url ? existing.tabId : null,
        lastCheckedAt: null, lastDurationMs: null,
        generation: crypto.randomUUID(),
      };
      value.monitors[value.monitors.indexOf(existing)] = monitor;
      history(monitor, {kind: "saved", message: "Rule saved. Preview it or start watching."});
      return monitor.id;
    });
  }
  async function changeMonitoring(ids, enabled) {
    const transitions = await mutate(value => ids.map(id => {
      const monitor = find(value, id);
      const profileActive = value.searches?.some(search => search.enabled && search.locationIds.includes(id));
      const wasEnabled = monitor.enabled;
      monitor.enabled = Boolean(enabled || profileActive);
      monitor.searchManaged = !enabled && !!profileActive;
      if (!monitor.enabled) {
        monitor.phase = 'paused'; monitor.nextCheckAt = null; monitor.generation = crypto.randomUUID();
      }
      history(monitor, {kind: enabled ? 'started' : 'paused', message: enabled ? 'General monitoring started.' : profileActive ? 'General monitoring stopped. Profile searches continue.' : 'General monitoring stopped. The browser tab stays open.'});
      return {id, enabled: monitor.enabled, start: monitor.enabled && !wasEnabled};
    }));
    for (const transition of transitions) if (!transition.enabled) { clearFastTimer(transition.id); cancel(transition.id); await api.alarms.clear(alarmName(transition.id)); }
    return transitions;
  }
  async function setEnabled(id, enabled) {
    const [transition] = await changeMonitoring([id], enabled);
    if (transition.start) return check(id, true);
  }
  async function selectedBuildings(requested) {
    const monitors = (await state()).monitors;
    const ids = requested === undefined ? monitors.map(monitor => monitor.id) : requested;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !monitors.some(monitor => monitor.id === id))) throw new Error('Select at least one supported building.');
    return monitors.filter(monitor => ids.includes(monitor.id)).map(monitor => monitor.id);
  }
  async function cancelCheck(id) {
    clearFastTimer(id); cancel(id); await api.alarms.clear(alarmName(id));
    const active = await mutate(value => {
      const monitor = find(value, id);
      monitor.generation = crypto.randomUUID();
      monitor.phase = monitor.enabled ? 'waiting' : 'paused';
      monitor.nextCheckAt = null;
      history(monitor, {kind: 'cancelled', message: 'Current check cancelled. Previous results retained.'});
      return monitor.enabled;
    });
    if (active) await schedule(id, now() + (await state()).monitors.find(item => item.id === id).intervalSeconds * 1000);
    return state();
  }
  function checkAll(ids) {
    if (batchCheck) return batchCheck.promise;
    const batch = {cancelled: false, currentId: null};
    batchCheck = batch;
    batch.promise = (async () => {
      await mutate(value => { value.checkBatch = {status: 'running', locationIds: ids, total: ids.length, completed: 0, failed: 0, currentId: null, startedAt: now()}; });
      try {
        for (const id of ids) {
          if (batch.cancelled) break;
          batch.currentId = id;
          await mutate(value => { value.checkBatch.currentId = id; });
          if (batch.cancelled) break;
          try { await check(id); }
          catch (error) {
            await mutate(value => { const monitor = find(value, id); monitor.error = siteError(monitor, error); monitor.errorKind = errorKind(error); monitor.phase = 'error'; history(monitor, {kind: 'error', message: monitor.error}); });
          }
          if (batch.cancelled) break;
          await mutate(value => {
            value.checkBatch.completed++;
            if (find(value, id).error) value.checkBatch.failed++;
          });
        }
      } finally {
        await mutate(value => { Object.assign(value.checkBatch, {status: batch.cancelled ? 'cancelled' : 'completed', currentId: null, finishedAt: now()}); });
        batchCheck = null;
      }
      return state();
    })();
    return batch.promise;
  }
  async function cancelAllChecks() {
    if (batchCheck) {
      batchCheck.cancelled = true;
      if (batchCheck.currentId) await cancelCheck(batchCheck.currentId);
      await batchCheck?.promise;
    }
    return state();
  }
  async function stopAll() {
    if (batchCheck) batchCheck.cancelled = true;
    await mutate(value => { for (const search of value.searches || []) { search.enabled = false; search.generation = crypto.randomUUID(); } });
    await Promise.all([...new Set([...applications.keys(), ...(await state()).monitors.filter(m => m.application?.status === "running").map(m => m.id)])].map(id => stopApplication(id)));
    await mutate(async (value) => {
      for (const search of value.searches || []) { search.enabled = false; search.generation = crypto.randomUUID(); }
      for (const monitor of value.monitors) {
        clearFastTimer(monitor.id);
        cancel(monitor.id);
        if (monitor.enabled || ["queued", "refreshing", "reading", "capturing"].includes(monitor.phase)) {
          history(monitor, {kind: "paused", message: "All monitoring stopped. The browser tab stays open."});
        }
        monitor.enabled = false;
        monitor.searchManaged = false;
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
      monitor.generalIntervalSeconds = config.intervalSeconds;
      history(monitor, {kind: "interval", message: `Refresh interval set to ${config.intervalSeconds} seconds.`});
    });
    await reconcileSearchLocations();
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
  function waitForRead(signal) {
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, 250);
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Check cancelled.")); };
      signal.addEventListener("abort", abort, {once: true});
      if (signal.aborted) abort();
    });
  }
  async function executeRead(tabId, rule, waitMs = 12000, signal = new AbortController().signal) {
    const deadline = Date.now() + waitMs;
    let emptyAttempts = 0;
    while (true) {
      if (signal.aborted) throw new Error("Check cancelled.");
      let results;
      try {
        // Keep injected work synchronous. The worker waits for late listings,
        // rather than leaving a Promise tied to a document being refreshed.
        results = await api.scripting.executeScript({target: {tabId}, func: readPage, args: [rule, 0, readerForRule(rule)]});
      } catch (error) {
        if (/cannot access|missing host permission|manifest must request permission|extensions gallery cannot be scripted/i.test(error.message)) {
          throw Object.assign(new Error("Chrome blocked access to this website. Open Chrome → Extensions → SpotAlert → Site access and allow the affected housing website, then reload its tab."), {kind: "permission"});
        }
        if (!/frame|context|document|navigation|removed/i.test(error.message)) throw error;
      }
      if (signal.aborted) throw new Error("Check cancelled.");
      const frame = results?.find(item => item.frameId === 0) || results?.[0];
      const result = frame?.result;
      if (result) {
        emptyAttempts = 0;
        if (result.pending && Date.now() < deadline) {
          await waitForRead(signal);
          continue;
        }
        if (result.error) throw Object.assign(new Error(result.error), {kind: result.errorKind});
        return result;
      }
      const inspection = (await api.scripting.executeScript({target: {tabId}, func: inspectReadState}).catch(() => []))?.[0]?.result;
      if (signal.aborted) throw new Error("Check cancelled.");
      if (inspection?.verification) throw Object.assign(new Error("The website is showing a verification prompt. Open the affected tab and complete it, then check again."), {kind: "verification"});
      if (inspection?.login) throw Object.assign(new Error("The website requires a login. Open the affected tab and sign in, then check again."), {kind: "login"});
      if (++emptyAttempts >= 2) throw Object.assign(new Error("Chrome returned no page data after retrying. Open the affected tab and press Check now again once its listings are loaded."), {kind: "loading"});
      await waitForPage(tabId, signal, false);
      await waitForRead(signal);
    }
  }
  async function run(id, controller, scheduled) {
    const startedAt = now();
    let monitor;
    let generation;
    try {
      monitor = (await state()).monitors.find((item) => item.id === id);
      if (!monitor || controller.signal.aborted || (scheduled && !monitor.enabled)) return;
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
      let result;
      let fallback = monitor.backgroundRetryAt > now() ? monitor.readFallbackReason || 'Background retry cooldown' : null;
      if (!fallback) {
        await patchRun(id, generation, current => { current.readMethod = 'background'; });
        const attempt = await readBackground(api, monitor, controller.signal);
        result = attempt.result;
        fallback = attempt.fallback;
      }
      if (controller.signal.aborted) return;
      await patchRun(id, generation, current => {
        current.readMethod = result ? 'background' : 'browser';
        current.readFallbackReason = result ? null : fallback;
        current.backgroundRetryAt = result ? null : monitor.backgroundRetryAt > now() ? monitor.backgroundRetryAt : now() + BACKGROUND_RETRY_MS;
      });
      if (!result) {
        const tab = await tabFor(monitor, controller.signal);
        if (controller.signal.aborted) return;
        await patchRun(id, generation, current => { current.tabId = tab.id; });
        await waitForPage(tab.id, controller.signal, tab.status === 'complete');
        if (controller.signal.aborted) return;
        await patchRun(id, generation, current => { current.phase = 'reading'; });
        result = await executeRead(tab.id, monitor.rule, 12000, controller.signal);
      }
      if (!samePage(result.url, monitor.url)) throw new Error("The tab navigated away from the saved URL. Check login or update the monitor URL.");
      const evaluated = evaluateRule(result.samples, monitor.rule, monitor.filters);
      if (controller.signal.aborted) return;
      const accepted = await patchRun(id, generation, (current) => {
        const previousTexts = current.samples.map((sample) => sample.text);
        const nextSamples = evaluated.matches.map((sample) => ({...sample, text: sample.text.slice(0, 2000), applicationUrl: safeListingUrl(sample.applicationUrl, current.url), pageUrl: safeListingUrl(sample.pageUrl, current.url) || current.url}));
        const changed = JSON.stringify(previousTexts) !== JSON.stringify(nextSamples.map((sample) => sample.text));
        current.pendingArrivals = [];
        current.alert = null;
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
          kind: "check", readMethod: current.readMethod, available: evaluated.available, changed,
          message: evaluated.available ? "Availability detected" : "No availability detected",
          matchedCount: evaluated.matches.filter((sample) => sample.matched).length,
          totalCount: evaluated.matches.length,
          preview: nextSamples.filter((sample) => sample.matched).slice(0, 3).map((sample) => sample.text.slice(0, 120)),
        });
      });
      if (accepted && !controller.signal.aborted) await matchSearches(id, result.samples);
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
  /** @param {import("./contracts.js").RuntimeCommand} message */
  async function dispatch(message) {
    validateCommand(message);
    if (message.dashboardBuild && BUILD_SENSITIVE_COMMANDS.has(message.type) && message.dashboardBuild !== APPLICATION_BUILD) throw new Error('SpotAlert versions do not match. Reload the extension at chrome://extensions and reopen the dashboard.');
    switch (message.type) {
      case 'search-readiness': {
        const search = (await state()).searches.find(search => search.id === message.id);
        if (!search) throw new Error('Search not found.');
        return readinessFor({...search, actions: message.actions || search.actions, createAccount: message.createAccount ?? search.createAccount});
      }
      case 'repeat-search-action': return repeatSearchAction(message);
      case "save-search": {
        const library = await profileLibrary();
        const existingSearch = (await state()).searches.find(item => item.id === message.search?.id);
        const config = validateSearch(
          {...message.search, name: message.search?.name ?? (existingSearch?.profileId === message.search?.profileId ? existingSearch?.name : undefined), intervalSeconds: message.search?.intervalSeconds ?? existingSearch?.intervalSeconds ?? 5},
          library.profiles,
        );
        if (config.actions.email && !(await api.storage.local.get(EMAIL_KEY))[EMAIL_KEY]?.apiKey) throw new Error("Configure the Resend API key in Settings → Email delivery first.");
        await mutate(value => {
          const existing = value.searches.find(item => item.id === message.search.id);
          if (message.search.id && !existing) throw new Error("Search not found.");
          if (!existing && value.searches.length >= 100) throw new Error("You can save up to 100 searches.");
          if (existing) Object.assign(existing, config, {enabled: false, generation: crypto.randomUUID(), results: {}, error: null});
          else value.searches.push({...config, id: crypto.randomUUID(), generation: crypto.randomUUID(), enabled: false, results: {}, activity: []});
        });
        for (const [id, run] of applications) if (run.searchId === message.search.id) await stopApplication(id);
        await reconcileSearchLocations();
        return state();
      }
      case "set-search-enabled": {
        const value = await state();
        const search = value.searches.find(item => item.id === message.id);
        if (!search) throw new Error("Search not found.");
        if (message.enabled && message.expectedGeneration && message.expectedGeneration !== search.generation) throw new Error('This search changed. Close the dialog and review the current search before starting.');
        if (typeof message.enabled !== 'boolean') throw new Error("Choose a valid search status.");
        let config = null;
        if (message.enabled) {
          const library = await profileLibrary();
          config = validateSearch({...search, actions: message.actions || search.actions, createAccount: message.createAccount ?? search.createAccount, intervalSeconds: message.intervalSeconds ?? search.intervalSeconds ?? 5}, library.profiles);
          const readiness = await readinessFor({...search, ...config}, library);
          if (!readiness.canStart) throw new Error(readiness.blockers.join(' '));
        }
        await mutate(value => {
          const current = value.searches.find(item => item.id === message.id);
          if (!current || current.generation !== search.generation) throw new Error('This search changed. Review it before starting or pausing.');
          Object.assign(current, {...(config ? {actions: config.actions, createAccount: config.createAccount, intervalSeconds: config.intervalSeconds} : {}), enabled: message.enabled, error: null, generation: crypto.randomUUID()});
        });
        if (!message.enabled) for (const [id, run] of applications) if (run.searchId === message.id) await stopApplication(id);
        await reconcileSearchLocations();
        return state();
      }
      case "set-search-interval": {
        const search = (await state()).searches.find(item => item.id === message.id);
        if (!search) throw new Error("Search not found.");
        const library = await profileLibrary();
        const config = validateSearch({...search, intervalSeconds: message.intervalSeconds}, library.profiles);
        await mutate(value => {
          const current = value.searches.find(item => item.id === message.id);
          if (!current) throw new Error("Search not found.");
          current.intervalSeconds = config.intervalSeconds;
        });
        await reconcileSearchLocations();
        return state();
      }
      case "delete-search": {
        await mutate(value => { value.searches = value.searches.filter(item => item.id !== message.id); });
        for (const [id, run] of applications) if (run.searchId === message.id) await stopApplication(id);
        await reconcileSearchLocations();
        return state();
      }
      case 'set-alerts':
      case 'test-alert':
      case 'snooze':
      case 'snooze-all':
      case 'retry-delivery': throw new Error('Notifications are configured per profile search. Email delivery settings are in Settings.');
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
      case 'assign-profile': throw new Error('Assign the profile to a saved search, not to a location.');
      case "profiles": return profileLibrary();
      case "profile-folder-status": return (await api.storage.local.get(FOLDER_KEY))[FOLDER_KEY] || {enabled: false};
      case "enable-profile-folder": {
        const library = await profileLibrary();
        const disk = await profileFolder("write", library);
        await api.storage.local.set({[FOLDER_KEY]: {enabled: true, path: disk.folder}});
        return {enabled: true, path: disk.folder};
      }
      case "open-profile-folder": return profileFolder("open");
      case "create-test-profiles": {
        const library = await profileLibrary();
        const missing = [1, 2].filter(index => !library.profiles.some(entry => entry.id === `spotalert-test-profile-${index}`));
        if (library.profiles.length + missing.length > 50) throw new Error("Make room for two test profiles first (50 profiles maximum).");
        for (const index of [1, 2]) {
          const position = library.profiles.findIndex(entry => entry.id === `spotalert-test-profile-${index}`);
          if (position < 0) library.profiles.push(createTestProfile(index));
          else if (message.regenerate === true) {
            if (library.profiles[position].testProfile !== true) throw new Error("This profile identifier is already in use by a saved applicant.");
            library.profiles[position] = createTestProfile(index);
          }
        }
        library.activeId = "spotalert-test-profile-1";
        await saveLibrary(library);
        return library;
      }
      case "create-profile": {
        const library = await profileLibrary();
        if (library.profiles.length >= 50) throw new Error("You can save up to 50 profiles.");
        const entry = {id: crypto.randomUUID(), name: "New profile", details: {}};
        library.profiles.push(entry); library.activeId = entry.id;
        await saveLibrary(library);
        return library;
      }
      case "select-profile": {
        const library = await profileLibrary();
        const entry = library.profiles.find(item => item.id === message.id);
        if (!entry) throw new Error("Profile not found.");
        library.activeId = entry.id;
        await saveLibrary(library);
        return library;
      }
      case "save-profile": {
        const profile = validateProfile(message.profile);
        const library = await profileLibrary();
        const entry = library.profiles.find(item => item.id === library.activeId);
        const name = message.name === undefined ? entry.name : String(message.name).trim();
        if (!name || name.length > 80) throw new Error("Enter a profile name of up to 80 characters.");
        entry.name = name; entry.details = profile;
        await saveLibrary(library);
        return {saved: true};
      }
      case "clear-profile": {
        const library = await profileLibrary();
        const deletedId = library.activeId;
        await mutate(value => { for (const search of value.searches || []) if (search.profileId === deletedId) { search.enabled = false; search.error = 'The profile was deleted.'; search.generation = crypto.randomUUID(); } });
        for (const [id, run] of applications) if (run.searchId && (await state()).searches.find(item => item.id === run.searchId)?.profileId === deletedId) await stopApplication(id);
        library.profiles = library.profiles.filter(item => item.id !== library.activeId);
        if (!library.profiles.length) library.profiles.push({id: "default", name: "My profile", details: {}});
        library.activeId = library.profiles[0].id;
        await saveLibrary(library);
        await reconcileSearchLocations();
        return {cleared: true};
      }
      case "prepare-canvas-signature": {
        if (message.consent !== true) throw new Error('Explicitly choose the agreement and signature action first.');
        const tab = await currentApplicationTab(message.monitorId, true);
        const url = new URL(tab.url);
        const config = pageConfig(siteForUrl(tab.url));
        if (!config?.agreementSignature || !url.pathname.toLowerCase().endsWith('/' + config.paths.applicant) || url.searchParams.get('stepname')?.toLowerCase() !== config.agreementSignature.step) throw new Error('The selected tab is no longer the Canvas applicant information page.');
        return withApplicationTab(tab.id, async () => {
        const results = await api.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: prepareCanvasSignature, args: [message.screening === true, config]});
        const result = results[0]?.result;
        if (result?.error) throw new Error(result.error);
        if (!result?.agreementChecked || !result?.signatureSelected) throw new Error('The website did not confirm both selections. Review the application tab.');
        if (message.screening === true && !result.screeningChecked) throw new Error('The website did not confirm the screening agreement.');
        return result;
        });
      }
      case "prepare-application":
      case "fill-application": {
        const library = await profileLibrary();
        const profile = validateProfile((await api.storage.local.get(PROFILE_KEY))[PROFILE_KEY]);
        if (!Object.values(profile).some(Boolean)) throw new Error("Save your personal information first.");
        const tab = await currentApplicationTab(message.monitorId, message.canvasSignature === true);
        if (!tab?.url || !SUPPORTED_SITES.some(site => new URL(site.url).origin === new URL(tab.url).origin)) throw new Error("Open a supported housing application form in the active tab, then use SpotAlert’s side panel to fill it.");
        const config = pageConfig(siteForUrl(tab.url));
        return withApplicationTab(tab.id, async signal => {
        const monitorId = siteForUrl(tab.url).id;
        await applicationStatus(monitorId, {status: 'running', stage: 'filling', build: APPLICATION_BUILD, tabId: tab.id, trace: [], applicantName: library.profiles.find(item => item.id === library.activeId)?.name || 'Saved profile', listingName: 'Current application tab', listingId: null, moveInDate: null, missingFields: [], structure: null, message: 'Preparing the open application…'});
        try {
        if (signal.aborted) throw new Error('Application automation stopped.');
        await api.scripting.executeScript({target: {tabId: tab.id}, func: () => { delete document.documentElement.dataset.spotalertApplicationStopped; }});
        if (signal.aborted) throw new Error('Application automation stopped.');
        const results = await api.scripting.executeScript({target: {tabId: tab.id}, world: "MAIN", func: fillApplicationForm, args: [profile, config]});
        if (signal.aborted) throw new Error("Application automation stopped.");
        let result = results[0]?.result || {count: 0, fields: []};
        if (message.canvasSignature === true) {
          const prepared = (await api.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: prepareCanvasSignature, args: [true, config]}))[0]?.result;
          if (prepared?.error || !prepared?.agreementChecked || !prepared?.signatureSelected || !prepared?.screeningChecked) throw new Error(prepared?.error || 'The website did not confirm the selected agreements and signature.');
          result = {...result, ...prepared};
        }
        result.tabId = tab.id;
        if (profile.moveInFrom) {
          if (signal.aborted) throw new Error('Application automation stopped.');
          await applicationStatus(monitorId, {stage: 'selecting-date', message: 'Selecting the preferred move-in date…'});
          const dates = await api.scripting.executeScript({target: {tabId: tab.id}, func: selectMoveInDate, args: [profile]});
          const date = dates[0]?.result || {count: 0};
          result = {...result, ...date, count: result.count + date.count, fields: [...(result.fields || []), ...(date.count ? ['moveInFrom'] : [])]};
        }
        if (signal.aborted) throw new Error('Application automation stopped.');
        await applicationStatus(monitorId, {status: 'stopped', kind: 'review', tabId: tab.id, filled: result.count, message: result.message || 'Details filled. Review the application before saving.'});
        return result;
        } catch (error) {
          await applicationStatus(monitorId, {status: 'stopped', kind: signal.aborted ? 'cancelled' : 'error', tabId: tab.id, message: error.message});
          throw error;
        }
        });
      }
      case "send-client-questionnaire": {
        const to = String(message.to || "").trim(), replyTo = String(message.replyTo || "").trim();
        if (![to, replyTo].every(address => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) throw new Error("Enter valid client and reply-to email addresses.");
        const name = String(message.name || "").trim().slice(0, 80);
        return sendEmailAlert(api, {id: crypto.randomUUID()}, "Your apartment application details", clientQuestionnaire(name), {to, replyTo});
      }
      case "import-client-profile": {
        const profile = parseClientReply(message.reply);
        const name = String(message.name || "").trim();
        if (!name || name.length > 80) throw new Error("Enter a profile name of up to 80 characters.");
        const library = await profileLibrary();
        if (library.profiles.length >= 50) throw new Error("You can save up to 50 profiles.");
        const entry = {id: crypto.randomUUID(), name, details: profile};
        library.profiles.push(entry); library.activeId = entry.id;
        await saveLibrary(library);
        return {saved: true};
      }
      case 'test-email': {
        const profile = (await profileLibrary()).profiles.find(profile => profile.id === message.profileId);
        if (!profile?.details.email) throw new Error('Select a saved profile with an email address for the test.');
        return sendEmailAlert(api, {id: crypto.randomUUID()}, 'SpotAlert · Test email', 'SpotAlert email delivery test.', {to: profile.details.email});
      }
      case "engine-info": return {build: APPLICATION_BUILD, version: api.runtime.getManifest?.().version || 'development'};
      case "open-application-target": {
        const tab = await api.tabs.get(message.tabId);
        if (!siteForUrl(tab.url)) throw new Error('The application tab is no longer on a supported website.');
        await api.tabs.update(tab.id, {active: true});
        return {tabId: tab.id};
      }
      case "state": return state();
      case "save": {
        const id = await save(message.monitor);
        await reconcileSearchLocations();
        return {id};
      }
      case "start": await setEnabled(message.id, true); return state();
      case "stop-all": return stopAll();
      case "pause":
        await setEnabled(message.id, false); return state();
      case "cancel-check": return cancelCheck(message.id);
      case 'set-buildings-monitoring': {
        if (typeof message.enabled !== 'boolean') throw new Error('Choose a valid monitoring status.');
        const ids = await selectedBuildings(message.ids);
        const transitions = await changeMonitoring(ids, message.enabled);
        for (const transition of transitions) if (transition.start) check(transition.id, true).catch(console.error);
        return state();
      }
      case 'check-all': return checkAll(await selectedBuildings(message.ids));
      case "cancel-all-checks": return cancelAllChecks();
      case "check": await check(message.id); return state();
      case "set-interval": return setIntervalSeconds(message.id, message.intervalSeconds);
      case "preview": return preview(message.monitor);
      case "open": return {tabId: await open(message.id)};
      case "open-affected": return {tabId: await openAffected(message.id)};
      case "open-listing": {
        const result = await openListing(message.id, message.listingId, message.profileId, message.createAccount === true, {enabled: message.signatureConsent === true, screening: message.screening === true});
        return typeof result === "number" ? {tabId: result} : result;
      }
      case "continue-application": throw new Error("Applications run in one pass. Use Apply on an apartment to start a new run.");
      case "open-application-tab": {
        const app = find(await state(), message.id).application;
        if (!app?.tabId) throw new Error("No application tab has been opened.");
        try { await api.tabs.update(app.tabId, {active: true}); }
        catch (error) {
          if (/No tab with id|Invalid tab ID|tab.*closed/i.test(error.message)) {
            const messageText = "The application tab was closed. Use Apply on the apartment to start a new run.";
            await applicationStatus(message.id, {status: "stopped", kind: "error", tabId: null, message: messageText});
            throw new Error(messageText);
          }
          throw error;
        }
        return {tabId: app.tabId};
      }
      case "stop-application": {
        await stopApplication(message.id);
        return {stopped: true};
      }
      default: throw new Error("Unknown SpotAlert command.");
    }
  }
  return {initialize, state, save, setEnabled, check, dispatch};
}
