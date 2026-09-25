// Closing a PeerConnection may leave its operations-chain promises pending.
// The connection owner cancels its waits; late results cannot resume its work.
// https://www.w3.org/TR/webrtc/#dfn-chain-an-asynchronous-operation
export async function waitForConnectionOperation<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), stopped]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
