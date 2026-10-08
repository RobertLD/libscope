/** Helpers for running async work one item at a time or with a concurrency limit. */

/**
 * Call `fn` for each item in order. Each call starts after the previous one has resolved,
 * so use this where order matters (database writes, rate-limited APIs, git commands).
 * The first rejection stops the sequence and rejects the returned promise.
 */
export function forEachSequential<T>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Promise<unknown>,
): Promise<void> {
  return Array.from(items).reduce<Promise<void>>(
    (previous, item, index) =>
      previous.then(async () => {
        await fn(item, index);
      }),
    Promise.resolve(),
  );
}

/** Like {@link forEachSequential}, and resolves to the results in input order. */
export async function mapSequential<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  await forEachSequential(items, async (item, index) => {
    results.push(await fn(item, index));
  });
  return results;
}

/**
 * Run async tasks with at most `concurrency` in flight (worker-pool pattern).
 * Returns results in the same order as the input tasks.
 */
export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = Array.from<T>({ length: tasks.length });
  let nextIndex = 0;

  // Each worker takes the next task when its current one finishes.
  const worker = async (): Promise<void> => {
    if (nextIndex >= tasks.length) return;
    const index = nextIndex++;
    results[index] = await tasks[index]!();
    return worker();
  };

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
