export type ContextSyncStatus = "pending" | "shared" | "failed";

interface Snapshot<T> {
  key: string | undefined;
  value: T;
  settled: boolean;
}

interface Flight<T> {
  snapshot: Snapshot<T>;
  controller: AbortController;
}

/** Serializes context updates and keeps only the newest requested snapshot.
 * Values must be JSON-serializable and should remain immutable after publish.
 * A failed snapshot stays settled until the caller publishes different content.
 * The sender owns its timeout; stop aborts any outstanding send. */
export class ContextSync<T> {
  private wanted?: Snapshot<T>;
  private flight?: Flight<T>;
  private status?: ContextSyncStatus;
  private stopped = false;

  constructor(
    private readonly send: (value: T, signal: AbortSignal) => Promise<void>,
    private readonly onStatus: (status: ContextSyncStatus) => void,
  ) {}

  publish(value: T): void {
    if (this.stopped) return;
    const key = JSON.stringify(value);
    if (this.wanted && this.wanted.key === key) return;
    this.wanted = { key, value, settled: false };
    this.report("pending");
    this.drain();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.wanted = undefined;
    this.flight?.controller.abort();
  }

  private report(status: ContextSyncStatus): void {
    if (this.stopped || this.status === status) return;
    // Commit before invoking application code: a callback may publish or stop.
    this.status = status;
    try {
      this.onStatus(status);
    } catch {
      // Rendering/status failures must not break the publication queue or
      // turn an otherwise handled send rejection into an unhandled promise.
    }
  }

  private drain(): void {
    if (this.stopped || this.flight || !this.wanted || this.wanted.settled) return;
    const flight = { snapshot: this.wanted, controller: new AbortController() };
    this.flight = flight;
    void this.dispatch(flight);
  }

  private async dispatch(flight: Flight<T>): Promise<void> {
    let status: "shared" | "failed" = "shared";
    try {
      await this.send(flight.snapshot.value, flight.controller.signal);
    } catch {
      status = "failed";
      // Even a synchronously throwing sender must yield before notifying.
      // Otherwise a failed-status callback publishing new work could recurse
      // straight back into another synchronous failure on the same stack.
      await Promise.resolve();
    }
    this.flight = undefined;
    if (this.stopped) return;
    const wanted = this.wanted;
    if (wanted && wanted.key === flight.snapshot.key) {
      // A -> B -> A while A is in flight discards B: this completed A is
      // already the requested context, so another identical send is needless.
      wanted.settled = true;
      this.report(status);
    }
    // A stale completion cannot report success/failure for a newer selection.
    // The latest snapshot is sent only after the previous send has settled.
    this.drain();
  }
}
