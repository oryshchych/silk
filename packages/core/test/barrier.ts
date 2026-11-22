/**
 * Synchronisation barrier for concurrency tests. All `parties` must call
 * `wait()` before any of them continues, so "parallel" work really overlaps
 * instead of running one after another.
 */
export class Barrier {
  private waiting = 0;
  private readonly gate: Promise<void>;
  private release!: () => void;

  private readonly parties: number;

  constructor(parties: number) {
    this.parties = parties;
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async wait(): Promise<void> {
    this.waiting += 1;
    if (this.waiting >= this.parties) this.release();
    await this.gate;
  }
}
