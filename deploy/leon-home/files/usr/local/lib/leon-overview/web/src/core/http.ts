import { readGetJson, ReadStatusError } from '../api.js';

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
  let value: unknown;
  try {
    value = await readGetJson(path, combined, maximumBytes);
  } catch (error: unknown) {
    if (signal?.aborted ?? false) throw error;
    if (error instanceof ReadStatusError) throw new HttpError(error.status === 403 ? 'forbidden' : 'server', `GET ${path} refused`, { cause: error });
    if (timeout.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) throw new HttpError('timeout', `GET ${path} timed out`, { cause: error });
    throw new HttpError(error instanceof TypeError ? 'offline' : 'invalid', `GET ${path} failed`, { cause: error });
  }
  try {
    return parse(value);
  } catch (error: unknown) {
    throw new HttpError('invalid', `GET ${path} returned an invalid view`, { cause: error });
  }
}
