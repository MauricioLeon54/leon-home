import type { Schedule } from './contracts.js';
import { record } from './decode.js';

export async function readText(response: Response, maximumBytes = 1_048_576): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error('Response exceeds limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function readJson(response: Response, maximumBytes = 1_048_576): Promise<unknown> {
  const result: unknown = JSON.parse(await readText(response, maximumBytes));
  return result;
}
interface ActionRequests {
  '/updates/check': Record<string, never>;
  '/updates/apply': { version: string };
  '/network-map/name': { address: string; name: string };
  '/network-map/pause': { address: string; paused: boolean };
  '/network-map/schedule': { address: string; schedule: Schedule | null };
  '/network-map/port': { port: number; enabled: boolean };
  '/network-map/unlock': { phrase: string };
}
export async function postAction<K extends keyof ActionRequests>(path: K, body: ActionRequests[K], token: string): Promise<{ httpStatus: number; ok: boolean; outcome: string }> {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Leon-Token': token },
      body: JSON.stringify(body),
    });
    let outcome = 'invalid';
    try {
      const value = record(await readJson(response, 8192));
      if (typeof value.status === 'string' && value.status.length <= 64) outcome = value.status;
    } catch {
      /* status code remains authoritative on malformed error responses */
    }
    return { httpStatus: response.status, ok: response.ok, outcome };
  } finally {
    clearTimeout(timeout);
  }
}
