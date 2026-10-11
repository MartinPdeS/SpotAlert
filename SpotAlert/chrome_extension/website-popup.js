/** Availability overlays on supported websites, including after page refreshes. */
(() => {
  const stateKey = "spotalert.monitors.v2";
  const dismissedKey = "spotalert.website-dismissed.v1";
  let state;
  let dismissed = [];
  let activeId;
  let host;
  function render() {
    const alerts = (state?.alertPreferences?.popup === false ? [] : state?.monitors || []).filter(m => m.alert && !m.alert.test && m.notify && !(m.snoozedUntil > Date.now()) && Date.now() - m.alert.at < 600000 && !dismissed.includes(m.alert.id));
    const monitor = alerts.sort((a, b) => a.alert.at - b.alert.at)[0];
    if (!monitor) { host?.remove(); host = null; activeId = null; return; }
    if (activeId === monitor.alert.id && host?.isConnected) return;
    host?.remove();
    host = document.createElement("div");
    host.id = "spotalert-availability";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:block";
    const root = host.attachShadow({mode: "closed"});
    const style = document.createElement("style");
    style.textContent = `:host{font:14px/1.5 system-ui;color:#e6eee8}.backdrop{position:fixed;inset:0;background:#0009;display:grid;place-items:center;padding:18px}.card{background:#17201c;border:1px solid #78e0ba;border-radius:14px;padding:22px;width:min(440px,90vw);max-height:80vh;overflow:auto;box-sizing:border-box}h2{margin:0 0 8px;font-size:22px}p{overflow-wrap:anywhere}article{border-top:1px solid #3b5144;padding:12px 0}a{color:#78e0ba}button{font:inherit;border:0;border-radius:7px;background:#78e0ba;color:#132b20;padding:9px 16px;cursor:pointer}:focus-visible{outline:3px solid #efc47d;outline-offset:3px}`;
    const backdrop = document.createElement("div"); backdrop.className = "backdrop";
    const card = document.createElement("section"); card.className = "card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", "SpotAlert availability"); card.tabIndex = -1;
    const heading = document.createElement("h2"); heading.textContent = "SpotAlert · New availability";
    const site = document.createElement("p"); site.textContent = monitor.name;
    card.append(heading, site);
    for (const sample of monitor.alert.listings || []) {
      const row = document.createElement("article");
      const name = document.createElement("strong"); name.textContent = sample.name || "Apartment";
      const details = document.createElement("p"); details.textContent = [sample.rent, sample.context || sample.text].filter(Boolean).join(" · ");
      row.append(name, details);
      if (!monitor.alert.test) {
        const link = document.createElement("a");
        try {
          const url = new URL(sample.applicationUrl || monitor.url);
          if (url.protocol === "https:" && url.origin === new URL(monitor.url).origin) {
            link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Open apartment ↗"; row.append(link);
          }
        } catch { /* No safe direct link. */ }
      }
      card.append(row);
    }
    const close = document.createElement("button"); close.textContent = "Dismiss";
    const id = monitor.alert.id;
    const dismiss = async () => {
      const saved = (await chrome.storage.local.get(dismissedKey))[dismissedKey] || [];
      dismissed = [...new Set([...saved, id])].slice(-100);
      await chrome.storage.local.set({[dismissedKey]: dismissed});
      render();
    };
    close.addEventListener("click", dismiss);
    card.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); }
      if (event.key === "Tab") {
        const items = [...card.querySelectorAll("a,button")];
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (root.activeElement === first || root.activeElement === card)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    card.append(close); backdrop.append(card); root.append(style, backdrop); document.documentElement.append(host);
    activeId = id; card.focus({preventScroll: true});
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[stateKey]) state = changes[stateKey].newValue;
    if (changes[dismissedKey]) dismissed = changes[dismissedKey].newValue || [];
    render();
  });
  chrome.storage.local.get([stateKey, dismissedKey]).then(saved => {
    state = saved[stateKey]; dismissed = saved[dismissedKey] || []; render();
  });
  setInterval(render, 10000);
})();
