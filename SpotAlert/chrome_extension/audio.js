chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== "audio" || message.type !== "play-sound") return false;
  const audio = document.querySelector("#alert-sound");
  audio.currentTime = 0;
  audio.play().then(() => respond({ok: true})).catch((error) => respond({ok: false, error: error.message}));
  return true;
});
