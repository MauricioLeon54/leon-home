import { type Child, h } from '../core/dom.js';

export interface SheetProps {
  title: string;
  content: ReadonlyArray<Child>;
  /** Called once after the sheet has left the screen, however it closed. */
  onClosed?: () => void;
}
export interface Sheet {
  element: HTMLDialogElement;
  close(): void;
}

let sheetCount = 0;

function closeDelayMs(): number {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--duration-medium'));
  return Number.isFinite(value) ? value : 350;
}

/** Bottom sheet on a modal <dialog>: the browser traps focus; Escape and a tap outside close it, and focus returns to the opener. */
export function openSheet({ title, content, onClosed }: SheetProps): Sheet {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null,
    titleId = `sheet-title-${++sheetCount}`,
    dialog = h('dialog', { className: 'sheet', attrs: { 'aria-labelledby': titleId } }, [
      h('div', { className: 'sheet-inner' }, [
        h('div', { className: 'sheet-handle', attrs: { 'aria-hidden': 'true' } }),
        h('h2', { className: 'sheet-title', text: title, attrs: { id: titleId } }),
        h('div', { className: 'sheet-body' }, content),
      ]),
    ]);
  let isClosing = false;
  function close(): void {
    if (isClosing) return;
    isClosing = true;
    dialog.classList.remove('is-open');
    setTimeout(() => {
      dialog.close();
      dialog.remove();
      opener?.focus({ preventScroll: true });
      onClosed?.();
    }, closeDelayMs());
  }
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  // The dialog has no padding of its own, so a click whose target is the dialog is a click on the backdrop.
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });
  document.body.append(dialog);
  dialog.showModal();
  void dialog.offsetWidth; // start from the resting off-screen position
  dialog.classList.add('is-open');
  return { element: dialog, close };
}
