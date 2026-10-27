import {attentionItems, mergeActionHistory, resultStatus, errorRecovery, searchOverview, locationIssue} from "./ui.js";
import {exclusionReasons, searchClaimKey, claimActionId} from "./searches.js";
import {listingKey, safeListingUrl} from "./core.js";

export function createSearchView({$, element, guard, request, loadState, switchTab, getState, getLibrary, openProfile, openLocation, showApplyConfirmation}) {
  let detailSearchId = null;
  let attentionOpen = false;
  let quickFilter = 'all';
  const pendingActions = new Set();
  const intervalLabel = (seconds) => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`;
  const refreshOptions = [[5, '5 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [3600, '1 hour']];
  function selectSavedInterval(selector, seconds) {
    const picker = $(selector);
    picker.querySelectorAll('[data-saved-interval]').forEach(option => option.remove());
    if (![...picker.options].some(option => option.value === String(seconds))) {
      picker.append(element('option', {value: String(seconds), 'data-saved-interval': ''}, `${intervalLabel(seconds)} (saved)`));
    }
    picker.value = String(seconds);
  }
  const actionLabel = (record) => record
    ? `${record.channel === 'email' ? 'Email' : 'Application'} · ${actionOutcome(record)}`
    : 'No action yet';
  const nextCheckLabel = (search) => {
    if (!search.enabled) return 'Paused';
    const monitors = search.locationIds.map(id => getState().monitors.find(item => item.id === id)).filter(Boolean);
    if (monitors.some(monitor => ['queued', 'refreshing', 'reading', 'capturing'].includes(monitor.phase))) return 'Checking now';
    const nextCheckAt = Math.min(...monitors.map(monitor => monitor.nextCheckAt).filter(Number.isFinite));
    if (!Number.isFinite(nextCheckAt)) return 'Scheduling';
    const seconds = Math.max(0, Math.ceil((nextCheckAt - Date.now()) / 1000));
    return `Next in ${intervalLabel(seconds)}`;
  };
  const health = (monitor, status) => {
    if (monitor?.error) return {kind: 'attention', label: locationIssue(monitor.errorKind).label, title: errorRecovery(monitor.errorKind)};
    if (status.kind === 'outdated') return {kind: 'delayed', label: 'Delayed', title: 'The last result is older than the expected refresh window.'};
    if (status.kind === 'unchecked') return {kind: 'waiting', label: 'Waiting for first check', title: 'This location has not completed a successful check yet.'};
    if (status.kind === 'checking') return {kind: 'checking', label: 'Checking', title: 'SpotAlert is reading this location now.'};
    return {kind: 'healthy', label: 'Healthy', title: 'Recent availability data is available.'};
  };
  function showSearchDetails(id, section = 'search-results') {
    detailSearchId = id;
    renderSearches();
    const dialog = $('#search-detail-dialog');
    if (!dialog.open) dialog.showModal();
    const details = dialog.querySelector(`.${section}`);
    if (details) { details.open = true; details.scrollIntoView({block: 'nearest'}); }
  }
  $('#close-search-detail').addEventListener('click', () => $('#search-detail-dialog').close());
  $('#search-detail-dialog').addEventListener('close', () => {
    const previous = detailSearchId;
    detailSearchId = null;
    if (!document.querySelector('dialog[open]')) [...document.querySelectorAll('.search-card')].find(card => card.dataset.searchId === previous)?.querySelector('.view-search-results')?.focus({preventScroll: true});
  });
  $('#show-attention').addEventListener('click', () => {
    attentionOpen = !attentionOpen;
    renderAttention();
    if (attentionOpen) $('#attention-heading').scrollIntoView({block: 'nearest'});
  });
  $('#close-attention').addEventListener('click', () => {
    attentionOpen = false; renderAttention(); $('#show-attention').focus();
  });
  function renderAttention() {
    const items = attentionItems(getState(), getLibrary());
    $('#search-review-total').textContent = items.length;
    $('#show-attention').hidden = !items.length;
    if (!items.length) {
      attentionOpen = false;
      if (quickFilter === 'attention') quickFilter = 'all';
    }
    $('#show-attention').setAttribute('aria-expanded', String(attentionOpen));
    $('#attention-panel').hidden = !attentionOpen;
    const root = $('#attention-list');
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.attentionId : null;
    root.replaceChildren(...items.map(item => {
      const run = async () => {
        if (item.action === 'profile') return openProfile(item.profileId, item.field);
        if (item.action === 'location') {
          const monitor = getState().monitors.find(monitor => monitor.id === item.monitorId);
          if (['verification', 'login', 'navigation'].includes(monitor?.errorKind)) return request({type: 'open-affected', id: item.monitorId});
          if (['loading', 'network', 'timeout'].includes(monitor?.errorKind)) return request({type: 'check', id: item.monitorId});
          return openLocation(item.monitorId);
        }
        if (item.action === 'application') return request({type: 'open-application-target', tabId: item.tabId});
        if (item.action === 'edit-search') return showSearchEditor(getState().searches.find(search => search.id === item.searchId));
        return showSearchDetails(item.searchId, item.section);
      };
      return element('article', {class: 'attention-item'}, element('div', {}, element('h4', {}, item.title), element('p', {}, item.message)), element('div', {class: 'attention-actions'}, element('button', {type: 'button', class: 'secondary-button', 'data-attention-id': item.id, onclick: guard(run)}, item.label),
        item.channel === 'email' && element('button', {type: 'button', class: 'text-button', onclick: () => { switchTab('settings'); $('#email-api-key').focus(); }}, 'Email settings')));
    }));
    if (!items.length) root.append(element('p', {class: 'attention-empty'}, 'All clear. No applications or delivery issues need review.'));
    if (focused) [...root.querySelectorAll('button')].find(button => button.dataset.attentionId === focused)?.focus({preventScroll: true});
  }
  function renderSearches() {
    renderAttention();
    const root = $("#search-list");
    const searches = getState().searches || [];
    const matchEntries = search => Object.entries(search.results || {}).flatMap(([id, result]) => result.matches.filter(item => item.matched).map(listing => ({id, listing})));

    $('#search-total').textContent = searches.length;
    $('#search-active-total').textContent = searches.filter(search => search.enabled).length;
    const matchTotal = searches.reduce((total, search) => total + matchEntries(search).length, 0);
    const resultsUnconfirmed = searches.some(search => search.locationIds.some(id => resultStatus(getState().monitors.find(item => item.id === id), search.results?.[id] || null).historical));
    $('#search-match-total').textContent = resultsUnconfirmed && !matchTotal ? '—' : matchTotal;
    $('#search-match-total').parentElement.lastChild.textContent = `${resultsUnconfirmed ? ' last known' : ''}${matchTotal === 1 ? ' match' : ' matches'}`;
    const attentionSearches = new Set(attentionItems(getState(), getLibrary()).flatMap(item => {
      if (item.searchId) return [item.searchId];
      return searches.filter(search => item.action === 'profile'
        ? search.enabled && search.actions.autoApply && search.profileId === item.profileId
        : item.monitorId && search.locationIds.includes(item.monitorId)).map(search => search.id);
    }));
    document.querySelectorAll('[data-search-filter]').forEach(button => {
      button.classList.toggle('active', button.dataset.searchFilter === quickFilter);
      button.setAttribute('aria-pressed', String(button.dataset.searchFilter === quickFilter));
    });

    const filter = $('#search-profile-filter');
    const selectedProfile = filter.value;
    const profiles = getLibrary()?.profiles || [];
    if (JSON.stringify([...filter.options].map(option => [option.value, option.textContent])) !== JSON.stringify([['', 'All applicants'], ...profiles.map(profile => [profile.id, profile.name])])) {
      filter.replaceChildren(element('option', {value: ''}, 'All applicants'), ...profiles.map(profile => element('option', {value: profile.id}, profile.name)));
      filter.value = profiles.some(profile => profile.id === selectedProfile) ? selectedProfile : '';
    }
    filter.disabled = !profiles.length;
    const expanded = new Map([...root.querySelectorAll('.search-card')].map(card => [card.dataset.searchId, Object.fromEntries([...card.querySelectorAll('details[data-disclosure]')].map(item => [item.dataset.disclosure, item.open]))]));
    const detailExpanded = Object.fromEntries([...$('#search-detail-body').querySelectorAll('details[data-disclosure]')].map(item => [item.dataset.disclosure, item.open]));
    const detailFocus = $('#search-detail-body').contains(document.activeElement) ? document.activeElement.textContent : null;
    if (detailSearchId && !searches.some(search => search.id === detailSearchId)) $('#search-detail-dialog').close();
    const focusedCard = document.activeElement?.closest('.search-card')?.dataset.searchId;
    const focusedKey = document.activeElement?.dataset.focusKey;
    const focusedLabel = root.contains(document.activeElement) ? document.activeElement.textContent : null;
    root.replaceChildren();
    for (const search of searches.filter(search => {
      if (filter.value && search.profileId !== filter.value) return false;
      if (quickFilter === 'active') return search.enabled;
      if (quickFilter === 'matches') return matchEntries(search).length > 0;
      return quickFilter !== 'attention' || attentionSearches.has(search.id);
    })) {
      const detailContent = element('div', {class: 'search-detail-content'});
      const profile = profiles.find(item => item.id === search.profileId);
      const criteria = profile?.details || {};
      const matches = matchEntries(search);
      const states = search.locationIds.map(id => resultStatus(getState().monitors.find(item => item.id === id), search.results?.[id] || null));
      const uncertain = states.some(item => item.historical) || Boolean(search.error);
      const checking = states.some(item => item.kind === 'checking');
      const errors = search.locationIds.map(id => getState().monitors.find(item => item.id === id)).filter(monitor => monitor?.error);
      const button = (label, task, className = 'secondary-button') => {
        const key = `${search.id}:${label}`;
        return element('button', {class: className, ...(pendingActions.has(key) ? {disabled: '', 'aria-busy': 'true'} : {}), onclick: guard(async event => {
          if (pendingActions.has(key)) return;
          pendingActions.add(key);
          event.currentTarget.disabled = true;
          event.currentTarget.setAttribute('aria-busy', 'true');
          try { await task(); } finally { pendingActions.delete(key); await loadState(); }
        })}, pendingActions.has(key) ? 'Updating…' : label);
      };
      const apartment = ({studio: 'Studio', '1-bedroom': '1 bedroom', '2-bedroom': '2 bedrooms', '3-plus': '3+ bedrooms'})[criteria.preferredApartmentType];
      const facts = [apartment, criteria.maxRent && `Up to €${criteria.maxRent}`, criteria.minSize && `From ${criteria.minSize} m²`, criteria.moveInFrom && `Move in ${criteria.moveInFrom}`].filter(Boolean);
      const locationNames = search.locationIds.map(id => getState().monitors.find(item => item.id === id)?.name.replace('OurDomain · ', '').replace('Canvas · ', '') || id);
      const requestedInterval = search.intervalSeconds ?? 5;
      const locationIntervals = search.locationIds
        .map(id => getState().monitors.find(item => item.id === id)?.intervalSeconds)
        .filter(Number.isFinite);
      const sharedInterval = locationIntervals.length ? Math.min(...locationIntervals) : requestedInterval;
      const activeInterval = search.enabled ? sharedInterval : requestedInterval;
      const isSharedFaster = search.enabled && sharedInterval < requestedInterval;
      const latestAction = [...(search.activity || [])].sort((a, b) => (b.at || 0) - (a.at || 0))[0];
      const overview = searchOverview(search, getState().monitors);
      const card = element('article', {
        class: `search-card${search.enabled ? ' is-active' : ''}`,
        'data-search-id': search.id, 'aria-labelledby': `search-title-${search.id}`,
      },
        element('div', {class: 'search-card-heading'},
          element('div', {class: 'search-identity'}, element('h3', {id: `search-title-${search.id}`}, search.name)),
          element('span', {class: `search-status${search.enabled ? ' active' : ''}`},
            element('span', {'aria-hidden': 'true'}), search.enabled ? 'Running' : 'Paused')),
        element('p', {class: 'search-criteria-summary'}, `${profile?.name && profile.name !== search.name ? `${profile.name} · ` : ''}${facts.join(' · ') || 'Any apartment'}`),
        element('p', {class: `search-outcome ${overview.kind}`, 'data-search-outcome': search.id},
          element('strong', {}, overview.label), overview.detail && element('span', {}, overview.detail)));
      if (profile?.testProfile) card.querySelector('.search-identity').append(element('span', {class: 'test-profile-badge'}, 'Test'));
      const hasResults = Object.keys(search.results || {}).length > 0;
      const resultsLabel = uncertain ? 'View status' : matches.length ? 'View matches' : 'View results';
      const viewResults = button(resultsLabel,
        () => showSearchDetails(search.id), `${hasResults ? 'primary-button' : 'secondary-button'} view-search-results`);
      viewResults.dataset.focusKey = 'results';
      viewResults.setAttribute('aria-label', `${resultsLabel} for ${search.name}`);
      detailContent.append(element('p', {class: 'search-detail-context'}, `${profile?.name || 'Deleted profile'} · ${facts.join(' · ') || 'Any apartment'}`));
      if (search.actions.email) detailContent.append(element('p', {class: 'helper search-recipient-caption'}, `Email: ${profile?.details.email || 'Missing email'}`));
      if (search.error) detailContent.append(element('p', {class: 'form-error'}, search.error));
      const results = element('details', {class: 'search-results'}, element('summary', {}, matches.length ? `Matches (${matches.length})` : 'Location status'));
      for (const id of search.locationIds) {
        const monitor = getState().monitors.find(item => item.id === id);
        const result = search.results?.[id];
        const listings = result?.matches.filter(item => item.matched) || [];
        const status = resultStatus(monitor, result || null);
        const locationHealth = health(monitor, status);
        const locationStatus = element('div', {class: 'search-location-status'},
          element('div', {class: 'search-location-heading'},
            element('strong', {}, monitor?.name || id),
            element('button', {
              type: 'button',
              class: `location-health ${locationHealth.kind}`,
              title: locationHealth.title,
              'aria-label': `${monitor?.name || id}: ${locationHealth.label}. ${locationHealth.title}`,
              onclick: () => { $('#search-detail-dialog').close(); openLocation(id); },
            }, element('span', {'aria-hidden': 'true'}), locationHealth.label)),
          element('p', {class: `helper result-status ${status.kind}`}, status.label),
          result && element('p', {class: 'helper'}, `Last successful check: ${new Date(result.at).toLocaleString()}${status.historical ? ' · Previous results; availability unconfirmed.' : ''}`));
        if (monitor?.error) locationStatus.append(element('p', {class: 'form-error'}, monitor.error), element('p', {class: 'helper'}, errorRecovery(monitor.errorKind)), button('Review location & retry', () => { $('#search-detail-dialog').close(); openLocation(id); }, 'text-button'));
        results.append(locationStatus);
        for (const listing of listings) {
          const url = safeListingUrl(listing.applicationUrl || listing.pageUrl, monitor.url) || monitor.url;
          const details = [
            ['Bedrooms', listing.apartmentType === 'studio' ? 'Studio' : listing.beds],
            ['Size', listing.size],
            ['Bathrooms', listing.baths],
            ['Units', Number.isInteger(listing.availableCount) && listing.availableCount > 0 ? String(listing.availableCount) : null],
          ].filter(([, value]) => value);
          results.append(element('article', {class: 'search-result-apartment'},
            element('div', {class: 'sample-top'}, element('h4', {}, listing.name || listing.context || 'Apartment'), element('span', {class: 'pill'}, status.historical ? 'Previously matched' : 'Available')),
            element('p', {class: 'listing-rent'}, listing.rent || 'Rent not published'),
            element('dl', {class: 'listing-details'}, ...details.flatMap(([label, value]) => [element('dt', {}, label), element('dd', {}, value)])),
            element('p', {class: 'listing-location'}, monitor.name),
            listingClaimBadges(search, id, listing), element('div', {class: 'listing-actions'},
              element('a', {class: 'secondary-button', href: url, target: '_blank', rel: 'noopener noreferrer'}, 'View apartment ↗'),
              element('button', {type: 'button', class: 'primary-button', ...(status.historical ? {disabled: '', title: 'Run a successful check before applying from these results'} : {}), onclick: () => { $('#search-detail-dialog').close(); showApplyConfirmation(monitor, listing); }}, 'Apply ↗'))));
        }
      }
      const excluded = element('details', {class: 'search-exclusions'}, element('summary', {}, `Excluded & unavailable (${Object.values(search.results || {}).reduce((total, result) => total + result.matches.filter(item => !item.matched).length, 0)})`));
      for (const [monitorId, result] of Object.entries(search.results || {})) for (const listing of result.matches.filter(item => !item.matched)) {
        excluded.append(element('div', {class: 'search-excluded-item'}, element('strong', {}, listing.name || listing.context || 'Apartment'), element('small', {}, getState().monitors.find(item => item.id === monitorId)?.name || monitorId), element('ul', {}, ...exclusionReasons(listing).map(reason => element('li', {}, reason)))));
      }
      if (!excluded.querySelector('.search-excluded-item')) excluded.append(element('p', {class: 'helper'}, 'After a successful check, apartments that do not match will appear here with the reason.'));
      const records = searchClaimRecords(search);
      const timeline = mergeActionHistory(records, search.activity);
      const activity = element('details', {class: 'search-activity search-duplicates'}, element('summary', {}, `Activity (${timeline.length})`));
      if (!timeline.length) activity.append(element('p', {class: 'helper'}, 'Email and application outcomes will appear here.'));
      for (const record of timeline) {
        const location = getState().monitors.find(item => item.id === record.monitorId);
        const latest = search.results?.[record.monitorId];
        const matched = latest?.matches.some(listing => listing.matched && listingKey(listing) === record.listingId);
        const busy = ['queued', 'running'].includes(record.status);
        const fresh = latest && !location?.error && Date.now() - latest.at <= Math.max(60000, (location?.intervalSeconds || 300) * 3000);
        const row = element('div', {class: 'search-prior-action', 'data-action-id': record.id}, element('strong', {}, record.listingName || record.listingId), element('p', {class: 'activity-outcome'}, `${record.channel === 'email' ? 'Email' : 'Auto-apply'} · ${actionOutcome(record)}`),
          record.at && element('time', {}, new Date(record.at).toLocaleString()), record.message && record.status !== 'sent' && element('p', {class: 'helper'}, record.message));
        const rowActions = element('div', {class: 'activity-actions'});
        if (record.tabId) rowActions.append(button('Open application', () => request({type: 'open-application-target', tabId: record.tabId})));
        if (records.includes(record)) {
          const repeat = button(record.channel === 'email' ? 'Send again' : 'Try again', () => showRepeatSearch(search, record), 'text-button');
          repeat.setAttribute('aria-label', record.channel === 'email' ? 'Authorize another email' : 'Authorize another application');
          repeat.disabled = !search.enabled || !search.actions[record.channel] || !matched || !fresh || busy;
          repeat.title = busy ? 'Already in progress' : !search.enabled ? 'Start this search to repeat an attempt' : !matched || !fresh ? 'A fresh matching result is needed' : 'Review the previous outcome before repeating';
          rowActions.append(repeat);
        }
        row.append(rowActions);
        if (record.previousAttempts?.length) row.append(element('details', {class: 'search-earlier-attempts'}, element('summary', {}, `Earlier attempts (${record.previousAttempts.length})`), ...record.previousAttempts.map(attempt => element('p', {class: 'helper'}, `${actionOutcome(attempt)} · ${attempt.message}`))));
        activity.append(row);
      }
      const intervalChoices = refreshOptions.some(([seconds]) => seconds === requestedInterval)
        ? refreshOptions : [...refreshOptions, [requestedInterval, `${intervalLabel(requestedInterval)} (saved)`]];
      const refresh = element('select', {
        class: 'search-refresh-select',
        'aria-label': `Refresh interval for ${search.name}`,
        title: 'Change this search’s refresh interval',
      }, ...intervalChoices.map(([seconds, label]) => element('option', {value: String(seconds), ...(seconds === requestedInterval ? {selected: ''} : {})}, label)));
      refresh.addEventListener('change', guard(async () => {
        refresh.disabled = true;
        try {
          await request({type: 'set-search-interval', id: search.id, intervalSeconds: refresh.value});
        } finally {
          refresh.disabled = false;
          await loadState();
        }
      }));
      const actions = element('div', {class: 'search-card-actions'},
        button(search.enabled ? 'Pause' : 'Start search',
          () => search.enabled ? request({type: 'set-search-enabled', id: search.id, enabled: false}) : showStartSearch(search),
          !hasResults && !search.enabled ? 'primary-button' : 'secondary-button'));
      actions.firstElementChild.dataset.focusKey = 'toggle';
      const more = element('details', {class: 'search-more'}, element('summary', {'data-focus-key': 'more', 'aria-label': `More actions for ${search.name}`}, '•••'));
      more.append(element('div', {class: 'search-menu'},
        button('Check now', () => { more.open = false; return request({type: 'check-all', ids: search.locationIds}); }, 'text-button'),
        button('Edit search', () => { more.open = false; showSearchEditor(search); }, 'text-button'),
        button('Delete search', async () => { await request({type: 'delete-search', id: search.id}); $('#new-search').focus(); }, 'search-delete')));
      actions.append(more);
      const settings = element('details', {class: 'search-check-details'}, element('summary', {}, 'Search settings & checks'),
        element('p', {class: 'helper'}, locationNames.join(' · ')),
        element('p', {class: 'helper'}, `${search.actions.email ? 'Email on' : 'Email off'} · ${search.actions.autoApply ? 'Application assistance on' : 'Application assistance off'}`),
        element('label', {}, 'Check every', refresh),
        element('p', {class: 'helper'}, `Effective interval: ${intervalLabel(activeInterval)}${isSharedFaster ? ' · shared with a faster search' : ''}`),
        search.enabled && element('p', {class: 'helper', 'data-search-next': search.id}, nextCheckLabel(search)),
        element('p', {class: 'helper'}, actionLabel(latestAction)));
      detailContent.append(results, excluded, activity, settings);
      card.append(element('div', {class: 'search-card-bottom'}, viewResults, actions));
      if (detailSearchId === search.id) {
        $('#search-detail-title').textContent = search.name;
        $('#search-detail-body').replaceChildren(detailContent);
      }
      [results, excluded, activity, settings, more].forEach(details => { details.dataset.disclosure = details.className; details.open = (detailSearchId === search.id ? detailExpanded[details.className] : expanded.get(search.id)?.[details.className]) || false; });
      root.append(card);
      if (focusedCard === search.id) {
        const previous = focusedKey ? card.querySelector(`[data-focus-key="${focusedKey}"]`) : [...card.querySelectorAll('button, summary')].find(item => item.textContent === focusedLabel);
        previous?.focus({preventScroll: true});
      }
    }
    if (detailFocus) [...$('#search-detail-body').querySelectorAll('button, summary, a')].find(item => item.textContent === detailFocus)?.focus({preventScroll: true});
    if (!root.childNodes.length) {
      const empty = element('div', {class: 'search-empty'}, element('h3', {}, searches.length ? 'No searches match these filters' : 'Create your first search'), element('p', {}, searches.length ? 'Try another applicant or filter.' : 'Choose an applicant and locations to find matching apartments.'));
      root.append(empty);
    }
  }
  $('#search-profile-filter').addEventListener('change', renderSearches);
  document.querySelectorAll('[data-search-filter]').forEach(button => button.addEventListener('click', () => {
    quickFilter = button.dataset.searchFilter;
    renderSearches();
  }));
  setInterval(() => {
    for (const root of document.querySelectorAll('[data-search-next]')) {
      const search = getState().searches.find(item => item.id === root.dataset.searchNext);
      if (search) root.textContent = nextCheckLabel(search);
    }
    for (const root of document.querySelectorAll('[data-search-outcome]')) {
      const search = getState().searches.find(search => search.id === root.dataset.searchOutcome);
      if (!search) continue;
      const overview = searchOverview(search, getState().monitors);
      root.className = `search-outcome ${overview.kind}`;
      root.querySelector('strong').textContent = overview.label;
      const detail = root.querySelector('span');
      if (detail) detail.textContent = overview.detail;
    }
  }, 1000);
  function searchProfilePreferences() {
    const profile = getLibrary().profiles.find(item => item.id === $('#search-profile').value);
    $('#search-recipient').textContent = profile?.details.email ? `Emails go to ${profile.details.email}.` : 'Save an email address in this profile to receive matches.';
    return profile?.details || {};
  }
  function showProfileSearchCriteria(details) {
    $('#search-profile-preferences').replaceChildren(...[
      ['Monthly budget', details.maxRent ? `Up to €${details.maxRent}` : 'Any budget'],
      ['Minimum size', details.minSize ? `${details.minSize} m²` : 'Any size'],
      ['Apartment', ({studio:'Studio', '1-bedroom':'1 bedroom', '2-bedroom':'2 bedrooms', '3-plus':'3+ bedrooms'})[details.preferredApartmentType] || 'Any type'],
      ['Earliest move-in', details.moveInFrom || 'First available date'],
    ].map(([label, text]) => element('div', {}, element('dt', {}, label), element('dd', {}, text))));
  }
  let editorSearchId = null;
  function showSearchEditor(search = null) {
    editorSearchId = search?.id || null;
    $('#search-form').reset();
    $('#search-editor-title').textContent = search ? 'Edit search' : 'Create a search';
    $('#search-id').value = search?.id || '';
    $('#search-profile').replaceChildren(...getLibrary().profiles.map(profile => element('option', {value: profile.id}, profile.name)));
    $('#search-profile').value = search?.profileId || $('#search-profile-filter').value || getLibrary().activeId;
    const defaults = searchProfilePreferences();
    showProfileSearchCriteria(defaults);
    $('#search-locations').replaceChildren(...getState().monitors.map(monitor => element('label', {class: 'checkbox-label'}, element('input', {type: 'checkbox', name: 'search-location', value: monitor.id, ...(search?.locationIds.includes(monitor.id) ? {checked: ''} : {})}), monitor.name)));
    $('#search-email').checked = search?.actions.email ?? true;
    $('#search-auto-apply').checked = search?.actions.autoApply ?? false;
    $('#search-create-account').checked = search?.createAccount ?? false;
    selectSavedInterval('#search-edit-interval', search?.intervalSeconds ?? 5);
    $('#search-account-options').hidden = !$('#search-auto-apply').checked;
    $('#search-error').hidden = true;
    $('#search-editor').showModal();
    $('#search-profile').focus();
  }
  $('#search-auto-apply').addEventListener('change', () => { $('#search-account-options').hidden = !$('#search-auto-apply').checked; });
  $('#new-search').addEventListener('click', () => showSearchEditor());
  $('#search-profile').addEventListener('change', () => showProfileSearchCriteria(searchProfilePreferences()));
  $('#cancel-search').addEventListener('click', () => $('#search-editor').close());
  $('#search-editor').addEventListener('close', () => {
    if (document.querySelector('dialog[open]')) return;
    const trigger = editorSearchId ? [...document.querySelectorAll('.search-card')].find(card => card.dataset.searchId === editorSearchId)?.querySelector('.search-more > summary') : $('#new-search');
    trigger?.focus({preventScroll: true});
  });
  $('#search-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      await request({type: 'save-search', search: {
        intervalSeconds: Number($('#search-edit-interval').value),
        id: $('#search-id').value || undefined, profileId: $('#search-profile').value,
        locationIds: [...document.querySelectorAll('input[name="search-location"]:checked')].map(item => item.value),
        actions: {email: $('#search-email').checked, autoApply: $('#search-auto-apply').checked}, createAccount: $('#search-auto-apply').checked && $('#search-create-account').checked,
      }});
      $('#search-editor').close();
      await loadState();
      switchTab('searches');
    } catch (error) { $('#search-error').textContent = error.message; $('#search-error').hidden = false; $('#search-error').scrollIntoView({block: 'center'}); }
    finally { if (submit) submit.disabled = false; }
  });

  function actionOutcome(record) {
    return ({sent: 'Email accepted', review: 'Application needs review', failed: record.channel === 'email' ? 'Email failed' : 'Application failed', interrupted: 'Interrupted · review outcome', running: 'In progress', queued: 'Queued', cancelled: 'Cancelled', recorded: 'Previous attempt recorded'})[record.status] || 'Previous attempt recorded';
  }
  function searchClaimRecords(search) {
    return Object.entries(getState().searchClaims || {}).flatMap(([key, claim]) => {
      let parts;
      try { parts = JSON.parse(key); } catch { return []; }
      if (!Array.isArray(parts) || parts[0] !== search.profileId || !search.locationIds.includes(parts[1])) return [];
      return [{...(typeof claim === 'string' ? {id: claim, status: 'recorded'} : claim), monitorId: parts[1], listingId: parts[2], channel: parts[3]}];
    }).sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  function listingClaimBadges(search, monitorId, listing) {
    return element('span', {class: 'listing-claim-badges'}, ...['autoApply', 'email'].flatMap(channel => {
      const claim = getState().searchClaims?.[searchClaimKey(search.profileId, monitorId, listingKey(listing), channel)];
      return claim ? [element('span', {}, `${channel === 'email' ? 'Email' : 'Auto-apply'}: ${actionOutcome(claim)}`)] : [];
    }));
  }
  let startSearchSelection = null;
  let readinessRequest = 0;
  function startSearchActions() {
    return {autoApply: $('#start-auto-apply').checked, email: $('#start-email').checked, sms: $('#start-sms').checked};
  }
  async function showStartSearch(search) {
    startSearchSelection = {id: search.id, generation: search.generation};
    const profile = getLibrary().profiles.find(profile => profile.id === search.profileId);
    $('#start-search-title').textContent = `Start search for ${profile?.name || 'this profile'}`;
    $('#start-search-description').textContent = `${search.name} · ${profile?.details.email || 'No profile email saved'}`;
    $('#start-auto-apply').checked = search.actions.autoApply;
    $('#start-email').checked = search.actions.email;
    $('#start-sms').checked = false;
    $('#start-create-account').checked = search.createAccount;
    selectSavedInterval('#start-search-interval', search.intervalSeconds ?? 5);
    $('#start-search-error').hidden = true;
    $('#start-search-options').open = false;
    $('#start-search-dialog').showModal();
    await updateStartReadiness();
  }
  async function updateStartReadiness() {
    if (!startSearchSelection || !$('#start-search-dialog').open) return;
    const version = ++readinessRequest;
    $('#start-search-summary').textContent = [
      $('#start-email').checked ? 'Email on' : 'Email off',
      $('#start-auto-apply').checked ? 'Application assistance on' : 'Application assistance off',
      $('#start-auto-apply').checked && $('#start-create-account').checked ? 'Account creation on · account terms accepted' : '',
      `Every ${intervalLabel(Number($('#start-search-interval').value))}`,
    ].filter(Boolean).join(' · ');
    $('#start-account-options').hidden = !$('#start-auto-apply').checked;
    const confirm = $('#confirm-start-search');
    confirm.disabled = true;
    confirm.textContent = 'Checking…';
    const root = $('#start-search-readiness');
    try {
      const report = await request({type: 'search-readiness', id: startSearchSelection.id, actions: startSearchActions(), createAccount: $('#start-auto-apply').checked && $('#start-create-account').checked});
      if (version !== readinessRequest || !$('#start-search-dialog').open) return;
      root.replaceChildren(element('h3', {}, report.canStart ? report.ready ? 'Ready to start' : 'Can start · website input expected' : 'Complete these checks first'));
      if (report.blockers.length) root.append(element('ul', {class: 'readiness-blockers'}, ...report.blockers.map(text => element('li', {}, text))));
      for (const location of report.locations) {
        const details = element('details', {}, element('summary', {}, `${location.name} · ${location.ready ? 'Known details complete' : `${location.missing.length + location.missingRequired.length} details to review`}`));
        if (location.missingRequired?.length) details.append(element('p', {}, `Needed before starting: ${location.missingRequired.join(', ')}.`));
        if (location.missing?.length) details.append(element('p', {}, `Website input expected: ${location.missing.join(', ')}.`));
        details.append(element('p', {class: 'helper'}, location.note));

        root.append(details);
      }
      for (const text of report.warnings) root.append(element('p', {class: 'readiness-warning'}, text));
      root.append(element('button', {type: 'button', class: 'text-button', onclick: guard(async () => {
        const search = getState().searches.find(search => search.id === startSearchSelection.id);
        if (!search) throw new Error('This search no longer exists.');
        await openProfile(search.profileId, 'firstName');
        $('#start-search-dialog').close();
      })}, 'Review applicant details →'));
      confirm.disabled = !report.canStart;
      confirm.textContent = report.canStart && !report.ready ? 'Start search — review needed' : 'Start search';
    } catch (error) {
      if (version !== readinessRequest) return;
      root.replaceChildren(element('p', {class: 'form-error'}, error.message));
      confirm.textContent = 'Start search';
    }
  }
  for (const id of ['start-auto-apply', 'start-email', 'start-sms', 'start-create-account', 'start-search-interval']) $(`#${id}`).addEventListener('change', updateStartReadiness);
  $('#cancel-start-search').addEventListener('click', () => $('#start-search-dialog').close());
  $('#start-search-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#confirm-start-search').disabled = true;
    try {
      await request({type: 'set-search-enabled', id: startSearchSelection.id, expectedGeneration: startSearchSelection.generation, enabled: true, actions: startSearchActions(), createAccount: $('#start-auto-apply').checked && $('#start-create-account').checked, intervalSeconds: $('#start-search-interval').value});
      $('#start-search-dialog').close();
      await loadState();
    } catch (error) {
      $('#start-search-error').textContent = error.message;
      $('#start-search-error').hidden = false;
      $('#start-search-error').scrollIntoView({block: 'center'});
      await updateStartReadiness();
    }
  });
  let repeatSearchSelection = null;
  function showRepeatSearch(search, record) {
    repeatSearchSelection = {id: search.id, monitorId: record.monitorId, listingId: record.listingId, channel: record.channel, expectedClaimId: claimActionId(record)};
    $('#repeat-search-form').reset();
    $('#repeat-search-title').textContent = record.channel === 'email' ? 'Authorize another email' : 'Authorize another application';
    $('#repeat-search-details').replaceChildren(...[
      ['Profile', getLibrary().profiles.find(profile => profile.id === search.profileId)?.name || 'Deleted profile'],
      ['Apartment', record.listingName || record.listingId],
      ['Previous outcome', actionOutcome(record)],
      ['Recorded', record.at ? new Date(record.at).toLocaleString() : 'Date unavailable'],
      ['Details', record.message || 'Previous attempt recorded.'],
    ].map(([label, text]) => element('div', {}, element('dt', {}, label), element('dd', {}, text))));
    $('#repeat-search-warning').textContent = record.channel === 'email' ? 'The profile holder may already have received this apartment. This authorizes one additional email.' : 'An application or reservation may already exist. Inspect the previous tab first. This authorizes one additional application attempt.';
    $('#repeat-search-error').hidden = true;
    $('#repeat-search-dialog').showModal();
  }
  $('#cancel-repeat-search').addEventListener('click', () => $('#repeat-search-dialog').close());
  $('#repeat-search-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = $('#confirm-repeat-search');
    submit.disabled = true;
    try {
      await request({type: 'repeat-search-action', ...repeatSearchSelection, confirmed: $('#repeat-search-consent').checked});
      $('#repeat-search-dialog').close();
      await loadState();
    } catch (error) { $('#repeat-search-error').textContent = error.message; $('#repeat-search-error').hidden = false; }
    finally { submit.disabled = false; }
  });

  return {renderSearches};
}
