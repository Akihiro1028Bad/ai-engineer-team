export class BudgetGuard {
  private dailySpent = 0;
  private dayStart = this.startOfDay();

  constructor(
    private readonly dailyLimitUsd: number | undefined,
    private readonly onBudgetReached?: () => void,
  ) {}

  canExecute(): boolean {
    if (this.dailyLimitUsd === undefined) return true;

    if (this.dailySpent >= this.dailyLimitUsd) {
      this.onBudgetReached?.();
      return false;
    }
    return true;
  }

  recordCost(usd: number): void {
    this.dailySpent += usd;
  }

  getDailySpent(): number {
    return this.dailySpent;
  }

  checkDailyReset(): void {
    const today = this.startOfDay();
    if (today > this.dayStart) {
      this.dailySpent = 0;
      this.dayStart = today;
    }
  }

  private startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
