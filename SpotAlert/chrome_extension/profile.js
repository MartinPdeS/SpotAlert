export const PROFILE_KEY = "spotalert.application-profile.v1";
export const PROFILE_FIELDS = ["firstName", "lastName", "email", "phone", "address", "postalCode", "city"];

export function validateProfile(input = {}) {
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    profile[field] = String(input[field] || "").trim();
    if (profile[field].length > 200) throw new Error("Personal information fields must be at most 200 characters.");
  }
  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new Error("Enter a valid email address.");
  return profile;
}

/** Injected only after the user presses Fill application form. Never submits. */
export function fillApplicationForm(profile) {
  const normalize = text => String(text || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const autocompleteFields = {"given-name": "firstName", "family-name": "lastName", email: "email", tel: "phone", "street-address": "address", "address-line1": "address", "postal-code": "postalCode", "address-level2": "city", name: "fullName"};
  const patterns = [["firstName", /\b(first ?name|given ?name|voornaam)\b/], ["lastName", /\b(last ?name|sur ?name|family ?name|achternaam)\b/], ["email", /\b(e ?mail)\b/], ["phone", /\b(phone|telephone|mobile|telefoon)\b/], ["postalCode", /\b(postal ?code|post ?code|zip ?code|postcode|zip)\b/], ["city", /\b(city|town|woonplaats)\b/], ["address", /\b(street ?address|address ?line ?1|street|adres)\b/], ["fullName", /\b(full ?name|your name)\b/]];
  const values = {...profile, fullName: [profile.firstName, profile.lastName].filter(Boolean).join(" ")};
  const filled = new Set();
  let count = 0;
  for (const input of document.querySelectorAll("input, textarea")) {
    if (input.disabled || input.readOnly || input.value?.trim() || !input.getClientRects().length) continue;
    if (input.tagName === "INPUT" && !["text", "email", "tel", "search"].includes(input.type)) continue;
    const autocomplete = (input.getAttribute("autocomplete") || "").split(/\s+/).at(-1);
    const labels = [...(input.labels || [])].map(label => label.textContent).join(" ");
    const description = normalize([labels, input.getAttribute("aria-label"), input.name, input.id, input.placeholder].filter(Boolean).join(" "));
    if (/\b(confirm|repeat|verify|confirmation)\b/.test(description)) continue;
    const field = autocompleteFields[autocomplete] || patterns.find(([, pattern]) => pattern.test(description))?.[0];
    const value = values[field];
    if (!value || /\b(captcha|password|search|username)\b/.test(description)) continue;
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
    filled.add(field);
    count++;
  }
  return {count, fields: [...filled]};
}
