/** Presentation calculations shared by the side panel and workspace. */
export const UI_KEY = "spotalert.ui.v1";

export function applicationReadiness(profile = {}) {
  const fields = {firstName: "first name", lastName: "last name", email: "email", phone: "phone"};
  const missing = Object.entries(fields).filter(([key]) => !String(profile[key] || "").trim() || (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile[key]))).map(([, label]) => label);
  return {ready: !missing.length, missing};
}

export function freshness(monitor, now = Date.now()) {
  if (!Number.isFinite(monitor.lastCheckedAt) || !monitor.lastCheckedAt) return {stale: false, text: "Not checked", title: "No successful availability check yet."};
  const seconds = Math.max(0, Math.floor((now - monitor.lastCheckedAt) / 1000));
  const stale = seconds > Math.max(60, (monitor.intervalSeconds || 300) * 3);
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
  return {stale, text: `${stale ? "Stale · " : "Checked "}${age} ago`, title: `${stale ? "Results may be out of date. " : ""}Last successful check: ${new Date(monitor.lastCheckedAt).toLocaleString()}`};
}

export function availabilityTotals(monitors = []) {
  let apartments = 0;
  let unknownCounts = 0;
  for (const monitor of monitors) {
    const seen = new Set();
    for (const sample of monitor.samples || []) {
      if (!sample.matched || sample.included === false) continue;
      const key = sample.id || sample.floorplanId || sample.name || sample.index;
      if (key !== undefined && seen.has(key)) continue;
      seen.add(key);
      if (Number.isInteger(sample.availableCount) && sample.availableCount > 0) apartments += sample.availableCount;
      else { apartments++; unknownCounts++; }
    }
  }
  return {websites: monitors.filter(monitor => monitor.available === true).length, apartments, unknownCounts};
}
