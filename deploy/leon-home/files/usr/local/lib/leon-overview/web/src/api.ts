import type { Schedule } from './contracts.js';
import type { HardwareActions } from './contracts/hardware.js';
import type { AutomationSettingsRequest, StoragePasswordRequest } from './contracts/storage.js';
import { record, string } from './decode.js';
import { t } from './i18n/index.js';

/**
 * The address the browser asks for. Tailscale Serve sends /api to Pi-hole on every LEÓN Home, so the
 * panel answers the same API under its own /leon/v1, which needs no Serve route of its own.
 */
export function apiUrl(path: string): string {
  return path.replace(/^\/api\/v1\//, '/leon/v1/');
}
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
/** The /api/v1/network aliases of the router and device actions; bodies and outcomes match the /network-map/* ones. */
export interface NetworkActions {
  '/api/v1/network/name': { address: string; name: string };
  '/api/v1/network/pause': { address: string; paused: boolean };
  '/api/v1/network/schedule': { address: string; schedule: Schedule | null };
  '/api/v1/network/port': { port: number; enabled: boolean };
  '/api/v1/network/unlock': { phrase: string; password?: string };
  // Answers {status: 'sent'}: a magic packet cannot confirm the device woke; presence shows it later.
  '/api/v1/network/wake': { address: string };
}
interface ActionRequests extends HardwareActions, NetworkActions {
  '/updates/check': Record<string, never>;
  '/updates/apply': { version: string };
  '/api/v1/automation/settings': AutomationSettingsRequest;
  '/api/v1/dns/pause': { seconds: 300 | 1800 };
  '/api/v1/dns/resume': Record<string, never>;
}
async function postJson(path: string, body: unknown, token: string): Promise<{ httpStatus: number; ok: boolean; outcome: string; message: string; data: Record<string, unknown> }> {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Leon-Token': token },
      body: JSON.stringify(body),
    });
    let outcome = 'invalid',
      message = '',
      data: Record<string, unknown> = {};
    try {
      const value = record(await readJson(response, 8192));
      data = value;
      if (typeof value.status === 'string' && value.status.length <= 64) outcome = value.status;
      if (typeof value.message === 'string' && value.message.length <= 200) message = value.message;
    } catch {
      /* status code remains authoritative on malformed error responses */
    }
    return { httpStatus: response.status, ok: response.ok, outcome, message, data };
  } finally {
    clearTimeout(timeout);
  }
}

export type ActionResult = Awaited<ReturnType<typeof postJson>>;
export function postAction<K extends keyof ActionRequests>(path: K, body: ActionRequests[K], token: string): Promise<ActionResult> {
  return postJson(path, body, token);
}
export function postHardware<K extends keyof HardwareActions>(path: K, body: HardwareActions[K], token: string): Promise<ActionResult> {
  return postJson(path, body, token);
}
export function postNetwork<K extends keyof NetworkActions>(path: K, body: NetworkActions[K], token: string): Promise<ActionResult> {
  return postJson(path, body, token);
}
/** One saved drive password, or the reason it is not available. Keep it in memory only. */
export async function readStoragePassword(body: StoragePasswordRequest, token: string): Promise<{ password: string } | { reason: string }> {
  const result = await postJson('/api/v1/storage/password', body, token);
  if (result.ok && result.outcome === 'shown') return { password: string(result.data.password, 128) };
  return { reason: result.message || t('The password is not available') };
}
