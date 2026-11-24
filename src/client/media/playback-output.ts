type Sink = { setSinkId?: (device: string) => Promise<void> };
const targets = new Set<Sink>();
const events = new EventTarget();
let selected = "";
let failed = false;
let pending = Promise.resolve();

export const playbackOutput = {
  get selected() { return selected; },
  get failed() { return failed; },
  subscribe(listener: () => void) {
    events.addEventListener("change", listener);
    return () => events.removeEventListener("change", listener);
  },
  attach(target: HTMLMediaElement | AudioContext) {
    const sink = target as Sink;
    if (!sink.setSinkId) return () => {};
    targets.add(sink);
    pending = pending.then(async () => {
      if (selected && targets.has(sink)) await sink.setSinkId!(selected);
    }).catch(() => { if (!targets.has(sink)) return; failed = true; events.dispatchEvent(new Event("change")); });
    return () => { targets.delete(sink); };
  },
  choose(id: string) {
    const change = pending.then(async () => {
      const changed: Sink[] = [];
      try {
        for (const sink of targets) {
          try {
            await sink.setSinkId!(id);
            changed.push(sink);
          } catch (error) {
            if (targets.has(sink)) throw error;
          }
        }
        selected = id;
        failed = false;
      } catch (error) {
        await Promise.allSettled(changed.filter(sink => targets.has(sink)).map(sink => sink.setSinkId!(selected)));
        failed = true;
        throw error;
      } finally {
        events.dispatchEvent(new Event("change"));
      }
    });
    pending = change.catch(() => {});
    return change;
  }
};
