/** A structural snapshot: no HTML source, cookies, input values, or screenshots. */
export async function inspectApplicationPage(redactions = []) {
  // Give client-side form rendering a short settling period after page load.
  await new Promise(resolve => setTimeout(resolve, 1000));
  const redact = value => {
    let text = String(value || "");
    for (const secret of redactions.filter(value => typeof value === "string" && value.trim().length >= 2)) {
      text = text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
    }
    return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]");
  };
  const safeUrl = value => {
    try {
      const url = new URL(value, location.href);
      if (!["https:", "http:"].includes(url.protocol)) return null;
      url.username = ""; url.password = ""; url.hash = "";
      for (const [key, value] of [...url.searchParams]) {
        if (!/^(my)?(floorplan|unit|property)id$/i.test(key) || !/^\d+$/.test(value)) url.searchParams.set(key, "[redacted]");
      }
      return redact(url.href);
    } catch { return null; }
  };
  const copy = document.body?.cloneNode(true);
  copy?.querySelectorAll('script, style, noscript, input, textarea, select, iframe, [contenteditable], [data-private]').forEach(node => node.remove());
  const fields = [...document.querySelectorAll("input, select, textarea")].filter(input => input.type !== "hidden" && input.getClientRects().length).slice(0, 100).map(input => ({
    tag: input.tagName.toLowerCase(), type: input.type, id: redact(input.id).slice(0, 150), name: redact(input.name).slice(0, 150),
    label: redact([...(input.labels || [])].map(label => label.textContent).join(" ") || input.getAttribute("aria-label") || input.placeholder).slice(0, 300),
    required: input.required || input.getAttribute("aria-required") === "true", autocomplete: input.autocomplete,
    disabled: input.disabled, readOnly: Boolean(input.readOnly),
    accept: input.type === "file" ? input.accept : undefined,
  }));
  const text = redact(copy?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 12000);
  const verification = /just a moment|checking your browser|security verification/i.test(document.title) || Boolean(document.querySelector('#challenge-running, #challenge-form, .cf-challenge-running'));
  const login = fields.some(field => field.type === "password") && /log ?in|sign ?in/i.test(document.title + text.slice(0, 1500));
  return {
    url: safeUrl(location.href), title: redact(document.title).slice(0, 300),
    pageKind: verification ? "verification" : login ? "login" : fields.length ? "form" : "page",
    text, fields,
    buttons: [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')].filter(button => button.getClientRects().length).slice(0, 50).map(button => ({text: redact(button.tagName === "INPUT" ? "Submit" : button.textContent).trim().slice(0, 200), type: button.type || "link"})),
    forms: [...document.forms].slice(0, 20).map(form => ({method: form.method, action: safeUrl(form.getAttribute("action") || location.href)})),
  };
}
