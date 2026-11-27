import type { RemoteInputEvent } from "./input-session";

// Virtual keys share the physical-key path. Each contact owns its chord until
// release; the session combines keys held by different contacts and devices.
export class RemoteKeyboardPresses {
  private held = new Map<number, { codes: readonly string[]; source: symbol; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly input: (event: RemoteInputEvent) => void) {}

  down(id: number, codes: readonly string[], repeating = true): void {
    this.up(id);
    const source = Symbol();
    const repeat = () => {
      const press = this.held.get(id);
      if (!press) return;
      this.input({ type: "key", code: codes[codes.length - 1], down: true, source, repeat: true });
      press.timer = setTimeout(repeat, 50);
    };
    this.held.set(id, { codes, source, timer: repeating ? setTimeout(repeat, 400) : undefined });
    for (const code of codes) this.input({ type: "key", code, down: true, source });
  }

  up(id: number): void {
    const press = this.held.get(id);
    if (!press) return;
    clearTimeout(press.timer);
    this.held.delete(id);
    for (const code of [...press.codes].reverse()) {
      this.input({ type: "key", code, down: false, source: press.source });
    }
  }

  tap(codes: readonly string[]): void {
    this.down(-1, codes); this.up(-1);
  }

  reset(): void {
    for (const id of this.held.keys()) this.up(id);
  }
}
