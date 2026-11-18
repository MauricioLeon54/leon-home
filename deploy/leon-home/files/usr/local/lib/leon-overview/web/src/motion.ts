// transitions.dev orchestration shared by every page. CSS owns the motion (base.css); these
// helpers only sequence classes and read durations from the same custom properties.
function duration(name: string, fallback: number): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}
function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const closing = new WeakMap<HTMLDialogElement, ReturnType<typeof setTimeout>>();
export function openDialog(dialog: HTMLDialogElement): void {
  clearTimeout(closing.get(dialog));
  dialog.classList.add('t-modal');
  dialog.classList.remove('is-closing', 'is-open');
  if (!dialog.open) dialog.showModal();
  void dialog.offsetWidth; // start from the resting pre-open scale
  dialog.classList.add('is-open');
}
export function closeDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open || dialog.classList.contains('is-closing')) return;
  dialog.classList.remove('is-open');
  dialog.classList.add('is-closing');
  closing.set(
    dialog,
    setTimeout(
      () => {
        dialog.classList.remove('is-closing');
        dialog.close();
      },
      reducedMotion() ? 0 : duration('--modal-close-dur', 150)
    )
  );
}
/** Escape closes with the same motion as Cancel instead of the browser's instant close. */
export function bindDialog(dialog: HTMLDialogElement): void {
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeDialog(dialog);
  });
}

/** Outcome messages swap in place; the live region still announces the final text. */
export function swapText(element: HTMLElement, value: string, className: string): void {
  const apply = () => {
    element.textContent = value;
    element.className = className;
  };
  if (element.textContent === value || !element.textContent || reducedMotion()) {
    apply();
    return;
  }
  element.classList.add('t-text-swap', 'is-exit');
  setTimeout(
    () => {
      apply();
      element.classList.add('t-text-swap', 'is-enter-start');
      void element.offsetHeight;
      element.classList.remove('is-enter-start');
    },
    duration('--text-swap-dur', 150)
  );
}

/** Accordion: one delegated listener, so server-rendered and replaced markup keeps working. */
export function setDisclosure(item: Element, open: boolean): void {
  item.setAttribute('data-open', String(open));
  item.querySelector(':scope > .t-acc-head')?.setAttribute('aria-expanded', String(open));
  item.querySelector(':scope > .t-acc-panel')?.toggleAttribute('inert', !open);
}
export function bindDisclosures(root: Document | HTMLElement = document): void {
  root.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const head = event.target.closest('.t-acc-head'),
      item = head?.parentElement;
    if (!head || !item?.classList.contains('t-acc')) return;
    setDisclosure(item, item.getAttribute('data-open') !== 'true');
  });
}
