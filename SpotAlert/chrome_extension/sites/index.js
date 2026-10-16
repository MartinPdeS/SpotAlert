import diemen from './diemen.js';
import southEast from './south-east.js';
import canvasBlaak from './canvas-blaak.js';

export const SUPPORTED_SITES = [diemen, southEast, canvasBlaak];

/** Origin lookup accepts application paths; catalog validation still uses exact URLs. */
export function siteForUrl(value) {
  try {
    const origin = new URL(value).origin;
    return SUPPORTED_SITES.find(site => new URL(site.url).origin === origin) || null;
  } catch { return null; }
}

/** Custom selectors keep ordinary visibility filtering. */
export function readerForRule(rule) {
  return rule?.type === 'css' ? SUPPORTED_SITES.find(site => site.rule.selector === rule.selector)?.reader || {} : {};
}

export function pageConfig(site) {
  return site ? {origin: new URL(site.url).origin, ...site.application} : null;
}
