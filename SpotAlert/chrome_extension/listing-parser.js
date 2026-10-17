import {readPage} from './page.js';
import {siteForUrl} from './sites/index.js';

export function parseListingHtml(html, url, rule, reader = {}) {
  const site = siteForUrl(url);
  if (!site || rule?.selector !== site.rule.selector || typeof html !== 'string' || html.length > 2_000_000) return {fallback: 'Unsupported direct HTML'};
  // Detached document only: website scripts never execute and CSP blocks subresources.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const result = readPage(rule, 0, {...reader, staticSnapshot: true}, doc, url);
  if (result.error) return {fallback: result.errorKind === 'verification' ? 'Direct response requires website verification' : result.errorKind === 'login' ? 'Direct response requires sign-in' : 'Direct HTML has no readable listing controls'};
  const sections = [...doc.querySelectorAll('[data-selenium-id^="FProw_"], [id^="FP_Detail_"]')].filter(section => section.querySelector('[data-selenium-id="FloorPlanName"], [data-selenium-id^="FPlan_"], .floor-plan-name, h2, h3'));
  if (!sections.length || sections.some(section => !section.querySelector(rule.selector))) return {fallback: 'Direct HTML has incomplete floor plans'};
  const samples = new Map();
  for (const sample of result.samples) {
    if (!sample.name || !/^(?:floorplan:|listing:)/.test(sample.id) || !/^(?:get notified|check availability|apply now|not available|unavailable|available|\d+ (?:available|units? available)|join (?:the )?waitlist)[.!\s]*$/i.test(sample.text)) return {fallback: 'Direct HTML has unrecognized listing data'};
    if (samples.has(sample.id) && samples.get(sample.id).text.toLowerCase() !== sample.text.toLowerCase()) return {fallback: 'Direct HTML has conflicting listing controls'};
    samples.set(sample.id, sample);
  }
  return {result: {...result, samples: [...samples.values()]}};
}

