import {SUPPORTED_SITES} from "./core.js";
import {PROFILE_SECTIONS, validateProfile} from "./profile.js";
import {applicationReadiness} from "./ui.js";

/** @returns {import("./contracts.js").SearchConfig} */
export function validateSearch(input, profiles) {
  const profile = profiles.find(item => item.id === input.profileId);
  if (!profile) throw new Error("Choose a saved profile.");
  const locationIds = [...new Set(input.locationIds || [])];
  if (!locationIds.length || locationIds.some(id => !SUPPORTED_SITES.some(site => site.id === id))) throw new Error("Choose at least one supported location.");
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error("Enter a search name of up to 80 characters.");
  const intervalSeconds = Number(input.intervalSeconds ?? 5);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 86400) {
    throw new Error("Choose a refresh interval between 5 seconds and 24 hours.");
  }
  const actions = {email: input.actions?.email === true, autoApply: input.actions?.autoApply === true, sms: input.actions?.sms === true};
  if (actions.sms) throw new Error("SMS is unavailable: no SMS provider is configured. Choose email or auto-apply.");
  if (!actions.email && !actions.autoApply) throw new Error("Choose email, auto-apply, or both.");
  if (actions.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.details.email || '')) throw new Error("Save a valid email address in this profile first.");
  validateProfile(profile.details);
  if (actions.autoApply && !applicationReadiness(profile.details).ready) throw new Error("Complete this profile’s required contact details before enabling auto-apply.");
  return {name, profileId: profile.id, locationIds, intervalSeconds, actions, createAccount: input.createAccount === true};
}

export const searchClaimKey = (profileId, monitorId, listingId, channel) => JSON.stringify([profileId, monitorId, listingId, channel]);
export const claimActionId = claim => typeof claim === 'string' ? claim : claim?.id;

/** Preflight checks do not imply a live login or verified email sender. */
export function searchReadiness(search, profiles, email = {}) {
  const entry = profiles.find(profile => profile.id === search.profileId);
  const details = entry?.details || {};
  const blockers = [];
  const warnings = [];
  const actions = search.actions || {};
  const labels = Object.fromEntries(PROFILE_SECTIONS.flatMap(section => section.fields.map(([key, label]) => [key, label])));
  const present = key => {
    const text = String(details[key] ?? '').trim();
    if (!text) return false;
    if (key === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    if (key === 'phone') return /^[+()\d.\s-]+$/.test(text) && text.replace(/\D/g, '').length >= 7 && text.replace(/\D/g, '').length <= 15;
    return true;
  };
  if (!entry) blockers.push('The applicant profile no longer exists.');
  if (!actions.autoApply && !actions.email && !actions.sms) blockers.push('Turn on at least one action.');
  if (actions.sms) blockers.push('SMS is unavailable because no SMS provider is configured.');
  if (actions.email) {
    if (!present('email')) blockers.push('Save a valid email address in the applicant profile.');
    if (!email.apiKey?.trim()) blockers.push('Configure a Resend API key in Settings → Email delivery.');
    if (email.sender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.sender)) blockers.push('Configure a valid sender email in Settings → Email delivery.');
    if (!email.sender || email.sender === 'onboarding@resend.dev') warnings.push('The Resend test sender only delivers to its account owner. Use a verified sender for other profile holders.');
  }
  if (actions.autoApply && search.createAccount && !present('registrationPassword')) blockers.push('Save an account password in the profile, or turn off account creation.');
  const locations = (search.locationIds || []).map(id => {
    const site = SUPPORTED_SITES.find(site => site.id === id);
    if (!site) { blockers.push('A selected location is no longer supported.'); return {id, name: id, missing: [], ready: false}; }
    const config = site.application.readiness;
    const required = actions.autoApply ? (config?.requiredFields || ['firstName', 'lastName', 'email', 'phone']) : [];
    const missingRequired = required.filter(key => !present(key)).map(key => labels[key] || key);
    if (missingRequired.length) blockers.push(`${site.name}: complete ${missingRequired.join(', ')}.`);
    const review = actions.autoApply ? [...(config?.reviewFields || [])] : [];
    if (actions.autoApply && config?.middleNameChoice && details.noMiddleName !== 'Yes') review.push('middleName');
    const missing = review.filter(key => !present(key)).map(key => labels[key] || key);
    return {id, name: site.name, ready: !missingRequired.length && !missing.length, missingRequired, missing, note: actions.autoApply ? config?.note || 'Website requirements need review.' : 'Ready to monitor this location.'};
  });
  if (!locations.length) blockers.push('Choose at least one location.');
  return {canStart: !blockers.length, ready: !blockers.length && locations.every(location => location.ready), blockers: [...new Set(blockers)], warnings, locations};
}

export function exclusionReasons(listing) {
  if (!listing.ruleMatched && !listing.matched) return ['Not currently available'];
  return listing.preferenceReasons?.length ? listing.preferenceReasons : listing.included === false ? ['Excluded by search preferences'] : [];
}
