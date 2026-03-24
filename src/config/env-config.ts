import { z } from "zod";

const EnvSchema = z
  .object({
    anthropicApiKey: z.string().optional(),
    rateControlEnabled: z.boolean(),
    rateCooldownSeconds: z.number().int().min(0).default(60),
    maxTasksPerWindow: z.number().int().min(1).default(150),
    rateLimitWarnThreshold: z.number().min(0).max(1).default(0.1),
    githubToken: z.string().min(1),
    githubRepo: z.string().regex(/^[^/]+\/[^/]+$/, "Must be in 'owner/repo' format"),
    projectDir: z.string().min(1),
    worktreeDir: z.string().min(1),
    slackWebhookUrl: z.string().url().optional(),
    dailyBudgetUsd: z.number().min(0).optional(),
    maxConcurrent: z.number().int().min(1).default(1),
    // v3.0 新規
    reposJsonPath: z.string().optional(),
    dashboardEnabled: z.boolean().default(false),
    dashboardPort: z.number().int().min(1024).max(65535).default(3100),
    toolforgeEnabled: z.boolean().default(false),
    dryRunDefault: z.boolean().default(false),
    explorationRate: z.number().min(0).max(1).default(0.1),
  })
  .refine(
    (data) => !(data.anthropicApiKey && data.rateControlEnabled),
    {
      message:
        "ANTHROPIC_API_KEY と RATE_CONTROL_ENABLED=true を同時に設定できません。Max プランでは ANTHROPIC_API_KEY を設定しないでください。",
      path: ["anthropicApiKey"],
    },
  );

export type EnvConfig = z.infer<typeof EnvSchema>;

type LoadResult =
  | { success: true; data: EnvConfig }
  | { success: false; error: string };

export function loadConfig(): LoadResult {
  const env = process.env;

  const raw = {
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    rateControlEnabled: env["RATE_CONTROL_ENABLED"] === "true",
    rateCooldownSeconds: env["RATE_COOLDOWN_SECONDS"] ? Number(env["RATE_COOLDOWN_SECONDS"]) : undefined,
    maxTasksPerWindow: env["MAX_TASKS_PER_WINDOW"] ? Number(env["MAX_TASKS_PER_WINDOW"]) : undefined,
    rateLimitWarnThreshold: env["RATE_LIMIT_WARN_THRESHOLD"]
      ? Number(env["RATE_LIMIT_WARN_THRESHOLD"])
      : undefined,
    githubToken: env["GITHUB_TOKEN"],
    githubRepo: env["GITHUB_REPO"],
    projectDir: env["PROJECT_DIR"],
    worktreeDir: env["WORKTREE_DIR"],
    slackWebhookUrl: env["SLACK_WEBHOOK_URL"] || undefined,
    dailyBudgetUsd: env["DAILY_BUDGET_USD"] ? Number(env["DAILY_BUDGET_USD"]) : undefined,
    maxConcurrent: env["MAX_CONCURRENT"] ? Number(env["MAX_CONCURRENT"]) : undefined,
    // v3.0 新規
    reposJsonPath: env["REPOS_JSON_PATH"] || undefined,
    dashboardEnabled: env["DASHBOARD_ENABLED"] === "true",
    dashboardPort: env["DASHBOARD_PORT"] ? Number(env["DASHBOARD_PORT"]) : undefined,
    toolforgeEnabled: env["TOOLFORGE_ENABLED"] === "true",
    dryRunDefault: env["DRY_RUN_DEFAULT"] === "true",
    explorationRate: env["EXPLORATION_RATE"] ? Number(env["EXPLORATION_RATE"]) : undefined,
  };

  const result = EnvSchema.safeParse(raw);

  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { success: false, error: messages.join("; ") };
  }

  return { success: true, data: result.data };
}
