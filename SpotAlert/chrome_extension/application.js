/** Inspect RentCafe application steps. Runs in MAIN; returns labels, never values. */
export function applicationStep(advance = false) {
  function captureApplicationStructure() {
    const visible = element => !!element.getClientRects().length;
    const label = field => ([...(field.labels || [])].map(item => item.textContent).join(' ') || field.getAttribute('aria-label') || field.closest('.control-group')?.querySelector('.control-label')?.textContent || field.id || field.name || 'Unnamed field').replace(/\s+/g, ' ').trim().slice(0, 90);
    const url = new URL(location.href);
    return {version: 1, page: url.origin + url.pathname, step: url.searchParams.get('stepname') || '', fields: [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(visible).slice(0, 200).map(field => ({id: field.id, name: field.name, label: label(field), type: field.type || field.tagName.toLowerCase(), required: !!(field.required || field.classList.contains('required') || field.getAttribute('aria-required') === 'true'), disabled: !!field.disabled, readOnly: !!field.readOnly})), actions: [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].filter(visible).slice(0, 30).map(button => ({id: button.id, label: (button.innerText || button.value || button.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)}))};
  }
  const visible = element => !!element.getClientRects().length;
  const text = element => (element?.innerText || element?.value || element?.textContent || '').replace(/\s+/g, ' ').trim();
  const step = (new URL(location.href).searchParams.get('stepname') || '').toLowerCase();
  const fields = [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(visible);
  const key = `${location.pathname}:${step}:${fields.map(field => field.id || field.name).join('|')}`;
  const stop = (kind, message) => ({key, step, kind, message});
  if (document.documentElement.dataset.spotalertApplicationStopped === 'true') return stop('cancelled', 'Application automation stopped.');
  if (globalThis.jQuery?.active > 0 || document.readyState !== 'complete') return stop('loading', 'Waiting for the website to finish updating.');
  const body = document.body.innerText || '';
  if (/just a moment|verify you are human|performing security verification/i.test(body)
      || [...document.querySelectorAll('#TermsRentableRecaptchaWrap, .g-recaptcha')].some(element => visible(element) && element.querySelector('iframe'))) return stop('verification', 'Complete the verification prompt in the application tab, then continue.');
  if (fields.some(field => field.type === 'file')) return stop('documents', 'Upload the requested documents in the application tab, then continue.');
  if (/charges|payment|summary|leasecreation|signature|checkout|submit/i.test(step)) return stop('review', 'Review this step yourself: it involves charges, lease details, signing, or submission.');
  if (step === 'registration') return stop('registration', 'Registration details filled. Review them, then create your account or log in on the website.');
  if (/login|signin/i.test(step) || fields.some(field => field.type === 'password')) return stop('login', 'Log in on the website, then continue.');
  if (!['intapplicantinfo', 'applicantinfo', 'additionalapplicants', 'intadditionalapplicants'].includes(step)) return {...stop('unfamiliar', 'This form is unfamiliar. Open the application tab to review it; download its field structure to help add support.'), structure: captureApplicationStructure()};
  const agreements = fields.filter(field => field.type === 'checkbox' && /agreement|agree|consent|terms|credit|privacy/i.test([field.id, field.name, ...(field.labels || [])].map(item => typeof item === 'string' ? item : item.textContent).join(' ')));
  const missing = [];
  const missingFields = [];
  const label = field => ([...(field.labels || [])].map(label => label.textContent).join(' ') || field.getAttribute('aria-label') || field.closest('.control-group')?.querySelector('.control-label')?.textContent || field.id || field.name || 'Required field').replace(/\s+/g, ' ').trim().slice(0, 90);
  for (const field of fields.filter(field => !field.disabled && (field.required || field.classList.contains('required') || field.getAttribute('aria-required') === 'true'))) {
    let empty;
    if (field.type === 'radio') empty = !fields.some(other => other.type === 'radio' && other.name === field.name && other.checked);
    else if (field.type === 'checkbox') empty = !field.checked;
    else empty = !field.value?.trim() || (field.tagName === 'SELECT' && /please (?:choose|select)|select (?:one|an option)/i.test(field.selectedOptions[0]?.textContent || ''));
    if (empty || (!['radio', 'checkbox'].includes(field.type) && field.validity?.valid === false)) { missing.push(label(field)); missingFields.push({id: field.id, name: field.name, label: label(field), reason: empty ? 'missing' : 'invalid'}); }
  }
  if (missing.length) return {...stop('missing', `Complete the remaining required fields: ${[...new Set(missing)].slice(0, 5).join(', ')}.`), missing: [...new Set(missing)], missingFields};
  if (agreements.some(field => !field.checked)) return stop('agreement', 'Review and choose the agreements on the website, then continue.');
  const errors = [...document.querySelectorAll('.field-validation-error, .validation-summary-errors, label.error, .error:not(input):not(select):not(textarea)')].filter(element => visible(element) && text(element));
  if (errors.length) return stop('validation', 'The website reports validation errors. Correct them before continuing.');
  const buttons = [...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')].filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
  const next = buttons.find(element => /^(?:next|continue|save and continue|save & continue)(?:\s*[›»→])?$/i.test(text(element)));
  if (!next) return stop('review', 'Details filled. Review the application and its next action on the website.');
  if (advance) next.click();
  return {...stop(advance ? 'advanced' : 'ready', advance ? 'Continuing to the next application step.' : 'Application details ready.'), advanced: advance};
}

/** Capture form metadata without input values, HTML, or URL tracking parameters. */
export function captureApplicationStructure() {
  const visible = element => !!element.getClientRects().length;
  const label = field => ([...(field.labels || [])].map(item => item.textContent).join(' ') || field.getAttribute('aria-label') || field.closest('.control-group')?.querySelector('.control-label')?.textContent || field.id || field.name || 'Unnamed field').replace(/\s+/g, ' ').trim().slice(0, 90);
  const url = new URL(location.href);
  return {version: 1, page: url.origin + url.pathname, step: url.searchParams.get('stepname') || '', fields: [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(visible).slice(0, 200).map(field => ({id: field.id, name: field.name, label: label(field), type: field.type || field.tagName.toLowerCase(), required: !!(field.required || field.classList.contains('required') || field.getAttribute('aria-required') === 'true'), disabled: !!field.disabled, readOnly: !!field.readOnly})), actions: [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].filter(visible).slice(0, 30).map(button => ({id: button.id, label: (button.innerText || button.value || button.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)}))};
}
