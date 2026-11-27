import type { HttpError } from './http.js';

export const STALE_AFTER_MS = 90_000;

export interface Poller {
  /** Load now (e.g. after an action); ignored while a load is already running. */
  refresh(): Promise<void>;
  /** After a write, wait for any pre-write request and read again. */
  refreshAfterPending(): Promise<void>;
  stop(): void;
}

export interface PollOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  intervalMs: number;
  loadImmediately?: boolean;
  onData: (value: T) => void;
  /** Called after each failure with the time of the last success (ms) so pages can mark staleness. */
  onFailure: (error: HttpError | Error, lastSuccessMs: number | null) => void;
}

/** Visibility-aware refresh: pauses while hidden, aborts in-flight reads when hidden or stopped. */
export function poll<T>({ load, intervalMs, onData, onFailure, loadImmediately = true }: PollOptions<T>): Poller {
  let controller: AbortController | null = null,
    lastSuccess: number | null = null,
    stopped = false,
    resumePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();

  function schedule(): void {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(() => void refresh(), intervalMs);
  }

  function refresh(): Promise<void> {
    if (stopped || controller || document.visibilityState !== 'visible') return Promise.resolve();
    inFlight = read();
    return inFlight;
  }

  async function read(): Promise<void> {
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
      if (resumePending && !document.hidden) {
        resumePending = false;
        void refresh();
      } else schedule();
    }
  }
  function onVisibility(): void {
    clearTimeout(timer);
    if (document.hidden) {
      resumePending = false;
      controller?.abort();
    } else if (controller?.signal.aborted === true) resumePending = true;
    else void refresh();
  }
  document.addEventListener('visibilitychange', onVisibility);
  if (loadImmediately) void refresh();
  else schedule();
  return {
    refresh,
    async refreshAfterPending() {
      if (controller) await inFlight;
      // A concurrent caller or visibility change may already have started the new reading.
      return controller ? inFlight : refresh();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
    },
  };
}
