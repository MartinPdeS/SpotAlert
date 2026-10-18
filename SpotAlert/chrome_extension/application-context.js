import {SUPPORTED_SITES, sitePattern} from './core.js';
import {siteForUrl} from './sites/index.js';

/** Share tab locks between manual preparation and the application runner. */
export function createApplicationContext({api, state, applicationTabs, preparationControllers}) {
  function claimApplicationTab(tabId) {
    if (applicationTabs.has(tabId)) {
      throw new Error('An application action is already running in this tab. Wait for it to finish or stop it first.');
    }
    applicationTabs.add(tabId);
  }

  async function withApplicationTab(tabId, task) {
    claimApplicationTab(tabId);
    const controller = new AbortController();
    preparationControllers.set(tabId, controller);
    try {
      return await task(controller.signal);
    } catch (error) {
      error.tabId = tabId;
      throw error;
    } finally {
      applicationTabs.delete(tabId);
      preparationControllers.delete(tabId);
    }
  }

  async function currentApplicationTab(monitorId, requireSignature = false) {
    const isApplicant = tab => {
      try {
        const url = new URL(tab?.url);
        const site = siteForUrl(url.href);
        if (!site) return false;
        const path = url.pathname.toLowerCase();
        const applicant = path.endsWith('/' + site.application.paths.applicant);
        if (requireSignature) {
          const signature = site.application.agreementSignature;
          return applicant && !!signature
            && url.searchParams.get('stepname')?.toLowerCase() === signature.step;
        }
        return applicant || path.endsWith('/' + site.application.paths.booking);
      } catch {
        return false;
      }
    };
    const [active] = await api.tabs.query({active: true, currentWindow: true});
    let tab = isApplicant(active) ? active : null;
    const monitor = (await state()).monitors.find(item => item.id === monitorId);
    if (!tab && monitor?.application?.tabId) {
      try {
        tab = await api.tabs.get(monitor.application.tabId);
      } catch { /* Closed application: use another open page below. */ }
    }
    if (!tab) {
      const patterns = SUPPORTED_SITES
        .filter(site => !requireSignature || site.application.agreementSignature)
        .map(site => sitePattern(site.url));
      const candidates = (await api.tabs.query({currentWindow: true, url: patterns}))
        .filter(isApplicant);
      candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      const ambiguous = candidates.length > 1
        && (!candidates[0].lastAccessed || candidates[0].lastAccessed === candidates[1].lastAccessed);
      if (ambiguous) {
        throw new Error('Open the application you want to use, then return to SpotAlert and retry.');
      }
      tab = candidates[0];
    }
    if (!tab) {
      throw new Error(requireSignature
        ? 'Open your Canvas applicant information page, then return to SpotAlert and retry.'
        : 'Open a supported housing application form, then return to SpotAlert and retry.');
    }
    return tab;
  }

  return {claimApplicationTab, withApplicationTab, currentApplicationTab};
}
