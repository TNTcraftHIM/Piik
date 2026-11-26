type Sink = { setSinkId?: (device: string) => Promise<void> };
const targets = new Map<Sink, () => void>();
const events = new EventTarget();
let selected = "";
let requested: { id: string } | undefined;
const failedTargets = new Set<Sink>();
let changeFailed = false;
let deviceMissing = false;
let pending = Promise.resolve();

// Output choice and device observation live for the page; players register only their sinks.
const devices = globalThis.navigator?.mediaDevices;
devices?.addEventListener("devicechange", () => {
  pending = pending.then(async () => {
    if (!selected) return;
    const available = await devices.enumerateDevices();
    deviceMissing = !available.some(device => device.kind === "audiooutput" && device.deviceId === selected);
    if (!deviceMissing) for (const sink of [...failedTargets]) {
      if (!targets.has(sink)) continue;
      try { await sink.setSinkId!(selected); }
      catch { continue; }
      targets.get(sink)?.();
    }
    events.dispatchEvent(new Event("change"));
  }).catch(() => {});
});

export const playbackOutput = {
  get selected() { return selected; },
  get failed() { return changeFailed || deviceMissing || failedTargets.size > 0; },
  failedFor(target: HTMLMediaElement | AudioContext | null | undefined) {
    return !!target && (failedTargets.has(target as Sink) || deviceMissing && targets.has(target as Sink));
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
        deviceMissing = deviceMissing && selected === id;
        selected = id;
        changeFailed = false;
      } catch (error) {
        await Promise.all(changed.filter(sink => targets.has(sink)).map(async sink => {
          try { await sink.setSinkId!(selected); targets.get(sink)?.(); }
          catch { if (targets.has(sink)) failedTargets.add(sink); }
        }));
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
