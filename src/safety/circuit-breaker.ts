type State = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: State = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetTimeoutMs: number,
    private readonly onOpen?: () => void,
    private readonly onClose?: () => void,
  ) {}

  canExecute(): boolean {
    if (this.state === "CLOSED") return true;

    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow one trial
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED";
      this.onClose?.();
    }
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;

    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openedAt = Date.now();
      return;
    }

    if (this.consecutiveFailures >= this.threshold && this.state === "CLOSED") {
      this.state = "OPEN";
      this.openedAt = Date.now();
      this.onOpen?.();
    }
  }

  getState(): State {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getRemainingMs(): number {
    if (this.state !== "OPEN") return 0;
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, this.resetTimeoutMs - elapsed);
  }
}
