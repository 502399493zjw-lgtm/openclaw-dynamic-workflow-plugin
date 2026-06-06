import { describe, it, expect } from "vitest";
import { createBudget, BudgetExceededError } from "./budget.js";

describe("createBudget", () => {
  it("tracks spend and remaining", () => {
    const b = createBudget(1000);
    b.charge(300);
    expect(b.spent()).toBe(300);
    expect(b.remaining()).toBe(700);
  });

  it("throws once the ceiling is reached (hard, not advisory)", () => {
    const b = createBudget(1000);
    b.charge(600);
    b.assertCanSpend(); // still ok
    b.charge(600); // now over
    expect(() => b.assertCanSpend()).toThrow(BudgetExceededError);
  });

  it("treats a null total as unlimited", () => {
    const b = createBudget(null);
    b.charge(10_000_000);
    expect(() => b.assertCanSpend()).not.toThrow();
    expect(b.remaining()).toBe(Infinity);
  });
});
