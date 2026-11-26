import { useLayoutEffect, useRef } from "react";
import { prepareIdentityImage } from "./identity-image";

/** Only the current file selection can complete an editor's image preparation. */
export function useIdentityImage() {
  const request = useRef<AbortController | null>(null);
  const cancel = () => request.current?.abort();
  useLayoutEffect(() => () => request.current?.abort(), []);

  async function prepare(file: File, onImage: (image: string) => void, onError: () => void, onComplete?: () => void) {
    cancel();
    const current = new AbortController();
    request.current = current;
    try {
      const image = await prepareIdentityImage(file, current.signal);
      if (!current.signal.aborted) onImage(image);
    } catch {
      if (!current.signal.aborted) onError();
    } finally {
      if (!current.signal.aborted) {
        request.current = null;
        onComplete?.();
      }
    }
  }
  return { prepare, cancel };
}
