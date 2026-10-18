import {STORAGE_KEY} from "./core.js";

/** One write queue for all engine commands; failed writes do not poison later work. */
export function createEngineStore(api) {
  let writes = Promise.resolve();
  /** @returns {Promise<import("./contracts.js").EngineState>} */
  async function state() {
    await writes;
    return (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {version: 2, monitors: []};
  }
  /** @template T
   * @param {(state: import("./contracts.js").EngineState) => T|Promise<T>} update
   * @returns {Promise<T>}
   */
  function mutate(update) {
    const operation = writes.then(async () => {
      const value = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {version: 2, monitors: []};
      const result = await update(value);
      await api.storage.local.set({[STORAGE_KEY]: value});
      const active = value.monitors.filter((monitor) => monitor.enabled).length;
      const available = value.monitors.filter((monitor) => monitor.available === true).length;
      await api.action.setBadgeBackgroundColor({color: available ? "#72deb6" : "#49685c"});
      await api.action.setBadgeText({text: available ? String(available) : active ? String(active) : ""});
      await api.action.setTitle({title: `SpotAlert · ${active} watching · ${available} available`});
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  return {state, mutate};
}
