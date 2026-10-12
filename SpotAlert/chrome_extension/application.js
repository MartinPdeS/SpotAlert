/** Explicit one-shot action; never saves or advances the application. Runs in MAIN. */
export function prepareCanvasSignature(screening = false) {
  try {
  const url = new URL(location.href);
  if (url.hostname !== 'canvas-world.securerc.co.uk' || !/\/oleapplication\.aspx$/i.test(url.pathname) || url.searchParams.get('stepname')?.toLowerCase() !== 'intapplicantinfo') throw new Error('Open the Canvas applicant information page.');
  const visible = element => !!element?.getClientRects().length;
  const agreement = document.getElementById('chkAgreement');
  const screeningAgreement = document.getElementById('chkTandCAgree');
  if (screening === true && (!visible(screeningAgreement) || screeningAgreement.type !== 'checkbox' || screeningAgreement.disabled)) throw new Error('The screening agreement checkbox is unavailable.');
  const first = document.getElementById('signatureOption2');
  const toggle = [...document.querySelectorAll('a')].find(element => element.id.trim() === 'ToggleScriptSignatureLin');
  const panel = document.getElementById('scriptSig');
  if (!visible(agreement) || agreement.type !== 'checkbox' || agreement.disabled || !first || first.type !== 'radio' || first.name !== 'selectedSignature' || first.disabled || first.getAttribute('aria-label') !== 'Signature Type 1' || !panel?.contains(first)) throw new Error('The expected Canvas agreement and first signature controls are unavailable.');
  if (!visible(first)) {
    if (!visible(toggle)) throw new Error('The script signature chooser is unavailable.');
    toggle.click();
  }
  if (!visible(first)) throw new Error('The website did not open the script signature choices.');
  if (!first.checked) first.click();
  if (!first.checked || document.getElementById('usersignatureType')?.value !== '1' || document.getElementById('usersignatureFont')?.value !== '2') throw new Error('The website did not register Signature Type 1.');
  if (!agreement.checked) agreement.click();
  if (!agreement.checked) throw new Error('The website did not keep the agreement checked.');
  if (screening === true && !screeningAgreement.checked) screeningAgreement.click();
  if (screening === true && !screeningAgreement.checked) throw new Error('The website did not keep the screening agreement checked.');
  agreement.scrollIntoView({block: 'center'});
  return {agreementChecked: true, signatureSelected: true, screeningChecked: screening === true && screeningAgreement.checked, message: 'Agreement checked and Signature Type 1 selected.' + (screening === true ? ' Screening agreement checked.' : '') + ' Save and Save & Continue remain manual.'};
  } catch (error) {
    return {error: error.message};
  }
}

/** Inspect RentCafe application steps. Runs in MAIN; returns labels, never values. */
export function applicationStep(advance = false, createAccount = false) {
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
  const captchaPrompt = [...document.querySelectorAll('#TermsRentableRecaptchaWrap iframe, .g-recaptcha iframe, iframe[title*="challenge"]')].some(frame => {
    if (!visible(frame) || frame.closest('.grecaptcha-badge, [data-size="invisible"]')) return false;
    const bounds = frame.getBoundingClientRect();
    return bounds.width >= 200 && bounds.height >= 70;
  });
  if (/just a moment|verify you are human|performing security verification/i.test(body) || captchaPrompt) return stop('verification', 'Complete the verification prompt in the application tab, then continue.');
  if (/\/termsandotheritems\.aspx$/i.test(location.pathname)) {
    const bookingError = [...document.querySelectorAll('#noticeboxdiv_termsandotheritems .alert-error, #noticeboxdiv_termsandotheritems .alert-danger, .validation-summary-errors, .field-validation-error, label.error')].find(element => visible(element) && text(element));
    if (bookingError) return stop('validation', 'The booking website reports an error. Review the booking tab before starting the application again.');
  }
  if (fields.some(field => field.type === 'file')) return stop('documents', 'Upload the requested documents in the application tab, then continue.');
  if (/charges|payment|summary|leasecreation|signature|checkout|submit/i.test(step)) return stop('review', 'Review this step yourself: it involves charges, lease details, signing, or submission.');
  // Some applicant-information pages include signing in the same form.
  // Never advance these pages, even when their agreement is already checked.
  const signature = [...document.querySelectorAll('#scriptSig, #DivDrawSign, input[id^="signatureOption"], canvas[id*="signature" i]')].find(visible);
  if (signature) {
    if (advance) (document.querySelector('#chkAgreement') || signature).scrollIntoView({behavior: 'smooth', block: 'center'});
    return stop('signature', 'Details filled. In the application tab, review the consent checkbox and choose your script signature yourself, then continue on the website.');
  }
  const registration = step === 'registration';
  if (registration && /(?:email|account).{0,70}(?:already (?:exists|registered)|already in use)|already have (?:an? )?account (?:for|with) (?:this|the|that|your) email/i.test(body)) return stop('account-exists', 'This email already has an account. Log in on the website to continue; no new account was created.');
  if (registration && !createAccount) return stop('registration', 'Registration details filled. Review them, then create your account or log in on the website.');
  if (!registration && (/login|signin/i.test(step) || fields.some(field => field.type === 'password'))) return stop('login', 'Log in on the website, then continue.');
  if (!registration && !['intapplicantinfo', 'applicantinfo', 'additionalapplicants', 'intadditionalapplicants'].includes(step)) return {...stop('unfamiliar', 'This form is unfamiliar. Open the application tab to review it; download its field structure to help add support.'), structure: captureApplicationStructure()};
  const agreements = fields.filter(field => field.type === 'checkbox' && !(registration && /subscribe|marketing|newsletter|opt.?in/i.test(`${field.id} ${field.name}`)) && /agreement|agree|consent|terms|credit|privacy/i.test([field.id, field.name, ...(field.labels || [])].map(item => typeof item === 'string' ? item : item.textContent).join(' ')));
  const missing = [];
  const missingFields = [];
  const label = field => ([...(field.labels || [])].map(label => label.textContent).join(' ') || field.getAttribute('aria-label') || field.closest('.control-group')?.querySelector('.control-label')?.textContent || field.id || field.name || 'Required field').replace(/\s+/g, ' ').trim().slice(0, 90);
  for (const field of fields.filter(field => !field.disabled && (field.required || field.classList.contains('required') || field.getAttribute('aria-required') === 'true' || (registration && ['txtName','txtName2','txtEmail','txtPhone','BirthDate','txtPassword'].includes(field.id))))) {
    const websiteValid = advance && globalThis.jQuery?.fn?.valid ? globalThis.jQuery(field).valid() : true;
    let empty;
    if (field.type === 'radio') empty = !fields.some(other => other.type === 'radio' && other.name === field.name && other.checked);
    else if (field.type === 'checkbox') empty = !field.checked;
    else empty = !field.value?.trim() || (field.tagName === 'SELECT' && /please (?:choose|select)|select (?:one|an option)/i.test(field.selectedOptions[0]?.textContent || ''));
    if (empty || websiteValid === false || (!['radio', 'checkbox'].includes(field.type) && field.validity?.valid === false) || (registration && field.id === 'txtEmail' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(field.value || ''))) { missing.push(label(field)); missingFields.push({id: field.id, name: field.name, label: label(field), reason: empty ? 'missing' : 'invalid'}); }
  }
  if (missing.length) return {...stop('missing', `Complete the remaining required fields: ${[...new Set(missing)].slice(0, 5).join(', ')}.`), missing: [...new Set(missing)], missingFields};
  if (agreements.some(field => !field.checked)) return stop('agreement', 'Review and choose the agreements on the website, then continue.');
  const errors = [...document.querySelectorAll('.field-validation-error, .validation-summary-errors, label.error, .error:not(input):not(select):not(textarea)')].filter(element => visible(element) && text(element));
  if (errors.length) return stop('validation', 'The website reports validation errors. Correct them before continuing.');
  const buttons = [...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')].filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
  const next = buttons.find(element => registration ? /^create (?:my |an? )?account$/i.test(text(element)) : /^(?:next|continue|save and continue|save & continue)(?:\s*[›»→])?$/i.test(text(element)));
  if (!next) return stop('review', 'Details filled. Review the application and its next action on the website.');
  if (advance) next.click();
  return {...stop(advance ? 'advanced' : 'ready', advance ? 'Continuing to the next application step.' : 'Application details ready.'), advanced: advance, accountCreation: registration};
}

/** Capture form metadata without input values, HTML, or URL tracking parameters. */
export function captureApplicationStructure() {
  const visible = element => !!element.getClientRects().length;
  const label = field => ([...(field.labels || [])].map(item => item.textContent).join(' ') || field.getAttribute('aria-label') || field.closest('.control-group')?.querySelector('.control-label')?.textContent || field.id || field.name || 'Unnamed field').replace(/\s+/g, ' ').trim().slice(0, 90);
  const url = new URL(location.href);
  return {version: 1, page: url.origin + url.pathname, step: url.searchParams.get('stepname') || '', fields: [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(visible).slice(0, 200).map(field => ({id: field.id, name: field.name, label: label(field), type: field.type || field.tagName.toLowerCase(), required: !!(field.required || field.classList.contains('required') || field.getAttribute('aria-required') === 'true'), disabled: !!field.disabled, readOnly: !!field.readOnly})), actions: [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].filter(visible).slice(0, 30).map(button => ({id: button.id, label: (button.innerText || button.value || button.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)}))};
}
