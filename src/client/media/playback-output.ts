type Sink = { setSinkId?: (device: string) => Promise<void> };
const targets = new Map<Sink, () => void>();
const events = new EventTarget();
let selected = "";
let requested: { id: string } | undefined;
const failedTargets = new Set<Sink>();
let changeFailed = false;
let pending = Promise.resolve();

export const playbackOutput = {
  get selected() { return selected; },
  get failed() { return changeFailed || failedTargets.size > 0; },
  failedFor(target: HTMLMediaElement | AudioContext | null | undefined) {
    return !!target && failedTargets.has(target as Sink);
  },
  subscribe(listener: () => void) {
    events.addEventListener("change", listener);
    return () => events.removeEventListener("change", listener);
  },
  attach(target: HTMLMediaElement | AudioContext) {
    const sink = target as Sink;
    let resolve!: () => void;
    const ready = new Promise<void>(done => { resolve = done; });
    let waiting = !!sink.setSinkId && !!(selected || requested?.id);
    const applied = () => { waiting = false; failedTargets.delete(sink); resolve(); };
    const detach = Object.assign(() => {
      targets.delete(sink);
      const wasFailed = failedTargets.has(sink);
      applied();
      if (wasFailed) events.dispatchEvent(new Event("change"));
    }, { ready, getWaiting: () => waiting });
    if (!waiting) resolve();
    if (!sink.setSinkId) return detach;
    targets.set(sink, applied);
    pending = pending.then(async () => {
      if (selected && targets.has(sink)) await sink.setSinkId!(selected);
      applied();
    }).catch(() => { if (!targets.has(sink)) return; failedTargets.add(sink); events.dispatchEvent(new Event("change")); });
    return detach;
  },
  choose(id: string) {
    const request = requested = { id };
    const change = pending.then(async () => {
      const changed: Sink[] = [];
      try {
        for (const sink of [...targets.keys()]) {
          if (!targets.has(sink)) continue;
          try {
            await sink.setSinkId!(id);
            changed.push(sink);
          } catch (error) {
            if (targets.has(sink)) throw error;
          }
        }
        for (const sink of changed) targets.get(sink)?.();
        selected = id;
        changeFailed = false;
      } catch (error) {
        await Promise.allSettled(changed.filter(sink => targets.has(sink)).map(sink => sink.setSinkId!(selected)));
        changeFailed = true;
        throw error;
      } finally {
        if (requested === request) requested = undefined;
        events.dispatchEvent(new Event("change"));
      }
    });
    pending = change.catch(() => {});
    return change;
  }
};
