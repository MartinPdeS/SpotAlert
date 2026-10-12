export const EMAIL_KEY = "spotalert.resend.v1";
export const CONTACT_KEY = "spotalert.notification-destinations.v1";
export async function sendEmailAlert(api, alert, subject, body, force = false, delivery = null) {
  const settings = await api.storage.local.get([EMAIL_KEY, CONTACT_KEY]);
  const email = settings[EMAIL_KEY] || {};
  if (!force && !email.enabled) return {skipped: true};
  const to = delivery?.to || settings[CONTACT_KEY]?.email?.trim();
  if (!email.apiKey || !to) throw new Error("Save an email destination and Resend API key in Notifications.");
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${email.apiKey}`, "Idempotency-Key": `spotalert-${alert.id}`},
      body: JSON.stringify({from: email.sender || "onboarding@resend.dev", to: [to], subject: subject.slice(0, 200), text: body.slice(0, 12000), ...(delivery?.replyTo ? {reply_to: delivery.replyTo} : {})}),
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Error("Could not reach Resend. Check your internet connection and try again."); }
  let result;
  try { result = await response.json(); } catch { throw new Error("Resend returned an unreadable response. Try again later."); }
  if (!response.ok) {
    const errors = {
      401: "Resend rejected the API key. Check it in Notifications.",
      403: "Resend rejected the sender or recipient. The test sender can only email your Resend account address; other recipients require a verified domain.",
      422: "Resend rejected the email. Check the sender and recipient addresses.",
      429: "Resend sending limit reached. Try again later.",
    };
    throw new Error(errors[response.status] || "Resend could not send the email. Check the Resend dashboard.");
  }
  if (!result?.id) throw new Error("Resend did not confirm the email request.");
  return {sent: true, id: result.id};
}
