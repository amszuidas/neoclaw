/** Simple async FIFO mutex — at most one holder at a time, waiters served in order. */
export class Mutex {
  private _waiters: Array<() => void> = [];
  private _held = false;

  async acquire(): Promise<void> {
    if (!this._held) {
      this._held = true;
      return;
    }
    return new Promise<void>((resolve) => this._waiters.push(resolve));
  }

  release(): void {
    const next = this._waiters.shift();
    if (next) {
      next();
    } else {
      this._held = false;
    }
  }
}
