import {PROFILE_SECTIONS} from "./profile.js";
import {element} from "./panel-dom.js";

/** Construct applicant fields once; the panel owns drafts and saved state. */
export function mountProfileFields($) {
  const orderedSections = [...PROFILE_SECTIONS].sort((a, b) => {
    const order = ["Identity & contact", "Moving preferences", "Account password"];
    return (order.indexOf(a.title) < 0 ? 99 : order.indexOf(a.title)) - (order.indexOf(b.title) < 0 ? 99 : order.indexOf(b.title));
  });
  for (const section of orderedSections) {
    const details = element("details", {class: "profile-group"});
    details.open = section.title === "Identity & contact";
    details.dataset.fields = section.fields.map(([key]) => key).join(",");
    details.append(element("summary", {}, element("span", {class: "profile-section-title"}, section.title), element("span", {class: "profile-section-count"})));
    if (section.helper) details.append(element("p", {class: "helper"}, section.helper));
    const grid = element("div", {class: "profile-fields"});
    const identityOrder = ["firstName", "lastName", "middleName", "noMiddleName", "dateOfBirth", "email", "phone", "nationality", "countryOfResidence", "title", "preferredName", "contactMethod"];
    const fields = section.title === "Identity & contact" ? [...section.fields].sort(([a], [b]) => identityOrder.indexOf(a) - identityOrder.indexOf(b)) : section.fields;
    for (const [key, label, type] of fields) {
      const wrapper = element("label", {"data-profile-field": key}, element("span", {class: "field-label"}, label, element("small", {class: "field-requirement"})));
      const checkbox = key === "noMiddleName";
      const input = checkbox ? element("input", {id: `personal-${key}`, type: "checkbox"}) : Array.isArray(type) ? element("select", {id: `personal-${key}`}) : element("input", {id: `personal-${key}`, type: type || "text", maxlength: "200"});
      if (Array.isArray(type) && !checkbox) for (const choice of ["", ...type]) input.append(element("option", {value: choice}, choice || "Choose…"));
      input.setAttribute("aria-describedby", "profile-field-note");
      if (checkbox) wrapper.classList.add("checkbox-label", "profile-checkbox");
      if (type === "number") { input.min = "0"; input.step = "0.01"; }
      if (type === "password") {
        const reveal = element("button", {type: "button", class: "password-reveal", "aria-label": "Show account password", "aria-pressed": "false", onclick: () => {
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          reveal.textContent = show ? "Hide" : "Show";
          reveal.setAttribute("aria-label", show ? "Hide account password" : "Show account password");
          reveal.setAttribute("aria-pressed", String(show));
        }}, "Show");
        wrapper.append(element("div", {class: "profile-password"}, input, reveal));
      } else wrapper.append(input);
      grid.append(wrapper);
    }
    if (section.title === "Identity & contact") {
      const middle = grid.querySelector('[data-profile-field="middleName"]');
      const checkbox = grid.querySelector('[data-profile-field="noMiddleName"]');
      const group = element("div", {class: "middle-name-field"});
      middle.replaceWith(group);
      group.append(element("span", {class: "middle-name-heading"}, "Middle name"), middle, checkbox);
    }
    details.append(grid);
    $("#profile-sections").append(details);
  }
}
