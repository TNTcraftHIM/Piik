const DECODED_FRAME_PROOF_INTERVAL_MS = 100;

export interface DecodedFrameProofOptions {
  readFramesDecoded: () => Promise<number | null>;
  owns: () => boolean;
  requireProgress?: boolean;
  onProof: () => boolean;
}

export function observeDecodedFrameProof(
  options: DecodedFrameProofOptions,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let baseline: number | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    if (stopped || !options.owns()) {
      stop();
      return;
    }
    timer = globalThis.setTimeout(() => {
      timer = null;
      void poll();
    }, DECODED_FRAME_PROOF_INTERVAL_MS);
  };
  const poll = async (): Promise<void> => {
    if (stopped || !options.owns()) {
      stop();
      return;
    }
    try {
      const framesDecoded = await options.readFramesDecoded();
      if (stopped || !options.owns()) {
        stop();
        return;
      }
      if (
        framesDecoded !== null &&
        Number.isFinite(framesDecoded) &&
        framesDecoded >= 0
      ) {
        let proved = false;
        if (options.requireProgress) {
          if (baseline === null || framesDecoded < baseline) {
            baseline = framesDecoded;
          } else {
            proved = framesDecoded > baseline;
          }
        } else {
          proved = framesDecoded > 0;
        }
        if (proved && options.onProof()) {
          stop();
          return;
        }
      }
    } catch {
      // Proof sampling is observational; the route owner retains its deadline.
    }
    schedule();
  };

  void poll();
  return stop;
}
