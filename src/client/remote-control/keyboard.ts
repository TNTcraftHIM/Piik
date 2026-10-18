import type { RemoteInputEvent } from "./input-session";

// Virtual keys share the physical-key path. Each contact owns its chord until
// release; another finger must not release a modifier that is still in use.
export class RemoteKeyboardPresses {
  private held = new Map<number, { codes: readonly string[]; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly input: (event: RemoteInputEvent) => void) {}

  down(id: number, codes: readonly string[], repeating = true): void {
    this.up(id);
    for (const code of codes) {
      if (!this.pressed(code)) this.input({ type: "key", code, down: true });
    }
    const repeat = () => {
      const press = this.held.get(id);
      if (!press) return;
      this.input({ type: "key", code: codes[codes.length - 1], down: true });
      press.timer = setTimeout(repeat, 50);
    };
    this.held.set(id, { codes, timer: repeating ? setTimeout(repeat, 400) : undefined });
  }

  up(id: number): void {
    const press = this.held.get(id);
    if (!press) return;
    clearTimeout(press.timer);
    this.held.delete(id);
    for (const code of [...press.codes].reverse()) {
      if (!this.pressed(code)) this.input({ type: "key", code, down: false });
    }
  }

  tap(codes: readonly string[]): void {
    this.down(-1, codes); this.up(-1);
  }

  reset(): void {
    for (const id of this.held.keys()) this.up(id);
  }

  private pressed(code: string): boolean {
    return [...this.held.values()].some(press => press.codes.includes(code));
  }
}
