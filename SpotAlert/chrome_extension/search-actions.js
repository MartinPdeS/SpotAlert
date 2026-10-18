import {searchReadiness, searchClaimKey, claimActionId} from "./searches.js";
import {EMAIL_KEY, sendEmailAlert} from "./email.js";
import {validateProfile} from "./profile.js";
import {sitePattern, listingKey, evaluateRule, safeListingUrl} from "./core.js";
export function createSearchActions({api, now, state, mutate, find, history, profileLibrary, check, clearFastTimer, cancel, alarmName, applications, runApplication, reschedule}) {
  let searchActions = Promise.resolve();
  // Searches share page reads, but retain their own matches and action records.
  async function reconcileSearchLocations() {
    const transitions = await mutate(value => {
      const wanted = new Set((value.searches || []).filter(search => search.enabled).flatMap(search => search.locationIds));
      const transitions = [];
      for (const monitor of value.monitors) {
        const start = wanted.has(monitor.id) && !monitor.enabled;
        const stop = !wanted.has(monitor.id) && monitor.searchManaged;
        if (!start && !stop) continue;
        Object.assign(monitor, {enabled: start, searchManaged: start, phase: start ? 'waiting' : 'paused', nextCheckAt: null, generation: crypto.randomUUID()});
        history(monitor, {kind: start ? 'started' : 'paused', message: start ? 'Started for profile searches.' : 'No active profile searches use this location.'});
        transitions.push({id: monitor.id, enabled: start});
      }
      for (const monitor of value.monitors) {
        const searchIntervals = (value.searches || [])
          .filter(search => search.enabled && search.locationIds.includes(monitor.id))
          .map(search => search.intervalSeconds ?? 5);
        if (searchIntervals.length) {
          monitor.generalIntervalSeconds ??= monitor.intervalSeconds;
        }
        const generalIntervalSeconds = monitor.generalIntervalSeconds ?? monitor.intervalSeconds;
        const generalInterval = monitor.enabled && !monitor.searchManaged
          ? generalIntervalSeconds
          : Infinity;
        const requestedInterval = Math.min(generalInterval, ...searchIntervals);
        const intervalSeconds = Number.isFinite(requestedInterval)
          ? requestedInterval
          : generalIntervalSeconds;
        if (monitor.intervalSeconds === intervalSeconds) continue;
        monitor.intervalSeconds = intervalSeconds;
        transitions.push({id: monitor.id, enabled: monitor.enabled, reschedule: true});
      }
      return transitions;
    });
    for (const id of new Set(transitions.map(item => item.id))) {
      const locationTransitions = transitions.filter(item => item.id === id);
      const stopped = locationTransitions.some(item => !item.enabled);
      const started = locationTransitions.some(item => item.enabled && !item.reschedule);
      const intervalChanged = locationTransitions.some(item => item.reschedule);
      if (stopped) {
        clearFastTimer(id);
        cancel(id);
        await api.alarms.clear(alarmName(id));
      } else if (started) {
        check(id, true).catch(console.error);
      } else if (intervalChanged) {
        await reschedule(id);
      }
    }
  }
  async function readinessFor(search, library = null) {
    library ||= await profileLibrary();
    const email = (await api.storage.local.get(EMAIL_KEY))[EMAIL_KEY] || {};
    const result = searchReadiness(search, library.profiles, email);
    for (const location of result.locations) {
      const monitor = (await state()).monitors.find(item => item.id === location.id);
      if (monitor && !(await api.permissions.contains({origins: [sitePattern(monitor.url)]}))) {
        result.blockers.push(`${location.name}: website access is missing. Restore access in Chrome extension settings.`);
        location.ready = false;
      }
      if (monitor && ['login', 'verification'].includes(monitor.errorKind)) result.warnings.push(`${location.name}: complete the ${monitor.errorKind} prompt in the website tab.`);
    }
    result.canStart = !result.blockers.length;
    result.ready = result.canStart && result.locations.every(location => location.ready);
    return result;
  }
  async function repeatSearchAction(message) {
    if (message.confirmed !== true) throw new Error('Review and explicitly authorize another attempt first.');
    if (!['email', 'autoApply'].includes(message.channel)) throw new Error('Choose a supported action.');
    const library = await profileLibrary();
    const saved = (await state()).searches.find(search => search.id === message.id);
    if (!saved) throw new Error('Search not found.');
    if (!saved.enabled || !saved.actions[message.channel]) throw new Error('Start this search with the requested action enabled before trying again.');
    if (!saved.locationIds.includes(message.monitorId)) throw new Error('This location is not part of the search.');
    const readiness = await readinessFor({...saved, actions: {[message.channel]: true}}, library);
    if (!readiness.canStart) throw new Error(readiness.blockers.join(' '));
    const entry = library.profiles.find(profile => profile.id === saved.profileId);
    const snapshot = {id: entry.id, name: entry.name, details: validateProfile(entry.details)};
    const job = await mutate(value => {
      const search = value.searches.find(search => search.id === message.id);
      if (!search?.enabled || search.generation !== saved.generation || !search.actions[message.channel]) throw new Error('Start this search with the requested action enabled before trying again.');
      if (!search.locationIds.includes(message.monitorId)) throw new Error('This location is not part of the search.');
      const monitor = find(value, message.monitorId);
      const result = search.results?.[message.monitorId];
      if (!result || !Number.isFinite(result.at) || monitor.error || now() - result.at > Math.max(60000, monitor.intervalSeconds * 3000)) throw new Error('Run a successful fresh location check before trying again.');
      const listing = result.matches.find(item => item.matched && listingKey(item) === message.listingId);
      if (!listing) throw new Error('This apartment no longer matches the search.');
      const key = searchClaimKey(search.profileId, message.monitorId, message.listingId, message.channel);
      const previous = value.searchClaims[key];
      if (!previous || claimActionId(previous) !== message.expectedClaimId) throw new Error('The previous action changed. Review its latest outcome and try again.');
      if (['queued', 'running'].includes(previous.status)) throw new Error('This action is already queued or running.');
      const action = {id: crypto.randomUUID(), at: now(), monitorId: message.monitorId, listingId: listingKey(listing), listingName: listing.name || listing.context || 'Apartment', channel: message.channel, status: 'queued', message: 'Another attempt explicitly authorized.', repeatedFrom: claimActionId(previous)};
      value.searchClaims[key] = {...action, searchId: search.id, attemptCount: (previous.attemptCount || 1) + 1,
        previousAttempts: [{id: claimActionId(previous), at: previous.at || null, status: previous.status || 'recorded', message: previous.message || 'Previous attempt recorded.', tabId: previous.tabId || null}, ...(previous.previousAttempts || [])].slice(0, 10)};
      search.activity.unshift(action);
      return {previousClaim: structuredClone(previous), searchId: search.id, generation: search.generation, key, actionId: action.id, monitorId: message.monitorId, listing: structuredClone(listing), snapshot, channel: message.channel, createAccount: search.createAccount};
    });
    searchActions = searchActions.then(() => executeSearchAction(job)).catch(console.error);
    return state();
  }
  async function matchSearches(monitorId, samples) {
    const library = await profileLibrary();
    const jobs = await mutate(value => {
      const monitor = find(value, monitorId);
      const jobs = [];
      for (const search of (value.searches || []).filter(item => item.enabled && item.locationIds.includes(monitorId))) {
        const entry = library.profiles.find(item => item.id === search.profileId);
        if (!entry) { search.enabled = false; search.error = "The profile was deleted."; continue; }
        const snapshot = {id: entry.id, name: entry.name, details: validateProfile(entry.details)};
        const matches = evaluateRule(samples, monitor.rule, {clientPreferences: snapshot.details}).matches.map(sample => ({...sample, applicationUrl: safeListingUrl(sample.applicationUrl, monitor.url), pageUrl: safeListingUrl(sample.pageUrl, monitor.url) || monitor.url}));
        search.results ||= {};
        search.results[monitorId] = {at: now(), matches};
        search.activity ||= [];
        for (const listing of matches.filter(item => item.matched)) {
          for (const channel of ['autoApply', 'email'].filter(channel => search.actions[channel])) {
            // Permanent per-profile claims also deduplicate overlapping searches.
            const key = searchClaimKey(entry.id, monitorId, listingKey(listing), channel);
            if (value.searchClaims[key]) continue;
            const action = {id: crypto.randomUUID(), at: now(), monitorId, listingId: listingKey(listing), listingName: listing.name || listing.context || 'Apartment', channel, status: 'queued', message: 'Waiting to run'};
            value.searchClaims[key] = {...action, searchId: search.id};
            search.activity.unshift(action);
            jobs.push({generation: search.generation, key, searchId: search.id, actionId: action.id, monitorId, listing: structuredClone(listing), snapshot, channel, createAccount: search.createAccount});
          }
        }
        search.activity = [...search.activity.filter(item => ['queued', 'running'].includes(item.status)), ...search.activity.filter(item => !['queued', 'running'].includes(item.status)).slice(0, 100)].sort((a, b) => b.at - a.at);
      }
      return jobs;
    });
    for (const job of jobs) searchActions = searchActions.then(() => executeSearchAction(job)).catch(console.error);
  }
  async function executeSearchAction(job) {
    const {searchId, actionId, monitorId, listing, snapshot, channel} = job;
    const update = (status, message, extra = {}) => mutate(value => {
      const action = value.searches?.find(item => item.id === searchId)?.activity.find(item => item.id === actionId);
      if (action) Object.assign(action, {status, message, ...extra});
      if (claimActionId(value.searchClaims[job.key]) === actionId) Object.assign(value.searchClaims[job.key], {status, message, ...extra});
    });
    const cancelQueued = message => mutate(value => {
      const action = value.searches?.find(item => item.id === searchId)?.activity.find(item => item.id === actionId);
      if (action) Object.assign(action, {status: 'cancelled', message});
      if (claimActionId(value.searchClaims[job.key]) === actionId) {
        if (job.previousClaim) value.searchClaims[job.key] = job.previousClaim;
        else delete value.searchClaims[job.key];
      }
    });
    let search = (await state()).searches?.find(item => item.id === searchId);
    if (!search?.enabled || search.generation !== job.generation || !search.actions[channel]) return cancelQueued('Search changed or paused before execution.');
    if (!search.results?.[monitorId]?.matches.some(item => item.matched && listingKey(item) === listingKey(listing))) return cancelQueued('The listing no longer matches.');
    const library = await profileLibrary();
    if (!library.profiles.some(item => item.id === snapshot.id)) return cancelQueued('The profile was deleted.');
    await update('running', channel === 'email' ? 'Sending to the profile holder…' : 'Starting application…');
    try {
      if (channel === 'autoApply') {
        // Manual applications and automated searches never share an active run.
        while (applications.has(monitorId)) {
          await applications.get(monitorId).promise.catch(() => {});
        }
        search = (await state()).searches?.find(item => item.id === searchId);
        if (!search?.enabled || search.generation !== job.generation) return cancelQueued('Search changed or paused before application started.');
        if (!search.results?.[monitorId]?.matches.some(item => item.matched && listingKey(item) === listingKey(listing))) return cancelQueued('The apartment no longer matches before application start.');
        const controller = new AbortController();
        const run = {controller, searchId};
        applications.set(monitorId, run);
        run.promise = runApplication(monitorId, listing, controller.signal, snapshot.id, job.createAccount, {}, snapshot).finally(() => applications.delete(monitorId));
        const result = await run.promise;
        await update(result.kind === 'cancelled' ? 'cancelled' : result.kind === 'error' ? 'failed' : 'review', result.moveInMessage || 'Review the application tab.', {tabId: result.tabId});
      } else {
        const stateValue = await state();
        search = stateValue.searches?.find(item => item.id === searchId);
        if (!search?.enabled || search.generation !== job.generation) return cancelQueued('Search changed or paused before email delivery.');
        const monitor = find(stateValue, monitorId);
        const application = search.activity.find(item => item.monitorId === monitorId && item.channel === 'autoApply' && item.listingId === listingKey(listing));
        const body = [`Hello ${snapshot.details.firstName || snapshot.name},`, '', `A matching apartment was found for ${search.name}.`, monitor.name, listing.name || listing.context || 'Apartment', listing.rent ? `Rent: ${listing.rent}` : '', listing.size ? `Size: ${listing.size}` : '', listing.applicationUrl || listing.pageUrl || monitor.url, application ? `Application: ${application.message}` : '', '', 'Availability may change. Review all application details on the housing website.'].filter(Boolean).join('\n');
        await sendEmailAlert(api, {id: actionId}, `SpotAlert · ${listing.name || 'Matching apartment'}`, body, {to: snapshot.details.email});
        await update('sent', `Email accepted by provider for ${snapshot.details.email}.`);
      }
    } catch (error) { await update('failed', error.message); }
  }
  return {reconcileSearchLocations, readinessFor, repeatSearchAction, matchSearches};
}
