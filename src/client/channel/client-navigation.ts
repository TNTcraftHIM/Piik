import { useEffect, useState } from "react";

/** Admission removes invite from the address bar; only this page's memory retains it. */
export function useClientNavigationTarget(roomId: string): string {
  const [enteredURL, setEnteredURL] = useState(() => incomingClientURL(location.href).href);
  useEffect(() => {
    const changed = () => setEnteredURL(incomingClientURL(location.href).href);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return clientNavigationTarget(enteredURL, roomId);
}

export function clientNavigationTarget(enteredURL: string, roomId: string): string {
  const url = incomingClientURL(enteredURL);
  if (roomId && new URLSearchParams(url.hash.slice(1)).get("room") === roomId) return url.href;
  url.hash = roomId ? new URLSearchParams({ room: roomId }).toString() : "";
  return url.href;
}

function incomingClientURL(value: string): URL {
  const url = new URL(value);
  const incoming = new URLSearchParams(url.hash.slice(1));
  const hash = new URLSearchParams();
  for (const key of ["room", "invite"]) {
    const value = incoming.get(key);
    if (value) hash.set(key, value);
  }
  url.hash = hash.toString();
  return url;
}

export function clientNavigationURL(managementURL: string, targetURL: string): string {
  const url = new URL(managementURL);
  url.hash = new URLSearchParams({ open: targetURL }).toString();
  return url.href;
}
