import { siteError, errorKind } from "./core.js";

/** Coordinate manual batches through the engine's existing checks and mutation queue. */
export function createBatchChecks({
  state,
  mutate,
  now,
  check,
  cancelCheck,
  find,
  history,
}) {
  let batchCheck = null;
  function checkAll(ids) {
    if (batchCheck) return batchCheck.promise;
    const batch = { cancelled: false, currentId: null };
    batchCheck = batch;
    batch.promise = (async () => {
      await mutate((value) => {
        value.checkBatch = {
          status: "running",
          locationIds: ids,
          total: ids.length,
          completed: 0,
          failed: 0,
          currentId: null,
          startedAt: now(),
        };
      });
      try {
        for (const id of ids) {
          if (batch.cancelled) break;
          batch.currentId = id;
          await mutate((value) => {
            value.checkBatch.currentId = id;
          });
          if (batch.cancelled) break;
          try {
            await check(id);
          } catch (error) {
            await mutate((value) => {
              const monitor = find(value, id);
              monitor.error = siteError(monitor, error);
              monitor.errorKind = errorKind(error);
              monitor.phase = "error";
              history(monitor, { kind: "error", message: monitor.error });
            });
          }
          if (batch.cancelled) break;
          await mutate((value) => {
            value.checkBatch.completed++;
            if (find(value, id).error) value.checkBatch.failed++;
          });
        }
      } finally {
        await mutate((value) => {
          Object.assign(value.checkBatch, {
            status: batch.cancelled ? "cancelled" : "completed",
            currentId: null,
            finishedAt: now(),
          });
        });
        batchCheck = null;
      }
      return state();
    })();
    return batch.promise;
  }
  async function cancelAllChecks() {
    if (batchCheck) {
      batchCheck.cancelled = true;
      if (batchCheck.currentId) await cancelCheck(batchCheck.currentId);
      await batchCheck?.promise;
    }
    return state();
  }
  function stopPendingBatch() {
    if (batchCheck) batchCheck.cancelled = true;
  }
  return { checkAll, cancelAllChecks, stopPendingBatch };
}
