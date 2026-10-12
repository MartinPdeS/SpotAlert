export const PROFILES_KEY = "spotalert.application-profiles.v1";
export const PROFILE_KEY = "spotalert.application-profile.v1";
const yesNo = ["Yes", "No"];
export const PROFILE_SECTIONS = [
  {title: "Account password", helper: "Saved separately for this applicant and used when filling supported registration forms. You can also save an existing account password here; account creation remains manual.", fields: [["registrationPassword", "Password", "password"]]},
  {title: "Identity & contact", fields: [
    ["title", "Title", ["Mr.", "Ms.", "Mrs.", "Dr."]], ["firstName", "First name"], ["middleName", "Middle name"], ["noMiddleName", "I have no middle name", yesNo], ["lastName", "Last name"], ["dateOfBirth", "Date of birth", "date"], ["nationality", "Nationality"], ["countryOfResidence", "Country of residence"], ["email", "Email", "email"], ["phone", "Phone", "tel"], ["preferredName", "Preferred name"], ["contactMethod", "Preferred contact method", ["Call", "Text", "Email"]],
  ]},
  {title: "Moving preferences", helper: "Leave the earliest move-in date empty for the first allowed weekday. Weekend dates advance to the next allowed weekday when you apply.", fields: [["moveInFrom", "Earliest move-in date", "date"]]},
  {title: "Current housing", fields: [
    ["country", "Country"], ["address", "Street address"], ["addressLine2", "Address line two"], ["postalCode", "Postal code"], ["city", "City"], ["housingType", "Rent or own", ["Rent", "Own", "Other"]], ["residencyFrom", "Living here since", "date"], ["monthlyHousingCost", "Monthly rent / mortgage (€)", "number"], ["reasonForMoving", "Reason for moving"], ["managementCompany", "Management company"], ["managementPhone", "Management company phone", "tel"],
  ]},
  {title: "Employment & income", helper: "Monthly income before taxes.", fields: [
    ["employmentStatus", "Employment status", ["Employed", "Retired", "Student", "Never employed", "Other"]], ["jobTitle", "Job title"], ["employer", "Employer"], ["employedSince", "Employed since", "date"], ["monthlyIncome", "Gross monthly income (€)", "number"], ["additionalIncome", "Additional monthly income (€)", "number"], ["employerCountry", "Employer country"], ["employerAddress", "Employer address"], ["employerAddressLine2", "Employer address line two"], ["employerPostalCode", "Employer postal code"], ["employerCity", "Employer city"], ["employerPhone", "Employer phone", "tel"],
  ]},
  {title: "Emergency contact", fields: [
    ["emergencyName", "Contact name"], ["emergencyRelationship", "Relationship", ["Roommate", "Spouse", "Son", "Daughter", "Guarantor", "Friends", "Father", "Mother", "Other"]], ["emergencyPhone", "Contact phone", "tel"], ["emergencyMobile", "Contact mobile", "tel"], ["emergencyCountry", "Contact country"], ["emergencyAddress", "Contact address"], ["emergencyAddressLine2", "Contact address line two"], ["emergencyPostalCode", "Contact postal code"], ["emergencyCity", "Contact city"],
  ]},
  {title: "Education", helper: "Canvas currently marks university, study, graduation and PhD answers as required. Enter your actual situation.", fields: [["university", "University"], ["study", "Study / programme"], ["graduated", "Graduated", yesNo], ["phd", "PhD", yesNo]]},
  {title: "Application choices", helper: "These answers are saved only when you choose them. Review the consent and credit-check agreement on the website.", fields: [["hasPets", "Pets", yesNo], ["hasVehicles", "Vehicles", yesNo], ["guarantor", "Applying with a guarantor", yesNo], ["receiveEmail", "Receive information by email", yesNo], ["receiveSms", "Receive information by SMS / text", yesNo], ["nlCitizen", "Dutch citizen", yesNo]]},
  {title: "Optional identification & bank details", helper: "Optional fields shown by Canvas. Leave anything you prefer to enter directly on the website empty.", fields: [["socialSecurityNumber", "Social security number"], ["identificationCountry", "Identification country"], ["identificationNumber", "Government-issued identification number"], ["bankAccountName", "Bank account holder"], ["iban", "IBAN"], ["bic", "BIC / SWIFT"]]},
];
export const PROFILE_FIELDS = PROFILE_SECTIONS.flatMap(section => section.fields.map(([field]) => field));

export function temporaryRegistrationDetails() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const registrationPassword = "Aa7!" + [...bytes].map(byte => alphabet[byte % alphabet.length]).join("");
  const year = 1990 + bytes[0] % 11, month = 1 + bytes[1] % 12, day = 1 + bytes[2] % 28;
  return {registrationPassword, dateOfBirth: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`};
}

export function profileCompleteness(profile = {}) {
  const required = ["title", "firstName", "lastName", "email", "phone", "dateOfBirth", "nationality", "countryOfResidence", "address", "postalCode", "city", "residencyFrom", "monthlyHousingCost", "reasonForMoving", "emergencyName", "emergencyRelationship", "emergencyPhone", "emergencyAddress", "emergencyPostalCode", "emergencyCity", "university", "study", "graduated", "phd", "hasPets", "hasVehicles", "receiveEmail", "receiveSms"];
  if (profile.noMiddleName !== "Yes") required.push("middleName");
  const labels = Object.fromEntries(PROFILE_SECTIONS.flatMap(section => section.fields.map(([key, label]) => [key, label])));
  const missing = required.filter(key => !String(profile[key] || "").trim()).map(key => labels[key]);
  return {ready: !missing.length, complete: required.length - missing.length, total: required.length, missing};
}

export function validateProfile(input = {}) {
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    profile[field] = field === "registrationPassword" ? String(input[field] || "") : String(input[field] || "").trim();
    if (profile[field].length > 200) throw new Error("Personal information fields must be at most 200 characters.");
  }
  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new Error("Enter a valid email address.");
  for (const section of PROFILE_SECTIONS) for (const [key, label, type] of section.fields) {
    const value = profile[key];
    if (!value) continue;
    if (Array.isArray(type) && !type.includes(value)) throw new Error(`Choose a valid ${label.toLowerCase()}.`);
    if (type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`Enter a valid ${label.toLowerCase()}.`);
    if (type === "number" && (!/^\d+(\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)))) throw new Error(`Enter a valid non-negative ${label.toLowerCase()}.`);
  }
  if (profile.noMiddleName === "Yes" && profile.middleName) throw new Error("Clear the middle name or change the no-middle-name answer.");
  return profile;
}

/** Select only dates allowed by the booking page; never starts an application. */
export function selectMoveInDate(profile) {
  const input = document.querySelector('#sMoveInDate');
  if (!input || input.disabled || input.readOnly || !input.getClientRects().length) return {count: 0};
  const scripts = Array.from(document.scripts).map(script => script.textContent).join('\n');
  // Read literal RentCafe constraints without executing page scripts.
  const config = scripts.match(/\$\(['"]#sMoveInDate['"]\)\.datepicker\(\{([^}]+)\}\)/)?.[1];
  const min = config?.match(/minDate:\s*['"](\d{1,2}-\d{1,2}-\d{4})['"]/)?.[1];
  const max = config?.match(/maxDate:\s*['"](\d{1,2}-\d{1,2}-\d{4})['"]/)?.[1];
  const excluded = scripts.match(/var excludedDays\s*=\s*\[([\d,\s]*)\]/)?.[1];
  if (!min || !max || excluded === undefined) return {count: 0, moveInMessage: 'Could not determine the allowed move-in dates. Choose a date in the website calendar.'};
  const parse = value => { const [day, month, year] = value.split('-').map(Number); return new Date(year, month - 1, day); };
  const minimum = parse(min), maximum = parse(max);
  const [year, month, day] = (profile.moveInFrom || '').split('-').map(Number);
  const start = profile.moveInFrom ? new Date(year, month - 1, day) : minimum;
  const date = new Date(Math.max(start.getTime(), minimum.getTime()));
  // Always skip weekends, even when the portal omits them from its configuration.
  const excludedDays = [0, 6, ...excluded.split(',').filter(value => value.trim()).map(Number)];
  while (date <= maximum && excludedDays.includes(date.getDay())) date.setDate(date.getDate() + 1);
  if (date > maximum) return {count: 0, moveInMessage: 'No allowed move-in date is available on or after your preferred date.'};
  const value = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
  // Let Chrome return the selected date before RentCafe's change handler navigates.
  setTimeout(() => input.dispatchEvent(new Event('change', {bubbles: true})), 0);
  return {count: 1, moveInDate: value, moveInMessage: `Selected move-in date: ${value}. Review the lease summary before continuing.`};
}

/** Advance only after Apply has selected an allowed move-in date. */
export async function startCanvasApplication(expectedDate, waitMs = 12000) {
  const [day, month, year] = String(expectedDate || '').split('-').map(Number);
  const selectedDate = new Date(year, month - 1, day);
  if (!Number.isFinite(selectedDate.getTime()) || [0, 6].includes(selectedDate.getDay())) return {started: false, message: 'Choose a weekday move-in date before starting the application.'};
  const end = Date.now() + waitMs;
  // Give the date-change handler time to update the lease summary.
  await new Promise(resolve => setTimeout(resolve, 750));
  do {
    if (document.documentElement?.dataset.spotalertApplicationStopped === "true") return {started: false, message: "Application automation stopped."};
    // RentCafe replaces the lease form through jQuery.load without a tab load event.
    // This function runs in MAIN so it can observe that request and handler setup.
    const jq = globalThis.jQuery;
    if (jq?.active > 0) {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    const input = document.querySelector('#sMoveInDate');
    if (input?.value !== expectedDate) return {started: false, message: 'The website changed the move-in date. Review the booking page before continuing.'};
    const button = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a')].find(item => /^start application$/i.test((item.innerText || item.value || item.textContent || '').trim()));
    const bound = !jq?._data || (button && jq._data(button, 'events')?.click?.length > 0);
    if (button && bound && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length) {
      button.click();
      return {started: true, message: `Move-in date selected: ${expectedDate}. Start Application clicked.`};
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < end);
  return {started: false, message: 'The move-in date is selected, but Start Application is unavailable. Check the booking tab.'};
}

/** Fill known fields after Apply or Fill application form. Never submits. */
export function fillApplicationForm(profile) {
  const normalize = text => String(text || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const autocompleteFields = {"given-name": "firstName", "family-name": "lastName", email: "email", tel: "phone", "street-address": "address", "address-line1": "address", "postal-code": "postalCode", "address-level2": "city", name: "fullName"};
  const patterns = [["firstName", /\b(first ?name|given ?name|voornaam)\b/], ["lastName", /\b(last ?name|sur ?name|family ?name|achternaam)\b/], ["email", /\b(e ?mail)\b/], ["phone", /\b(phone|telephone|mobile|telefoon)\b/], ["postalCode", /\b(postal ?code|post ?code|zip ?code|postcode|zip)\b/], ["city", /\b(city|town|woonplaats)\b/], ["address", /\b(street ?address|address ?line ?1|street|adres)\b/], ["fullName", /\b(full ?name|your name)\b/]];
  const values = {...profile, fullName: [profile.firstName, profile.lastName].filter(Boolean).join(" ")};
  const supported = ["canvas-world.securerc.co.uk", "southeast-thisisourdomain.securerc.co.uk", "thisisourdomain.securerc.co.uk"].includes(location.hostname);
  const canvas = supported && /oleapplication\.aspx$/i.test(location.pathname) && !!document.querySelector('#ProspectFirstName');
  const registration = supported && /oleapplication\.aspx$/i.test(location.pathname) && new URL(location.href).searchParams.get("stepname")?.toLowerCase() === "registration";
  const registrationFields = {txtName: "firstName", txtName2: "lastName", txtEmail: "email", txtPhone: "phone", BirthDate: "dateOfBirth", txtPassword: "registrationPassword"};
  const exact = {
    Salutation: "title", ProspectFirstName: "firstName", ProspectMiddleName: "middleName", chkMiddleName: "noMiddleName", ProspectLastName: "lastName", ProspectPhone: "phone", ProspectEmail: "email", NickName: "preferredName", LeaseTerm: null,
    EmergencyContactName: "emergencyName", EmergencyRelationship: "emergencyRelationship", EmergencyPhone: "emergencyPhone", EmergencyCellPhone: "emergencyMobile", drpDLCountry: "identificationCountry", DLNo: "identificationNumber",
    DOBLEASEBUT_REQINFO4: "dateOfBirth", NationalityLEASEBUT_REQINFO4: "nationality", CountryOfResidenceLEASEBUT_REQINFO4: "countryOfResidence", GraduatedLEASEBUT_REQINFO4: "graduated", UniversityLEASEBUT_REQINFO4: "university", StudyLEASEBUT_REQINFO4: "study", Receive1LEASEBUT_REQINFO4: "receiveEmail", Receive2LEASEBUT_REQINFO4: "receiveSms", SEPA_NameLEASEBUT_REQINFO4: "bankAccountName", SEPA_IBANLEASEBUT_REQINFO4: "iban", SEPA_BICLEASEBUT_REQINFO4: "bic", hDLEASEBUT_REQINFO4: "phd", GuarantorLEASEBUT_REQINFO4: "guarantor",
  };
  const dynamic = [
    [/^drpPreferredMoC\d+$/, "contactMethod"], [/^drpCurrentCountry\d+$/, "country"], [/^OwnerShipType\d+$/, "housingType"], [/^ManagementCompany\d+$/, "managementCompany"], [/^ManagementCompanyPhone\d+$/, "managementPhone"], [/^ResidencyFrom\d+$/, "residencyFrom"], [/^Currentrentpaid\d+$/, "monthlyHousingCost"], [/^CurrentReasonformoving\d+$/, "reasonForMoving"],
    [/^drpEmpCountry\d+$/, "employerCountry"], [/^Status\d+$/, "employmentStatus"], [/^Designation\d+$/, "jobTitle"], [/^EmployedSince\d+$/, "employedSince"], [/^GrossIncome\d+$/, "monthlyIncome"], [/^Additionalincome\d+$/, "additionalIncome"], [/^Employer\d+$/, "employer"], [/^EmpPhone\d+$/, "employerPhone"], [/^ProspectDOB\d+$/, "dateOfBirth"], [/^USCitizen\d+$/, "nlCitizen"], [/^SSNInt\d+$/, "socialSecurityNumber"], [/^drpEmergCountry\d+$/, "emergencyCountry"],
  ];
  for (const [prefix, fields] of [["Currentaddr", ["address", "addressLine2", "postalCode", "city"]], ["Empaddr", ["employerAddress", "employerAddressLine2", "employerPostalCode", "employerCity"]], ["Emergaddr", ["emergencyAddress", "emergencyAddressLine2", "emergencyPostalCode", "emergencyCity"]]]) {
    for (const [index, suffix] of ["Addr1", "Addr2", "ZipCode", "City"].entries()) dynamic.push([new RegExp(`^${prefix}\\d+${suffix}$`), fields[index]]);
  }
  const dateFields = new Set(["dateOfBirth", "residencyFrom", "employedSince"]);
  const filled = new Set();
  let count = 0;
  for (const input of document.querySelectorAll("input, textarea, select")) {
    if (input.disabled || input.readOnly || !input.getClientRects().length) continue;
    const id = input.id || input.name || "";
    const autocomplete = (input.getAttribute("autocomplete") || "").split(/\s+/).at(-1);
    const labels = [...(input.labels || [])].map(label => label.textContent).join(" ");
    const description = normalize([labels, input.getAttribute("aria-label"), input.name, input.id, input.placeholder].filter(Boolean).join(" "));
    const registrationPassword = registration && id === "txtPassword" && input.type === "password";
    if (/\b(confirm|repeat|verify|confirmation|captcha|search|username)\b/.test(description) || (/\bpassword\b/.test(description) && !registrationPassword)) continue;
    let field;
    if (registration) {
      field = registrationFields[id];
    } else if (canvas) {
      field = exact[id] || dynamic.find(([pattern]) => pattern.test(id))?.[1];
      if (/^(?:ProspectDOB\d*|DOBLEASEBUT_REQINFO\d+)$/i.test(id)) field = "dateOfBirth";
      if (input.type === "radio" && ["hasPets", "hasVehicles"].includes(input.name)) field = input.name;
      // Unknown Canvas controls are left alone: labels repeat across three people.
    } else {
      if (/emergency|employer|employment|management|guarantor|bank|sepa|iban|bic/i.test(description)) continue;
      field = autocompleteFields[autocomplete] || patterns.find(([, pattern]) => pattern.test(description))?.[0];
    }
    let value = values[field];
    if (!value) continue;
    if (input.type === "checkbox") {
      if (field !== "noMiddleName" || value !== "Yes" || input.checked || document.querySelector('#ProspectMiddleName')?.value?.trim()) continue;
      input.click();
    } else if (input.type === "radio") {
      const group = [...document.querySelectorAll('input[type="radio"]')].filter(item => item.name === input.name);
      if (group.some(item => item.checked) || normalize(labels || input.value) !== value.toLowerCase()) continue;
      input.click();
    } else {
      // The applicant's birth date is repeated by RentCafe; keep every copy in sync.
      if (input.value?.trim() && field !== "dateOfBirth") continue;
      if (input.tagName === "SELECT") {
        const option = [...input.options].find(option => !option.disabled && (normalize(option.textContent) === normalize(value) || normalize(option.value) === normalize(value)));
        if (!option) continue;
        value = option.value;
      } else {
        if (input.tagName === "INPUT" && !["text", "email", "tel", "date", "number"].includes(input.type) && !registrationPassword) continue;
        if (dateFields.has(field) && input.type !== "date") { const [year, month, day] = value.split('-'); value = `${day}-${month}-${year}`; }
      }
      const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", {bubbles: true}));
      input.dispatchEvent(new Event("change", {bubbles: true}));
    }
    filled.add(field);
    count++;
  }
  return {count, fields: [...filled]};
}
