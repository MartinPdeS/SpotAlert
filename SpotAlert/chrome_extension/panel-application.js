import {siteForUrl} from "./sites/index.js";
import {listingKey} from "./core.js";

/** Confirmation owns the selected applicant for one explicitly authorized run. */
export function createApplicationView({$, element, guard, request, toast, getLibrary, isPersonalDirty}) {
  let pendingApplication = null;
  let applicationChoice = null;
  function showApplyConfirmation(monitor, sample) {
    applicationChoice = {monitor, sample};
    $("#signature-consent").checked = false;
    $("#apply-agreements").hidden = !siteForUrl(monitor.url)?.application.agreementSignature;
    pendingApplication = null;
    const picker = $("#apply-profile");
    picker.replaceChildren(element("option", {value: ""}, "Choose an applicant…"), ...getLibrary().profiles.map(entry => element("option", {value: entry.id}, entry.name)));
    picker.value = "";
    updateApplyConfirmation();
    $("#apply-confirmation").showModal();
  }
  function updateApplyConfirmation() {
    const list = $("#apply-confirmation-details");
    list.replaceChildren();
    const applicant = getLibrary().profiles.find(item => item.id === $("#apply-profile").value);
    pendingApplication = null;
    $("#confirm-apply").disabled = true;
    if (!applicationChoice) return;
    const {monitor, sample} = applicationChoice;
    for (const [label, detail] of [["Location", monitor.name], ["Apartment", sample.name || sample.context || "Selected apartment"], ["Rent", sample.rent || "Not published"]]) list.append(element("dt", {}, label), element("dd", {}, detail));
    if (!applicant) {
      $("#apply-confirmation-note").textContent = "Choose the applicant for this application.";
      return;
    }
    if (isPersonalDirty() && applicant.id === getLibrary().activeId) {
      $("#apply-confirmation-note").textContent = "Save this profile’s changes in Applicants before applying.";
      return;
    }
    if (applicant.testProfile) list.append(element("dt", {}, "Profile type"), element("dd", {class: "test-profile-badge"}, "Test profile · fictional details"));
    const preferred = applicant.details.moveInFrom;
    let dateLabel = "First allowed weekday";
    if (preferred) {
      const date = new Date(`${preferred}T12:00:00`);
      while ([0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
      dateLabel = `On or after ${date.getFullYear()}-${String(date.getMonth()+1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
    for (const [label, detail] of [["Applicant", applicant.name], ["Name", [applicant.details.firstName, applicant.details.lastName].filter(Boolean).join(" ") || "Not provided"], ["Email", applicant.details.email || "Not provided"], ["Move-in", dateLabel]]) list.append(element("dt", {}, label), element("dd", {}, detail));
    pendingApplication = {id: monitor.id, listingId: listingKey(sample), profileId: applicant.id};
    $("#confirm-apply").disabled = false;
    $("#apply-confirmation-note").textContent = "This profile is used for this application only. The move-in date is checked against the website calendar. Review agreements and final submission on the website.";
  }
  $("#apply-profile").addEventListener("change", updateApplyConfirmation);
  $("#cancel-apply").addEventListener("click", () => $("#apply-confirmation").close());
  $("#confirm-apply").addEventListener("click", guard(async () => {
    updateApplyConfirmation();
    if (!pendingApplication) return;
    const signatureConsent = $("#signature-consent").checked;
    const command = {...pendingApplication, createAccount: $("#apply-create-account").checked, signatureConsent, screening: signatureConsent};
    if (signatureConsent) {
      $("#signature-consent").checked = false;
    }
    pendingApplication = null;
    $("#apply-confirmation").close();
    const result = await request({type: "open-listing", ...command});
    if (result.moveInMessage) toast(result.moveInMessage);
  }));
  return {showApplyConfirmation};
}
