import {PROFILE_SECTIONS, validateProfile} from './profile.js';
import {SUPPORTED_SITES} from './sites/index.js';
// Include an optional existing account password; omit identification and banking data.
export const CLIENT_FIELDS = PROFILE_SECTIONS.filter(section => section.title !== 'Optional identification & bank details').flatMap(section => section.fields);
export function clientQuestionnaire(name = '') {
  return `Hi${name.trim() ? ` ${name.trim()}` : ''},\n\nPlease complete the details below so I can prepare your apartment application profile. Keep each label unchanged and put your answer after the colon on the same line. Leave anything that does not apply blank. Dates use YYYY-MM-DD; monthly amounts are in euros before taxes.\n\nIf you already have an account on the rental website, you may include its password in the Password field. Otherwise leave it blank. Do not send identity documents or bank details by email.\n\n--- SPOTALERT DETAILS ---\n${CLIENT_FIELDS.map(([, label]) => `${label}: `).join('\n')}\n${SUPPORTED_SITES.map(site => `Location - ${site.name}: `).join('\n')}\n--- END DETAILS ---\n\nFor location fields, answer Yes or No for each location.\n\nFor choice fields, use:\n${CLIENT_FIELDS.filter(([, , type]) => Array.isArray(type)).map(([, label, choices]) => `${label}: ${choices.join(' / ')}`).join('\n')}\n\nReply to this email with the completed details. I will review them before using them for an application. Thank you!`;
}
export function parseClientAnswers(text) {
  if (typeof text !== 'string' || text.length > 30000) throw new Error('Paste a reply of up to 30,000 characters.');
  const start = text.indexOf('--- SPOTALERT DETAILS ---');
  const end = text.indexOf('--- END DETAILS ---', start);
  if (start < 0 || end < start) throw new Error('Include the completed SPOTALERT DETAILS block, including both marker lines.');
  const fields = new Map(CLIENT_FIELDS.map(([key, label]) => [label.toLowerCase(), key]));
  const locations = new Map(SUPPORTED_SITES.map(site => [`location - ${site.name}`.toLowerCase(), site.id]));
  const profile = {}, locationIds = [], seen = new Set();
  for (const raw of text.slice(start + '--- SPOTALERT DETAILS ---'.length, end).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    const label = line.slice(0, colon).trim().toLowerCase();
    if (colon < 0 || (!fields.has(label) && !locations.has(label))) throw new Error('Unrecognized reply line. Keep the questionnaire labels unchanged and use one line per answer.');
    const key = fields.get(label) || locations.get(label);
    if (seen.has(key)) throw new Error('A field appears more than once. Paste only one completed details block.');
    seen.add(key);
    const answer = line.slice(colon + 1);
    if (locations.has(label)) {
      const choice = answer.trim().toLowerCase();
      if (choice && !['yes', 'no'].includes(choice)) throw new Error('Answer Yes or No for each location.');
      if (choice === 'yes') locationIds.push(key);
      continue;
    }
    profile[key] = key === 'registrationPassword' ? answer.replace(/^ /, '') : answer.trim();
  }
  if (!Object.values(profile).some(Boolean) && !locationIds.length) throw new Error('The reply contains no completed details.');
  return {profile: validateProfile(profile), locationIds};
}

export function parseClientReply(text) {
  return parseClientAnswers(text).profile;
}
