import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { isDeferredModuleFailure } from "../lib/deferred-module-failure";

export type SettingsAction = <T>(work: (signal: AbortSignal) => Promise<T>, onSuccess?: (value: T) => void) => Promise<void>;

/** The failure code an action owner shows, or null for a cancellation. */
export function settingsActionFailure(error: unknown): string | null {
  if (error instanceof DOMException && error.name === "AbortError") return null;
  if (isDeferredModuleFailure(error)) return "deferred_module_load_failed";
  // The same failure code the session's banner would show.
  return error instanceof DOMException ? error.name : error instanceof Error ? error.message : "operation_failed";
}

/** Pending stays in Session; only this open surface, for its current owner, receives its action result. */
export function useSettingsAction(open = true, owner?: unknown): { error: string | null; run: SettingsAction; clearError(): void } {
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    lifetime.current = open ? new AbortController() : null;
    setError(null);
    return () => { lifetime.current?.abort(); lifetime.current = null; };
  }, [open, owner]);
  const run: SettingsAction = useCallback(async (work, onSuccess) => {
    const current = lifetime.current;
    if (!current) return;
    setError(null);
    try {
      const result = await work(current.signal);
      if (lifetime.current === current) onSuccess?.(result);
    } catch (error) {
      const failure = settingsActionFailure(error);
      if (lifetime.current === current && failure) setError(failure);
    }
  }, []);
  return { error, run, clearError: () => setError(null) };
}

type ActionFailure = { code: string; label?: string };

/** A surface owns keyed results; optional rows limit them to entities still present. */
export function useKeyedSettingsAction(owner: string, rows?: readonly { id: string }[]): {
  errors: ReadonlyMap<string, ActionFailure>; run(key: string, work: (reportError: () => boolean) => Promise<unknown>, label?: string): Promise<void>; clearError(key: string): void;
} {
  const [errors, setErrors] = useState<ReadonlyMap<string, ActionFailure>>(new Map());
  const lifetime = useRef<object | null>(null);
  useLayoutEffect(() => {
    lifetime.current = {};
    setErrors(new Map());
    return () => { lifetime.current = null; };
  }, [owner]);
  const liveRows = useRef(rows);
  useLayoutEffect(() => {
    liveRows.current = rows;
    if (!rows) return;
    setErrors(previous => {
      const retained = Array.from(previous).filter(([key]) => rows.some(row => row.id === key));
      return retained.length === previous.size ? previous : new Map(retained);
    });
  }, [rows]);
  const clearError = useCallback((key: string) => setErrors(previous => {
    if (!previous.has(key)) return previous;
    const next = new Map(previous);
    next.delete(key);
    return next;
  }), []);
  const run = useCallback(async (key: string, work: (reportError: () => boolean) => Promise<unknown>, label?: string) => {
    const current = lifetime.current;
    if (!current) return;
    clearError(key);
    const reportError = () => lifetime.current !== current || liveRows.current?.some(row => row.id === key) === false;
    try { await work(reportError); }
    catch (error) {
      const failure = settingsActionFailure(error);
      if (!reportError() && failure) setErrors(previous => new Map(previous).set(key, { code: failure, label }));
    }
  }, [clearError]);
  return { errors, run, clearError };
}
