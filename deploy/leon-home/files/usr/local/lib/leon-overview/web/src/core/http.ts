import { apiUrl, readJson } from '../api.js';

/** Why a read failed; pages word each kind differently ("Sign in again" vs "Not answering"). */
export type HttpFailure = 'offline' | 'timeout' | 'forbidden' | 'server' | 'invalid';
export class HttpError extends Error {
  constructor(
    readonly kind: HttpFailure,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

const TIMEOUT_MS = 8000;

/** GET a bounded JSON view and parse it at the boundary; callers only ever see typed values. */
export async function getView<T>(path: string, parse: (value: unknown) => T, signal?: AbortSignal, maximumBytes = 1_048_576): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: combined });
  } catch (error: unknown) {
    if (signal?.aborted) throw error; // the caller cancelled; not a failure to report
    throw new HttpError(timeout.aborted ? 'timeout' : 'offline', `GET ${path} failed`, { cause: error });
  }
  if (response.status === 403) throw new HttpError('forbidden', `GET ${path} refused`);
  if (!response.ok) throw new HttpError('server', `GET ${path} answered ${response.status}`);
  try {
    return parse(await readJson(response, maximumBytes));
  } catch (error: unknown) {
    throw new HttpError('invalid', `GET ${path} returned an invalid view`, { cause: error });
  }
}
