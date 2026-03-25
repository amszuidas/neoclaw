/** Create a debounced flush function that coalesces rapid calls into one delayed execution. */
export function createDebouncedFlush(fn: () => void, delayMs: number): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      fn();
    }, delayMs);
  };
}
