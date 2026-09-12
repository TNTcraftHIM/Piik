const storageKey = 'piik:site-language';
const languages = ['en', 'zh-CN'];

export function initialLanguage() {
  const requested = new URLSearchParams(location.search).get('lang');
  if (languages.includes(requested)) return requested;
  try {
    const stored = localStorage.getItem(storageKey);
    if (languages.includes(stored)) return stored;
  } catch {
    // Restricted storage does not prevent automatic language selection.
  }
  return navigator.language?.split('-')[0]?.toLowerCase() === 'zh' ? 'zh-CN' : 'en';
}

export function rememberLanguage(language) {
  try {
    localStorage.setItem(storageKey, language);
  } catch {
    // The current page keeps its explicit choice without persistence.
  }
}
