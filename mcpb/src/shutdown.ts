// One guarded exit path for the process.
//
// The cache write lock is released in a `finally` (cacheLock.ts), so any exit
// that skips the cleanup of a download in progress leaves the lock behind.
// Every way out therefore goes through here: it runs the cleanup once (signals
// and stdin EOF can arrive together), and a hard deadline, unref'd so it never
// keeps an otherwise finished process alive, bounds a cleanup that hangs.

/**
 * Build an idempotent shutdown: the first call runs `cleanup` and exits when it
 * settles or after `deadlineMs`, whichever comes first; later calls do nothing.
 */
export function guardedShutdown(cleanup: () => Promise<unknown>, deadlineMs: number): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    setTimeout(() => process.exit(0), deadlineMs).unref();
    void cleanup()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
}

/** Wait for `work`, but no longer than `ms`. */
export function within(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
