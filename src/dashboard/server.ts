import { createServer } from "node:http";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import type pino from "pino";
import type Database from "better-sqlite3";

import type { StatusEmitter, TaskEvent } from "../execution/status-emitter.js";

interface DashboardConfig {
  port: number;
  /** 静的ファイルの配信ディレクトリ（dashboard/dist） */
  staticDir?: string;
}

/**
 * リアルタイムダッシュボード。
 * - REST API: /api/tasks, /api/plans, /api/eval, /api/status
 * - SSE: /api/events（リアルタイム更新）
 * - 静的ファイル: dashboard/dist（React SPA）
 */
export class DashboardServer {
  private readonly sseClients = new Set<{
    write: (data: string) => boolean;
    end: () => void;
  }>();

  constructor(
    private readonly db: Database.Database,
    private readonly statusEmitter: StatusEmitter,
    private readonly config: DashboardConfig,
    private readonly logger: pino.Logger,
  ) {
    // SSE: ステータスイベントを全クライアントに配信
    this.statusEmitter.onStatus((event: TaskEvent) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of this.sseClients) {
        try {
          client.write(data);
        } catch {
          this.sseClients.delete(client);
        }
      }
    });
  }

  /** Dashboard サーバーを起動する */
  start(): void {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${this.config.port}`);
      const path = url.pathname;

      // CORS ヘッダー
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        if (path === "/api/events") {
          this.handleSSE(res);
        } else if (path === "/api/tasks") {
          this.handleTasks(res);
        } else if (path === "/api/plans") {
          this.handlePlans(res);
        } else if (path === "/api/eval") {
          this.handleEval(res);
        } else if (path === "/api/status") {
          this.handleStatus(res);
        } else {
          this.handleStatic(path, res);
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Internal error";
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        this.logger.warn({ port: this.config.port }, "Dashboard port already in use — dashboard disabled");
      } else {
        this.logger.error({ error: err.message }, "Dashboard server error");
      }
    });

    server.listen(this.config.port, () => {
      this.logger.info({ port: this.config.port }, "Dashboard server started");
    });
  }

  /** SSE エンドポイント */
  private handleSSE(res: import("node:http").ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const client = {
      write: (data: string) => res.write(data),
      end: () => res.end(),
    };
    this.sseClients.add(client);

    res.on("close", () => {
      this.sseClients.delete(client);
    });

    // 初回接続時にヘルスチェック送信
    res.write("data: {\"type\":\"connected\"}\n\n");
  }

  /** タスク一覧 API */
  private handleTasks(res: import("node:http").ServerResponse): void {
    const tasks = this.db.prepare(`
      SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100
    `).all();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks }));
  }

  /** 実行計画一覧 API */
  private handlePlans(res: import("node:http").ServerResponse): void {
    try {
      const plans = this.db.prepare(`
        SELECT * FROM execution_plans ORDER BY created_at DESC LIMIT 50
      `).all();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ plans }));
    } catch {
      // テーブルがまだ存在しない場合
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ plans: [] }));
    }
  }

  /** Eval 統計 API */
  private handleEval(res: import("node:http").ServerResponse): void {
    try {
      const summary = this.db.prepare(`
        SELECT
          agent_role,
          model,
          COUNT(*) as total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
          ROUND(AVG(cost_usd), 3) as avg_cost,
          ROUND(AVG(duration_ms), 0) as avg_duration,
          ROUND(AVG(quality_score), 1) as avg_quality
        FROM eval_records
        GROUP BY agent_role, model
        ORDER BY agent_role, model
      `).all();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ summary }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ summary: [] }));
    }
  }

  /** システムステータス API */
  private handleStatus(res: import("node:http").ServerResponse): void {
    const taskCounts = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status
    `).all() as { status: string; count: number }[];

    const statusMap: Record<string, number> = {};
    for (const row of taskCounts) {
      statusMap[row.status] = row.count;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "running",
      sseClients: this.sseClients.size,
      tasks: statusMap,
      timestamp: new Date().toISOString(),
    }));
  }

  /** 静的ファイル配信 */
  private handleStatic(path: string, res: import("node:http").ServerResponse): void {
    const staticDir = this.config.staticDir;
    if (!staticDir) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>AI Agent Dashboard</h1><p>React SPA not built yet. Use <code>npm run build:dashboard</code></p></body></html>");
      return;
    }

    const filePath = path === "/" ? join(staticDir, "index.html") : join(staticDir, path);
    if (!existsSync(filePath)) {
      // SPA fallback
      const indexPath = join(staticDir, "index.html");
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
      return;
    }

    const ext = filePath.split(".").pop() ?? "";
    const contentTypes: Record<string, string> = {
      html: "text/html",
      js: "application/javascript",
      css: "text/css",
      json: "application/json",
      png: "image/png",
      svg: "image/svg+xml",
    };

    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
    res.end(content);
  }
}
