import { nullable, optionalBoolean, record, string } from '../decode.js';

/** GET /api/v1/session — who is signed in and which optional areas this node has. */
export interface Session {
  login: string;
  node: string; // short host name, also the typed confirmation for reboot/shutdown
  actionToken: string;
  version: string | null; // installed LEÓN Home version; null when unknown
  availableVersion: string | null; // a signed update waiting for acceptance (family edition)
  features: { automation: boolean; storage: boolean; updates: boolean }; // updates: signed release page (family edition)
}

export function parseSession(value: unknown): Session {
  const root = record(value),
    features = record(root.features);
  return {
    login: string(root.login, 254),
    node: string(root.node, 63),
    actionToken: string(root.actionToken, 200),
    version: nullable(root.version, item => string(item, 40)),
    availableVersion: nullable(root.availableVersion, item => string(item, 40)),
    features: { automation: optionalBoolean(features.automation) ?? false, storage: optionalBoolean(features.storage) ?? false, updates: optionalBoolean(features.updates) ?? false },
  };
}
