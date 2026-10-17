import {ALARM_PREFIX} from "./core.js";
export function createScheduler(api, now, timers, state, check) {
  const fastTimers = new Map();
  const alarmName = id => ALARM_PREFIX + id;
  function clearFastTimer(id) {
    if (fastTimers.has(id)) timers.clearTimeout(fastTimers.get(id));
    fastTimers.delete(id);
  }
  async function arm(monitor, when) {
    clearFastTimer(monitor.id);
    if (monitor.intervalSeconds < 30 && when - now() < 30000) {
      const timer = timers.setTimeout(() => {
        fastTimers.delete(monitor.id);
        return state().then((value) => {
          const current = value.monitors.find((item) => item.id === monitor.id);
          if (current?.enabled && current.intervalSeconds < 30 && current.nextCheckAt === when) return check(current.id, true);
        }).catch(console.error);
      }, Math.max(0, when - now()));
      timer?.unref?.();
      fastTimers.set(monitor.id, timer);
    }
    // Alarms survive worker suspension, but Chrome enforces a 30-second minimum.
    await api.alarms.create(alarmName(monitor.id), {when: Math.max(now() + 30000, when)});
  }

  return {clearFastTimer, arm, alarmName};
}
