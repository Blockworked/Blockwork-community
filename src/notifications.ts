import type { Env } from "./index.ts";
import { sendMail, type Outgoing } from "./support-mail.ts";

/** Each channel is independent: a delivery failure must not reject a submission. */
export async function notify(env: Env, notice: { title: string; text: string; url: string; attachments?: Outgoing["attachments"] }): Promise<void> {
  const post = async (channel: string, url: string, body: unknown, headers: Record<string, string> = {}) => {
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!response.ok) console.error(`${channel} notification failed: ${response.status}`);
    } catch { console.error(`${channel} notification failed`); }
  };
  await Promise.all([
    sendMail(env, { to: (env.SUPPORT_NOTIFY ?? "").split(",").map(s => s.trim()).filter(Boolean), subject: notice.title, text: `${notice.text}\n\nReview and answer here:\n${notice.url}`, automated: true, attachments: notice.attachments }),
    env.NTFY_TOPIC ? post("ntfy", env.NTFY_URL || "https://ntfy.sh", { topic: env.NTFY_TOPIC, title: notice.title.slice(0, 200), message: notice.text.slice(0, 3000), click: notice.url }, env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}) : Promise.resolve(),
    env.DISCORD_WEBHOOK_URL ? post("Discord", env.DISCORD_WEBHOOK_URL, { content: `${notice.title}\n${notice.text}`.slice(0, 2000 - notice.url.length) + `\n${notice.url}`, allowed_mentions: { parse: [] } }) : Promise.resolve(),
  ]);
}
