import type { HttpError } from './http.js';

export const STALE_AFTER_MS = 90_000;

export interface Poller {
  /** Load now (e.g. after an action); ignored while a load is already running. */
  refresh(): Promise<void>;
  stop(): void;
}

export interface PollOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  intervalMs: number;
  onData: (value: T) => void;
  /** Called after each failure with the time of the last success (ms) so pages can mark staleness. */
  onFailure: (error: HttpError | Error, lastSuccessMs: number | null) => void;
}

/** Visibility-aware refresh: pauses while hidden, aborts in-flight reads when hidden or stopped. */
export function poll<T>({ load, intervalMs, onData, onFailure }: PollOptions<T>): Poller {
  let controller: AbortController | null = null,
    lastSuccess: number | null = null,
    stopped = false;

  async function refresh(): Promise<void> {
    if (stopped || controller || document.visibilityState !== 'visible') return;
    const current = new AbortController();
    controller = current;
    try {
      const value = await load(current.signal);
      if (current.signal.aborted) return;
      lastSuccess = Date.now();
      onData(value);
    } catch (error: unknown) {
      if (current.signal.aborted) return;
      onFailure(error instanceof Error ? error : new Error('Unknown failure', { cause: error }), lastSuccess);
    } finally {
      if (controller === current) controller = null;
    }
  }
  function onVisibility(): void {
    if (document.hidden) controller?.abort();
    else void refresh();
  }
  const timer = setInterval(() => void refresh(), intervalMs);
  document.addEventListener('visibilitychange', onVisibility);
  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
    },
  };
}
