/** Check the HTTP response from the Domain serving this page. */
export async function currentSiteResponds(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(new URL("/healthz", location.origin), {
      mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (response.status !== 200 || !response.body) return false;
    const expected = new TextEncoder().encode("piik-channel-prototype"), reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return offset === expected.length;
        for (const byte of value) if (byte !== expected[offset++]) return false;
      }
    } finally { await reader.cancel(); }
  } catch {
    return false;
  }
}
