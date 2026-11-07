import { useEffect, useRef, useState } from "react";

/** Clipboard feedback belongs to the copied value and latest user action. */
export function useClipboardResult(value: string | null | undefined) {
  const [result, setResult] = useState<{ value: string; status: "copied" | "failed" }>();
  const pending = useRef<Promise<void> | null>(null);
  useEffect(() => {
    pending.current = null;
    setResult(undefined);
  }, [value]);
  useEffect(() => {
    if (result?.status !== "copied") return;
    const timeout = setTimeout(() => setResult(undefined), 2000);
    return () => clearTimeout(timeout);
  }, [result]);
  function copy() {
    if (!value) return;
    setResult(undefined);
    const request = (async () => { await navigator.clipboard.writeText(value); })();
    pending.current = request;
    void request.then(() => {
      if (pending.current === request) setResult({ value, status: "copied" });
    }, () => {
      if (pending.current === request) setResult({ value, status: "failed" });
    });
  }
  return { status: result && result.value === value ? result.status : "idle", copy };
}
