// One atomic authorization gate for identity changes, including concurrent requests.
import type { Env } from './index.ts';
import type { Flow, SecuritySession } from './account-security.ts';
import { SECURITY_IDLE_MS, SECURITY_MAX_MS } from './account-security.ts';
export const CHANGE_GATE = "EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND purpose = 'credential-applied')";
export interface Write { sql: string; params: (string | number | null)[] }
/** Every supplied write must include CHANGE_GATE and bind the flow hash last. */
export async function commitCredentialChange(env: Env, flow: Flow, proof: SecuritySession, condition: Write, writes: Write[], action: string, detail = ''): Promise<boolean> {
  const now = Date.now();
  const user = flow.user_id!;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE auth_flows SET purpose = 'credential-applied' WHERE token_hash = ? AND purpose = ? AND expires_at > ? AND user_id = ? AND auth_version = ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_version = ? AND banned = 0)
      AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND kind = 'web' AND expires_at > ? AND security_unlocked_at > ? AND security_last_used_at > ?)
      AND (${condition.sql})`)
      .bind(flow.token_hash, flow.purpose, now, user, proof.auth_version, user, proof.auth_version, proof.token_hash, user, now, now - SECURITY_MAX_MS, now - SECURITY_IDLE_MS, ...condition.params),
    ...writes.map(w => env.DB.prepare(w.sql).bind(...w.params, flow.token_hash)),
    env.DB.prepare(`INSERT INTO account_security_events (user_id, action, detail, created_at) SELECT ?, ?, ?, ? WHERE ${CHANGE_GATE}`).bind(user, action, detail, now, flow.token_hash),
    env.DB.prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND ${CHANGE_GATE}`).bind(user, flow.token_hash),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${CHANGE_GATE}`).bind(user, flow.token_hash),
    env.DB.prepare(`DELETE FROM app_codes WHERE user_id = ? AND ${CHANGE_GATE}`).bind(user, flow.token_hash),
    env.DB.prepare(`DELETE FROM email_changes WHERE user_id = ? AND ${CHANGE_GATE}`).bind(user, flow.token_hash),
    env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND ${CHANGE_GATE}`).bind(user, flow.token_hash),
  ]);
  return results[0].meta.changes === 1;
}
