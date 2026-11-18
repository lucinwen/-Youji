import { vi } from "vitest";

/** Deterministic Web Locks scheduler for jsdom, not evidence of native browser locking. */
export function installManualDraftLocks() {
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn((name: string, options: LockOptions, callback: (lock: Lock) => unknown) => {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const prior = tails.get(name) ?? Promise.resolve();
    const task = prior.then(() => {
      signal?.throwIfAborted();
      return callback({ name, mode: options.mode ?? "exclusive" } as Lock);
    });
    tails.set(
      name,
      task.then(
        () => {},
        () => {},
      ),
    );
    if (!signal) return task;
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    return Promise.race([task, aborted]).finally(() => signal.removeEventListener("abort", abort));
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return {
    request,
    restore: () => {
      if (previous) Object.defineProperty(navigator, "locks", previous);
      else Reflect.deleteProperty(navigator, "locks");
    },
  };
}
