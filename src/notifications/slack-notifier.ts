import type { SlackNotification } from "../types.js";

const LEVEL_COLORS = {
  info: "#36a64f",
  warn: "#ff9900",
  error: "#cc0000",
} as const;

interface SlackField {
  title: string;
  value: string;
  short: boolean;
}

interface SlackPayload {
  attachments: {
    color: string;
    title: string;
    text: string;
    fields: SlackField[];
    ts: string;
  }[];
}

export class SlackNotifier {
  constructor(private readonly webhookUrl: string | undefined) {}

  async send(notification: SlackNotification): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const color = LEVEL_COLORS[notification.level];
    const fields: SlackField[] = Object.entries(notification.fields).map(
      ([key, value]) => ({ title: key, value, short: true }),
    );

    const payload: SlackPayload = {
      attachments: [
        {
          color,
          title: notification.title,
          text: notification.body,
          fields,
          ts: String(Math.floor(new Date(notification.timestamp).getTime() / 1000)),
        },
      ],
    };

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // Log error but don't throw
      }
    } catch (_error: unknown) {
      // Network error — log but don't throw
    }
  }
}
