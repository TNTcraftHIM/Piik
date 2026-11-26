import { useCallback, useLayoutEffect, useRef } from "react";
import { prepareIdentityImage } from "./identity-image";

/** A superseded file selection leaves the editor busy with its replacement. */
export function useIdentityImage() {
  const request = useRef<{ controller: AbortController; complete(): void } | null>(null);
  const cancel = useCallback(() => {
    const current = request.current;
    current?.controller.abort();
    current?.complete();
  }, []);
  useLayoutEffect(() => cancel, [cancel]);

  async function prepare(file: File, onImage: (image: string) => void, onError: () => void, onComplete?: () => void) {
    request.current?.controller.abort();
    const controller = new AbortController();
    const current = {
      controller,
      complete() {
        if (request.current !== current) return;
        request.current = null;
        onComplete?.();
      },
    };
    request.current = current;
    try {
      const image = await prepareIdentityImage(file, controller.signal);
      if (!controller.signal.aborted) onImage(image);
    } catch {
      if (!controller.signal.aborted) onError();
    } finally {
      current.complete();
    }
  }
  return { prepare, cancel };
}
