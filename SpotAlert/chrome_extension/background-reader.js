import {siteForUrl, readerForRule} from './sites/index.js';
import {samePage} from './core.js';

const MAX_BYTES = 2_000_000;
export const BACKGROUND_RETRY_MS = 5 * 60_000;
let creating;

function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Background read interrupted'));
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function parserDocument(api) {
  const documentUrl = api.runtime.getURL('parser.html');
  const contexts = await api.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
  if (contexts.some(context => context.documentUrl === documentUrl)) return;
  if (contexts.length) throw new Error('Another offscreen document is in use');
  if (!creating) creating = api.offscreen.createDocument({url: 'parser.html', reasons: ['DOM_PARSER'], justification: 'Parse fetched listing HTML without opening a website tab or running website scripts.'}).finally(() => { creating = null; });
  await creating;
}

export async function readBackground(api, monitor, signal, fetcher = globalThis.fetch) {
  const site = siteForUrl(monitor.url);
  if (!api.offscreen?.createDocument || !api.runtime?.getContexts) return {fallback: 'Background reader unavailable'};
  if (!site || monitor.rule.type !== 'css' || monitor.rule.selector !== site.rule.selector) return {fallback: 'Custom availability rule needs a browser'};
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 5000);
  try {
    if (controller.signal.aborted) throw new Error('Check cancelled');
    const response = await fetcher(monitor.url, {credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: {Accept: 'text/html'}});
    if (!response.ok) return {fallback: `Direct request returned HTTP ${response.status}`};
    if (!samePage(response.url, monitor.url)) return {fallback: 'Direct response changed page'};
    if (!/text\/html/i.test(response.headers.get('content-type') || '')) return {fallback: 'Direct response is not HTML'};
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return {fallback: 'Direct response exceeds the size limit'};
    const stream = response.body?.getReader();
    if (!stream) return {fallback: 'Direct response has no body'};
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const {done, value} = await stream.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) return {fallback: 'Direct response exceeds the size limit'};
        chunks.push(value);
      }
    } finally { await stream.cancel().catch(() => {}); }
    const decoder = new TextDecoder();
    const html = chunks.map(chunk => decoder.decode(chunk, {stream: true})).join('') + decoder.decode();
    if (controller.signal.aborted) throw new Error('Check cancelled');
    await untilAborted(parserDocument(api), controller.signal);
    if (controller.signal.aborted) throw new Error('Check cancelled');
    const responseData = await untilAborted(api.runtime.sendMessage({target: 'listing-parser', type: 'parse-listings', html, url: monitor.url, rule: monitor.rule, reader: readerForRule(monitor.rule)}), controller.signal);
    if (controller.signal.aborted) throw new Error('Check cancelled');
    if (!responseData?.result?.samples?.length) return {fallback: responseData?.fallback || 'Direct HTML has no complete listing data'};
    const result = responseData.result;
    const previousIds = new Set((monitor.knownFloorplans || []).map(item => item.id));
    const ids = new Set(result.samples.map(item => item.id));
    if ([...previousIds].some(id => !ids.has(id))) return {fallback: 'Direct HTML omits previously observed floor plans'};
    return {result};
  } catch {
    if (signal.aborted) throw new Error('Check cancelled');
    return {fallback: controller.signal.aborted ? 'Direct request timed out' : 'Direct request or parser unavailable'};
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}
