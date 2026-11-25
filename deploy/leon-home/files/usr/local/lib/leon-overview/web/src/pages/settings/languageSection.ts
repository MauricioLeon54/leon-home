import { h } from '../../core/dom.js';
import { type Language, language, LANGUAGES, setLanguage, t } from '../../i18n/index.js';
import { section } from '../../ui/section.js';
import { createSegmented } from '../../ui/segmented.js';
import { showToast } from '../../ui/toast.js';

/** Language names stay in their own language, so anyone can find theirs. */
export function languageSection(): HTMLElement {
  const picker = createSegmented<Language>({
    label: t('Language'),
    options: (Object.keys(LANGUAGES) as Array<Language>).map(value => ({ value, label: LANGUAGES[value] })),
    value: language,
    onChange: next => {
      if (setLanguage(next)) return;
      picker.setValue(language);
      showToast('refused', t('This device cannot save the language'));
    },
  });
  return section({ title: t('Language') }, [picker.element, h('p', { className: 'note', text: t('Only on this device. Other phones keep their own language.') })]);
}
