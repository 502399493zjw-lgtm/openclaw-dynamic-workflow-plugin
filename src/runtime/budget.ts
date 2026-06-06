export class BudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(`Budget exceeded: spent ${spent} of ${total}`);
    this.name = "BudgetExceededError";
  }
}

export type Budget = {
  total: number | null;
  spent(): number;
  remaining(): number;
  charge(tokens: number): void;
  assertCanSpend(): void;
};

export function createBudget(total: number | null): Budget {
  let used = 0;
  return {
    total,
    spent: () => used,
    remaining: () => (total === null ? Infinity : Math.max(0, total - used)),
    charge: (tokens) => {
      used += Math.max(0, tokens);
    },
    assertCanSpend: () => {
      if (total !== null && used >= total) throw new BudgetExceededError(used, total);
    },
  };
}
