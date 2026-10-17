import {EMAIL_KEY} from "./email.js";
import {clientQuestionnaire, parseClientReply, CLIENT_FIELDS} from "./clients.js";

export function createDeliveryView({$, element, guard, request, loadState, switchTab, toast, getLibrary, isPersonalDirty}) {
  function renderSettings() {
    const picker = $('#email-test-profile');
    const previous = picker.value;
    const profiles = getLibrary().profiles;
    const options = profiles.map(profile => [profile.id, `${profile.name} · ${profile.details.email || 'No email saved'}`]);
    if (JSON.stringify([...picker.options].map(option => [option.value, option.textContent])) !== JSON.stringify([['', 'Select a profile'], ...options])) {
      picker.replaceChildren(element('option', {value: ''}, 'Select a profile'), ...options.map(([id, name]) => element('option', {value: id}, name)));
      picker.value = profiles.some(profile => profile.id === previous) ? previous : '';
    }
  }
  async function saveEmailSettings() {
    const sender = $('#email-sender').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) throw new Error('Enter a valid sender email.');
    await chrome.storage.local.set({[EMAIL_KEY]: {apiKey: $('#email-api-key').value.trim(), sender}});
    $('#email-save-status').textContent = 'Settings saved';
  }
  $('#email-delivery-form').addEventListener('submit', guard(async event => {
    event.preventDefault();
    await saveEmailSettings();
    toast('Email delivery settings saved.');
  }));
  $('#test-email').addEventListener('click', guard(async () => {
    const button = $('#test-email');
    button.disabled = true;
    try {
      if (!$('#email-test-profile').value) throw new Error('Select a recipient profile for the test.');
      await saveEmailSettings();
      await request({type: 'test-email', profileId: $('#email-test-profile').value});
      toast('Test email accepted by the provider.');
    } finally { button.disabled = false; }
  }));
  for (const id of ['email-api-key', 'email-sender']) $(`#${id}`).addEventListener('input', () => { $('#email-save-status').textContent = 'Unsaved changes'; });

  function updateQuestionnaire() { $("#client-questionnaire").textContent = clientQuestionnaire($("#client-name").value); }
  $("#client-name").addEventListener("input", updateQuestionnaire);
  updateQuestionnaire();
  $("#copy-client-questionnaire").addEventListener("click", guard(async () => {
    await navigator.clipboard.writeText(clientQuestionnaire($("#client-name").value)); toast("Questionnaire copied.");
  }));
  $("#send-client-questionnaire").addEventListener("click", guard(async () => {
    const button = $("#send-client-questionnaire"); button.disabled = true;
    try {
      await request({type: "send-client-questionnaire", name: $("#client-name").value, to: $("#client-email").value, replyTo: $("#client-reply-to").value});
      $("#client-send-status").textContent = "Email sent. Paste their reply here when it arrives.";
    } finally { button.disabled = false; }
  }));
  let reviewedClientReply = null;
  $("#client-reply").addEventListener("input", () => { reviewedClientReply = null; $("#import-client-profile").hidden = true; $("#client-import-preview").hidden = true; });
  $("#review-client-reply").addEventListener("click", guard(() => {
    reviewedClientReply = null; $("#import-client-profile").hidden = true;
    const profile = parseClientReply($("#client-reply").value);
    const preview = $("#client-import-preview");
    const list = element("dl", {class: "client-answer-list"});
    for (const [key, label] of CLIENT_FIELDS) if (profile[key]) list.append(element("dt", {}, label), element("dd", {}, key === "registrationPassword" ? "Password provided · hidden" : profile[key]));
    preview.replaceChildren(element("h4", {}, "Review extracted answers"), list); preview.hidden = false;
    reviewedClientReply = $("#client-reply").value; $("#import-client-profile").hidden = false;
  }));
  $("#import-client-profile").addEventListener("click", guard(async () => {
    if (isPersonalDirty()) throw new Error("Save your edits in Profiles before importing a profile.");
    if (!reviewedClientReply || reviewedClientReply !== $("#client-reply").value) throw new Error("Review the answers first.");
    const button = $("#import-client-profile"); button.disabled = true;
    try {
      await request({type: "import-client-profile", name: $("#client-profile-name").value, reply: reviewedClientReply});
      reviewedClientReply = null; button.hidden = true;
      $("#client-import-status").textContent = "Profile created and selected.";
      await loadState(); switchTab("personal"); toast("Client profile created. Review the details before applying.");
    } finally { button.disabled = false; }
  }));


  return {renderSettings};
}
