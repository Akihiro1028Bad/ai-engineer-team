function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateController {
  private lastTaskTime = 0;
  private tasksInWindow = 0;
  private windowStart = Date.now();

  constructor(
    private readonly enabled: boolean,
    private readonly cooldownMs: number,
    private readonly maxTasksPerWindow: number,
    private readonly warnThreshold: number,
    private readonly onWarn?: () => void,
  ) {}

  async waitIfNeeded(): Promise<void> {
    if (!this.enabled) return;

    let now = Date.now();

    // 5h window reset
    if (now - this.windowStart > 5 * 3_600_000) {
      this.tasksInWindow = 0;
      this.windowStart = now;
    }

    // Window limit check
    if (this.tasksInWindow >= this.maxTasksPerWindow) {
      const waitMs = this.windowStart + 5 * 3_600_000 - now;
      await sleep(waitMs);
      now = Date.now();
      this.tasksInWindow = 0;
      this.windowStart = now;
    }

    // Cooldown between tasks
    now = Date.now();
    const elapsed = now - this.lastTaskTime;
    if (this.lastTaskTime > 0 && elapsed < this.cooldownMs) {
      await sleep(this.cooldownMs - elapsed);
    }

    this.lastTaskTime = Date.now();
    this.tasksInWindow += 1;

    // Warn if approaching limit
    const remaining = this.maxTasksPerWindow - this.tasksInWindow;
    const threshold = Math.floor(this.maxTasksPerWindow * this.warnThreshold);
    if (remaining <= threshold && this.onWarn) {
      this.onWarn();
    }
  }

  getTasksInWindow(): number {
    return this.tasksInWindow;
  }

  getLastTaskTime(): number {
    return this.lastTaskTime;
  }
}
