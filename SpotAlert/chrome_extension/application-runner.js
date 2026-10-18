import {applicationStage} from "./application-state.js";
import {siteForUrl, pageConfig} from "./sites/index.js";
import {safeListingUrl, listingKey} from "./core.js";
import {validateProfile, fillApplicationForm, selectMoveInDate, startCanvasApplication} from "./profile.js";
import {applicationStep, captureApplicationStructure, prepareCanvasSignature} from "./application.js";
import {APPLICATION_BUILD} from "./application-diagnostics.js";
import {openApplication, canvasBookingLink} from "./page.js";
export function createApplicationRunner({api, now, state, mutate, find, applications, preparationControllers, applicationTabs, claimApplicationTab, waitForPage, profileLibrary, assignedProfile}) {
  async function executeInTab(tabId, func, args = [], world) {
    const results = await api.scripting.executeScript({
      target: {tabId}, func, args, ...(world ? {world} : {}),
    });
    return results[0]?.result;
  }

  async function applicationStatus(id, update) {
    await mutate(value => {
      const monitor = find(value, id);
      const {diagnostic, ...details} = update;
      const timestamp = now();
      const trace = details.trace || monitor.application?.trace || [];
      if (diagnostic) trace.push({at: timestamp, ...diagnostic});
      monitor.application = {...monitor.application, stage: applicationStage(details, monitor.application?.stage), ...details, trace: trace.slice(-80), updatedAt: timestamp};
    });
  }
  async function stopApplication(id) {
    applications.get(id)?.controller.abort();
    const tabId = find(await state(), id).application?.tabId;
    preparationControllers.get(tabId)?.abort();
    if (tabId) try {
      await api.scripting.executeScript({target: {tabId}, func: () => { document.documentElement.dataset.spotalertApplicationStopped = "true"; }});
    } catch { /* A closed or navigating tab needs no further action. */ }
  }
  async function runApplication(id, listing, signal, expectedProfileId, createAccount = false, signatureOptions = {}, snapshot = null) {
    const monitor = find(await state(), id);
    const origin = new URL(monitor.url).origin;
    const site = siteForUrl(monitor.url);
    const config = pageConfig(site);
    const applicant = snapshot || (expectedProfileId ? (await profileLibrary()).profiles.find(entry => entry.id === expectedProfileId) : await assignedProfile(monitor));
    if (!applicant) throw new Error("The selected profile was deleted. Choose a profile and use Apply again.");
    const profile = validateProfile(applicant.details);
    let tabId = null;
    let filled = 0;
    let claimed = false;
    let claimedTabId = null;
    const done = async (message, kind = "review", details = {}) => {
      await applicationStatus(id, {status: "stopped", kind, message, tabId, filled, missingFields: details.missingFields || [], structure: details.structure || null, diagnostic: {event: "stopped", kind}});
      return {tabId, moveInMessage: message, kind};
    };
    try {
      {
        const direct = safeListingUrl(listing.applicationUrl, monitor.url);
        // Dynamic onclick URLs can be partial: follow the actual floor-plan action.
        const initial = direct && !/floorplans\.aspx$/i.test(new URL(direct).pathname) && !site.application.preferFloorplanEntry ? direct : monitor.url;
        const tab = await api.tabs.create({url: "about:blank", active: true});
        tabId = tab.id;
        claimApplicationTab(tabId);
        claimed = true;
        claimedTabId = tabId;
        await waitForPage(tabId, signal, false);
        if (signal.aborted) return done("Application automation stopped. The tab stays open.", "cancelled");
        await api.tabs.update(tabId, {url: initial});
      }
      await applicationStatus(id, {status: "running", build: APPLICATION_BUILD, trace: [], applicantName: applicant.name, listingName: listing.name || listing.context || "Selected apartment", message: "Opening the selected apartment…", tabId, filled, missingFields: [], structure: null, diagnostic: {event: "started"}});
      const deadline = Date.now() + 120000;
      const dates = new Map();
      const bookingAttempts = new Map();
      const acted = new Set();
      let previousAction = null;
      let actionAt = 0;
      let lastInspection = null;
      for (let attempt = 0; attempt < 160 && Date.now() < deadline; attempt++) {
        if (signal.aborted) return done("Application automation stopped. The tab stays open.", "cancelled");
        await waitForPage(tabId, signal, false);
        const tab = await api.tabs.get(tabId);
        const url = new URL(tab.url);
        if (url.origin !== origin) return done("The website opened another origin. Continue there manually.", "navigation");
        await api.scripting.executeScript({target: {tabId}, func: () => { delete document.documentElement.dataset.spotalertApplicationStopped; }});
        try {
          const page = await executeInTab(tabId, applicationStep, [false, createAccount], "MAIN");
          if (!page) return done("Chrome could not inspect the application page.", "error");
          const inspection = `${url.pathname}:${page.step}:${page.kind}`;
          if (inspection !== lastInspection) {
            await applicationStatus(id, {diagnostic: {event: "page-inspected", path: url.pathname, step: page.step, kind: page.kind}});
            lastInspection = inspection;
          }
          if (signal.aborted) return done("Application automation stopped. The tab stays open.", "cancelled");
          if (page.kind === "loading") {
            await applicationStatus(id, {stage: "waiting-update"});
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }
          if (["verification", "account-exists"].includes(page.kind)) return done(page.message, page.kind, page);
          const path = url.pathname.toLowerCase();
          if (path.endsWith(config.paths.booking) && page.kind === 'validation') return done(page.message, page.kind, page);
          const key = path.endsWith(config.paths.booking) ? `${path}:${url.searchParams.get('UnitID')}:${url.searchParams.get('FloorPlanID')}` : page.key;
          if (previousAction === key) {
            if (["missing", "validation"].includes(page.kind)) return done(page.message, page.kind, page);
            // CAPTCHA and booking requests can take time. Retry only after 15s
            // on the same idle booking form, at most three clicks total.
            if (path.endsWith(config.paths.booking) && Date.now() - actionAt > config.booking.retryAfterMs && (bookingAttempts.get(key) || 0) < config.booking.maxAttempts) {
              bookingAttempts.set(key, (bookingAttempts.get(key) || 0) + 1);
              await applicationStatus(id, {message: "The booking page is idle and has not advanced. Retrying Start Application…", diagnostic: {event: "booking-retry", attempt: bookingAttempts.get(key)}});
              actionAt = Date.now();
              const retry = await executeInTab(tabId, startCanvasApplication, [dates.get(key), config.booking.waitMs], "MAIN");
              await applicationStatus(id, {diagnostic: {event: "booking-retry-result", started: !!retry?.started, ...(retry?.diagnostics || {})}});
              if (!retry?.started) return done(retry?.message || "Start Application could not be retried. Check the booking tab.", "date");
              actionAt = Date.now();
              continue;
            }
            if (Date.now() - actionAt > config.booking.retryAfterMs) return done("The website did not advance after the available attempts. Check the application tab for verification or an error.", "waiting");
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }
          if (previousAction?.includes(config.paths.booking) && path.endsWith(config.paths.applicant)) {
            await applicationStatus(id, {diagnostic: {event: "booking-advanced", path: url.pathname, step: page.step}});
          }
          previousAction = null;
          if (path.endsWith(config.paths.floorplans)) {
            if (acted.has(key)) return done("The website returned to the listing page. Check availability before applying again.", "navigation");
            const result = await executeInTab(tabId, openApplication, [listing]);
            if (!result?.opened) return done(result?.reason || "Could not open this floor plan.", "availability");
            acted.add(key);
            previousAction = key;
            actionAt = Date.now();
            await applicationStatus(id, {stage: "opening", message: "Opening availability for the selected floor plan…"});
          } else if (path.endsWith(config.paths.units)) {
            if (acted.has(key)) return done("The website returned to apartment selection. Review the available units.", "availability");
            const result = await executeInTab(tabId, canvasBookingLink, [listing]);
            if (!result?.opened && !result?.url) return done(result?.error || "No booking action found for this floor plan.", "availability");
            if (result.url) await api.tabs.update(tabId, {url: result.url});
            acted.add(key);
            previousAction = key;
            actionAt = Date.now();
            await applicationStatus(id, {stage: "opening", message: "Opening the apartment booking form…"});
          } else if (path.endsWith(config.paths.booking)) {
            if (!dates.has(key)) {
              const date = await executeInTab(tabId, selectMoveInDate, [profile]);
              if (!date?.moveInDate) return done(date?.moveInMessage || "Choose a move-in date on the website.", "date");
              dates.set(key, date.moveInDate);
              await applicationStatus(id, {stage: "selecting-date", message: date.moveInMessage, moveInDate: date.moveInDate, moveInMessage: date.moveInMessage, diagnostic: {event: "date-selected", date: date.moveInDate}});
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }
            // Remember the attempt before execution: successful navigation can
            // destroy the injected context before Chrome returns its result.
            previousAction = key;
            actionAt = Date.now();
            bookingAttempts.set(key, 1);
            const next = await executeInTab(tabId, startCanvasApplication, [dates.get(key), config.booking.waitMs], "MAIN");
            await applicationStatus(id, {diagnostic: {event: "booking-click-result", started: !!next?.started, ...(next?.diagnostics || {})}});
            if (!next?.started) return done(next?.message || "Check the booking page before continuing.", "date");
            bookingAttempts.set(key, 1);
            previousAction = key;
            actionAt = Date.now();
            await applicationStatus(id, {stage: "starting", message: "Starting the application…"});
          } else if (path.endsWith(config.paths.applicant)) {
            if (acted.has(key)) return done("This step has already been continued. Review the website before trying again.", "waiting");
            if (signatureOptions.enabled && config.agreementSignature && page.step === config.agreementSignature.step) {
              const details = await executeInTab(tabId, fillApplicationForm, [profile, config], "MAIN");
              filled += details?.count || 0;
              const prepared = await executeInTab(tabId, prepareCanvasSignature, [signatureOptions.screening === true, config], "MAIN");
              if (prepared?.error || !prepared?.signatureSelected || !prepared?.agreementChecked || (signatureOptions.screening && !prepared?.screeningChecked)) return done(prepared?.error || 'The website did not confirm the selected agreement and signature options.', 'signature');
              return done(prepared.message, 'signature');
            }
            if (["documents", "review", "login", "unfamiliar"].includes(page.kind)) return done(page.message, page.kind, page);
            const result = await executeInTab(tabId, fillApplicationForm, [profile, config], "MAIN");
            filled += result?.count || 0;
            await applicationStatus(id, {stage: "filling", filled, message: `Filled ${filled} fields from Applicants…`});
            // Reinspect after field changes; never advance based on stale validation.
            const next = await executeInTab(tabId, applicationStep, [true, createAccount], "MAIN");
            if (next?.kind === "loading") {
              await new Promise(resolve => setTimeout(resolve, 250));
              continue;
            }
            if (!next?.advanced) return done(next?.message || "Details filled. Review this step on the website.", next?.kind, next || {});
            acted.add(key);
            previousAction = key;
            actionAt = Date.now();
            await applicationStatus(id, {stage: "waiting-update", message: "Continuing to the next application step…"});
          } else return done("This page needs your review before continuing. Download its field structure to help add support.", "unfamiliar", {structure: await executeInTab(tabId, captureApplicationStructure, [])});
        } catch (error) {
          if (!/frame|context|document|navigation|removed/i.test(error.message)) throw error;
          await applicationStatus(id, {diagnostic: {event: "navigation-interrupted-script"}});
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      return done("The application is taking longer than expected. Review the website directly, or use Apply to start a new run.", "waiting");
    } catch (error) {
      const closed = /No tab with id|Invalid tab ID|tab.*closed/i.test(error.message);
      if (closed) tabId = null;
      return done(signal.aborted ? "Application automation stopped." : closed ? "The application tab was closed. Use Apply on the apartment to start a new run." : error.message, signal.aborted ? "cancelled" : "error");
    } finally {
      if (claimed) applicationTabs.delete(claimedTabId);
    }
  }
  async function openListing(id, listingId, expectedProfileId = null, createAccount = false, signatureOptions = {}) {
    if (applications.has(id)) {
      if (applications.get(id).searchId) throw new Error('A profile search is applying at this location. Wait for it to finish or pause that search.');
      return applications.get(id).promise;
    }
    const monitor = find(await state(), id);
    const listing = [...(monitor.alert?.listings || []), ...monitor.samples].find(sample => listingKey(sample) === listingId);
    if (!listing) throw new Error("This listing is no longer in the saved results. Run a new check.");
    const controller = new AbortController();
    const run = {controller};
    applications.set(id, run);
    run.promise = (async () => {
      await applicationStatus(id, {listingId: listingKey(listing)});
      return runApplication(id, listing, controller.signal, expectedProfileId, createAccount, signatureOptions);
    })().finally(() => applications.delete(id));
    return run.promise;
  }
  return {applicationStatus, stopApplication, runApplication, openListing};
}
