import { h } from '../../core/dom.js';
import type { ButtonVariant } from '../../ui/button.js';

/** A .btn that navigates: an app page (router), a smb:// address or an external page (new tab). */
export function linkButton(label: string, href: string, variant: ButtonVariant = 'plain', isExternal = false): HTMLAnchorElement {
  return h('a', { className: `btn is-${variant}`, text: label, attrs: { href, ...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {}) } });
}
