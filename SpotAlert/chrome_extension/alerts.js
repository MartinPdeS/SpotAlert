/** Audio runs in Chrome's offscreen document, including with the panel closed. */
let creating;
export async function playAlertSound(api) {
  const url = api.runtime.getURL("audio.html");
  const contexts = await api.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url]});
  if (!contexts.length) {
    if (!creating) creating = api.offscreen.createDocument({url: "audio.html", reasons: ["AUDIO_PLAYBACK"], justification: "Play the optional availability notification sound."}).finally(() => { creating = null; });
    await creating;
  }
  const response = await api.runtime.sendMessage({target: "audio", type: "play-sound"});
  if (!response?.ok) throw new Error(response?.error || "Could not play the alert sound.");
}
