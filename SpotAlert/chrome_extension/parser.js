import {parseListingHtml} from './listing-parser.js';

if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js') || message?.target !== 'listing-parser' || message.type !== 'parse-listings') return false;
  try { respond(parseListingHtml(message.html, message.url, message.rule, message.reader)); }
  catch { respond({fallback: 'Direct HTML could not be parsed'}); }
  return false;
});
