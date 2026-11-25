declare global {
  interface Window { piikNativeActive?: boolean }
}

export function isDocumentActive(doc: Document): boolean {
  return !doc.hidden && doc.hasFocus() && doc.defaultView?.piikNativeActive !== false;
}

export function onDocumentInactive(doc: Document, release: () => void): () => void {
  const view = doc.defaultView;
  const changed = () => { if (doc.hidden || view?.piikNativeActive === false) release(); };
  view?.addEventListener("blur", release);
  view?.addEventListener("piik-window-activity", changed);
  doc.addEventListener("visibilitychange", changed);
  return () => {
    view?.removeEventListener("blur", release);
    view?.removeEventListener("piik-window-activity", changed);
    doc.removeEventListener("visibilitychange", changed);
  };
}
