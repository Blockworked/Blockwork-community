// Authentication mail must never use the helpdesk's development logging fallback.
import type { Env } from './index.ts';
import { hash } from './auth.ts';
import { makeFlow } from './account-security.ts';
export async function accountMail(env: Env, email: string, subject: string, text: string): Promise<boolean> {
  if (!env.SMTP2GO_API_KEY) return false;
  try {
    const res = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': env.SMTP2GO_API_KEY },
      body: JSON.stringify({ sender: `Blockworked Accounts <${env.AUTH_FROM || 'noreply@blockworked.com'}>`,
        to: [email], subject, text_body: text, custom_headers: [{header: 'Auto-Submitted', value: 'auto-generated'}] }),
    });
    if (!res.ok) return false;
    const body = await res.json<{data?: {succeeded?: number; failed?: number}}>();
    return body.data?.succeeded === 1 && body.data.failed === 0;
  } catch { return false; }
}

export async function notify(env: Env, id: string, text: string): Promise<void> {
  const row = await env.DB.prepare('SELECT email FROM email_credentials WHERE user_id = ?').bind(id).first<{email: string}>();
  if (row && !await accountMail(env, row.email, 'Blockworked account security', `${text}\n\nIf this was not you, reset your password and contact support immediately.`)) console.error('Account security notice delivery failed');
}

export async function sendAccountToken(env: Env, email: string, purpose: string, id: string | null, data: object, title: string): Promise<void> {
  const token = await makeFlow(env, purpose, id, data, purpose === 'reset' ? 1800 : 3600);
  const url = `${new URL(env.SITE_URL).origin}/auth/email/${purpose === 'reset' ? 'reset' : 'verify'}?token=${token}`;
  const sent = await accountMail(env, email, title, `${title}\n\nOpen this link to continue:\n${url}\n\nThis link expires in ${purpose === 'reset' ? '30' : '60'} minutes and works once. If you did not request it, ignore this email.`);
  if (!sent) {
    await env.DB.prepare('DELETE FROM auth_flows WHERE token_hash = ?').bind(await hash(token)).run();
    console.error('Account email delivery failed'); // Never log addresses, URLs, bodies or provider responses.
  }
}
