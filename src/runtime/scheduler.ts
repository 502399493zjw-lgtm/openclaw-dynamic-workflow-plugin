export type Scheduler = { schedule<T>(fn: () => Promise<T>): Promise<T> };

export function createScheduler(opts: { limit: number }): Scheduler {
  const limit = Math.max(1, opts.limit);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) run();
  };

  return {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const run = () => {
          active += 1;
          fn().then(resolve, reject).finally(() => {
            active -= 1;
            next();
          });
        };
        queue.push(run);
        next();
      });
    },
  };
}
