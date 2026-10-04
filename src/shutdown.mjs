

const SYMBOL_TIMEOUT = Symbol('timeout');

export const HANDLED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP']);

export function installShutdownHandlers({
  bridge,
  store,
  exit = code => process.exit(code),
  signals = process,
  watchdogMs = 8000,

  forceExitDelayMs = 250,
  hardExitGraceMs = 2000,

  forceExit = code => process.exit(code),

  clock = () => performance.now(),
  log = () => {},
}) {

  let cleanup = null;
  const runCleanup = async reason => {
    let workers = null;
    let workerError = null;
    let lockError = null;

    try {
      workers = await bridge.shutdown();
    } catch (error) {
      workerError = error?.message ?? String(error);
    }
    try {

      store.unlock();
    } catch (error) {
      lockError = error?.message ?? String(error);
    }

    log({ event: 'bridge_shutdown', reason, workerError, lockError });
    return { already: false, workers, workerError, lockError };
  };

  let deadline = null;

  const shutdown = reason => {
    if (cleanup === null) {

      deadline = clock() + watchdogMs;
      cleanup = runCleanup(reason);
    } else {
      log({ event: 'bridge_shutdown_join', reason });
    }
    return cleanup;
  };

  const awaitCleanup = async (reason, budgetMs) => {
    const budget = deadline === null
      ? (budgetMs ?? watchdogMs)
      : Math.max(0, deadline - clock());
    let timer;
    let forceTimer;

    let killTimer;
    let hardTimer;

    let exitRequested = false;
    try {
      const outcome = await Promise.race([
        shutdown(reason),
        new Promise(resolve => { timer = setTimeout(() => resolve(SYMBOL_TIMEOUT), budget); }),
      ]);
      if (outcome !== SYMBOL_TIMEOUT) return outcome;

      log({ event: 'bridge_shutdown_watchdog', reason, watchdogMs, budgetMs: budget });

      hardTimer = setTimeout(() => {
        if (exitRequested) return;                       // 只退一次
        exitRequested = true;
        log({ event: 'bridge_shutdown_hard_exit', reason, graceMs: hardExitGraceMs });
        forceExit(1);
      }, hardExitGraceMs);

      const killBudget = Math.max(1, forceExitDelayMs);
      let killed = null;
      try {
        if (typeof bridge.emergencyKillWorkers === 'function') {
          killed = await Promise.race([
            Promise.resolve(bridge.emergencyKillWorkers()),
            new Promise(resolve => {
              killTimer = setTimeout(() => resolve(SYMBOL_TIMEOUT), killBudget);
            }),
          ]);
          if (killed === SYMBOL_TIMEOUT) {
            killed = null;
            log({
              event: 'bridge_shutdown_emergency_kill_timeout', reason, killBudget,
              note: '紧急终止未在上限内结算；仍按"未确认终止"退出',
            });
          } else {
            log({ event: 'bridge_shutdown_emergency_kill', reason, results: killed });
          }
        }
      } catch (error) {

        log({ event: 'bridge_shutdown_emergency_kill_failed', reason, message: error?.message ?? String(error) });
      } finally {
        if (killTimer !== undefined) { clearTimeout(killTimer); killTimer = undefined; }
      }

      await new Promise(resolve => { forceTimer = setTimeout(resolve, forceExitDelayMs); });

      const unconfirmed = killed === null || killed.some(entry => entry.terminationObserved !== true);
      log({
        event: 'bridge_shutdown_force_exit', reason, unconfirmed,
        workersSignalled: killed === null ? null : killed.filter(entry => entry.signalled).length,
        workersTerminationObserved: killed === null
          ? null
          : killed.filter(entry => entry.terminationObserved === true).length,
      });
      if (!exitRequested) {
        exitRequested = true;
        forceExit(unconfirmed ? 1 : 0);
      }
      return null;
    } finally {

      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
    }
  };

  let exiting = false;
  const shutdownThenExit = (reason, code = 0) => {

    if (exiting) return false;
    exiting = true;

    let exited = false;
    const finish = () => {
      if (exited) return;
      exited = true;
      exit(code);
    };

    awaitCleanup(reason, watchdogMs)
      .catch(error => log({ event: 'bridge_shutdown_failed', reason, message: error?.message ?? String(error) }))
      .finally(finish);
    return true;
  };

  const handlers = new Map();
  for (const name of HANDLED_SIGNALS) {
    const handler = () => {
      log({ event: 'bridge_signal', signal: name });
      shutdownThenExit(name);
    };
    handlers.set(name, handler);
    signals.on(name, handler);
  }

  return {

    shutdown,

    awaitCleanup: (reason, budgetMs = watchdogMs) => awaitCleanup(reason, budgetMs),
    shutdownThenExit,

    dispose() {
      for (const [name, handler] of handlers) signals.off(name, handler);
      handlers.clear();
    },
  };
}
