const DECODED_FRAME_PROOF_INTERVAL_MS = 100;

export interface DecodedFrameProofOptions {
  readFramesDecoded: () => Promise<ReadonlyArray<{ id: string; framesDecoded: number | null }>>;
  owns: () => boolean;
  baseline?: ReadonlyMap<string, number | null> | null;
  requireProgress?: boolean;
  onProof: () => boolean;
}

export function observeDecodedFrameProof(
  options: DecodedFrameProofOptions,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let captureBaseline = options.requireProgress === true;
  const baselines = new Map(captureBaseline ? undefined : options.baseline ?? undefined);

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
      const samples = await options.readFramesDecoded();
      if (stopped || !options.owns()) {
        stop();
        return;
      }
      for (const { id, framesDecoded } of samples) {
        if (framesDecoded === null || !Number.isFinite(framesDecoded) || framesDecoded < 0) {
          if (!baselines.has(id)) baselines.set(id, null);
          continue;
        }
        const before = baselines.get(id);
        const baseline = before === undefined && !captureBaseline ? 0 : before;
        if (baseline == null || framesDecoded < baseline) {
          baselines.set(id, framesDecoded);
          continue;
        }
        const proved = framesDecoded > baseline;
        if (proved && options.onProof()) {
          stop();
          return;
        }
      }
      captureBaseline = false;
    } catch {
      // Proof sampling is observational; the route owner retains its deadline.
    }
    schedule();
  };

  void poll();
  return stop;
}
