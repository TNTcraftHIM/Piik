declare global {
  interface Window { piikNativeActive?: boolean }
}

export function isDocumentActive(doc: Document): boolean {
  return !doc.hidden && doc.hasFocus() && doc.defaultView?.piikNativeActive !== false;
}
