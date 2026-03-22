import type { TaskQueue } from "../queue/task-queue.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export class CronScheduler {
  constructor(private readonly queue: TaskQueue) {}

  checkAndCreateTasks(now: Date): void {
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon
    const mmdd = `${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;

    // Nightly review at 03:00
    if (hour === 3) {
      const id = `cron-review-${mmdd}`;
      const source = `cron:nightly_review:${mmdd}`;
      if (!this.queue.isDuplicate(source)) {
        this.queue.push({
          id,
          taskType: "review",
          title: "Nightly code review",
          description: "src/ 配下のコード品質レビューを実行する",
          source,
          priority: 5,
          dependsOn: null,
          parentTaskId: null,
        });
      }
    }

    // Weekly docs sync on Monday 09:00
    if (dayOfWeek === 1 && hour === 9) {
      const id = `cron-document-${mmdd}`;
      const source = `cron:weekly_docs:${mmdd}`;
      if (!this.queue.isDuplicate(source)) {
        this.queue.push({
          id,
          taskType: "document",
          title: "Weekly documentation sync",
          description: "ドキュメントとソースの整合性をチェックし更新する",
          source,
          priority: 7,
          dependsOn: null,
          parentTaskId: null,
        });
      }
    }
  }
}
