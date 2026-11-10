import type { Env } from './index.ts';
import { type User, cookie, logout } from './auth.ts';
import { accountPage, settingsPage } from './account-views.ts';
import { boundedBody, flowCookie, issueSession, limit, makeFlow, readFlow, redirect, securitySession } from './account-security.ts';
import { accountMail } from './account-mail.ts';
import { CHANGE_GATE, commitCredentialChange, type Write } from './credential-change.ts';

export async function cleanupAccountObjects(env: Env): Promise<void> {
  const {results} = await env.DB.prepare('SELECT object_key FROM account_cleanup_objects LIMIT 100').all<{object_key:string}>();
  for (const row of results) {
    try { await env.PACKS.delete(row.object_key); await env.DB.prepare('DELETE FROM account_cleanup_objects WHERE object_key = ?').bind(row.object_key).run(); }
    catch { console.error('Account file cleanup will be retried'); }
  }
}
export async function lifecycleRoute(req: Request, env: Env, user: User | null, ctx?: Pick<ExecutionContext,'waitUntil'>): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === '/account/reactivate') {
    const token = cookie(req,'__Host-reactivation') ?? '', flow = await readFlow(env,token,'reactivate');
    const fail = () => accountPage(null,env,'Reactivate account','<p>Sign in again to confirm reactivation.</p><a href="/login">Sign in</a>',401);
    if (!flow?.user_id) return fail();
    if (req.method === 'GET') return accountPage(null,env,'Reactivate account','<p>Your account is deactivated. Reactivating restores your profile and sign-in access.</p><form method="post"><button>Reactivate my account</button></form>');
    if (req.method !== 'POST') return new Response('Method not allowed',{status:405});
    const data = JSON.parse(flow.data), now = Date.now();
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE auth_flows SET purpose = 'reactivation-applied' WHERE token_hash = ? AND purpose = 'reactivate' AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = auth_flows.user_id AND auth_version = auth_flows.auth_version AND banned = 0 AND deleted_at = 0 AND deactivated_at > 0)`)
        .bind(flow.token_hash,now),
      env.DB.prepare(`UPDATE users SET deactivated_at = 0, auth_version = auth_version + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND purpose = 'reactivation-applied')`).bind(flow.user_id,flow.token_hash),
      env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND purpose = 'reactivation-applied')`).bind(flow.user_id,flow.token_hash),
    ]);
    if (result[0].meta.changes !== 1) return fail();
    const response = await issueSession(env,flow.user_id,flow.auth_version+1,data.strength,'/account/profile');
    response.headers.append('Set-Cookie',flowCookie('',0,'__Host-reactivation'));
    return response;
  }
  if (!user) return redirect('/login?next=%2Faccount%2Fsecurity');
  const proof = await securitySession(req,env,user);
  if (!proof || proof.auth_strength === 'recovery') return redirect('/account/unlock');
  if (req.method === 'GET') return settingsPage(user,env,'Security',`<section class="card"><h3>Deactivate account</h3><p>Hide your profile, packs and comments and sign out every browser and app. Your username and credentials stay reserved. Sign in with your usual credentials and MFA to reactivate.</p><form method="post" action="/account/lifecycle/deactivate"><label><input type="checkbox" name="confirm" value="yes" required> Deactivate my account</label><p><button>Confirm deactivation</button></p></form></section>
    <section class="card"><h3>Delete account permanently</h3><p>This removes your sign-in methods, email, profile picture and profile information, removes your comments, and hides your packs. Your support ticket contents and attachments are removed; minimal ownership records and security audit history remain. Copies already downloaded or in backups cannot be recalled. This cannot be undone.</p><form method="post" action="/account/lifecycle/delete"><p><label>Type DELETE to confirm<br><input type="text" name="confirm" required pattern="DELETE" autocomplete="off"></label></p><button>Delete my account permanently</button></form></section>`);
  if (req.method !== 'POST') return new Response('Method not allowed',{status:405});
  if (!await limit(env,'account-lifecycle',user.id,5,3600)) return new Response('Too many attempts',{status:429});
  const body = await boundedBody(req,2000), deleting = path === '/account/lifecycle/delete';
  if ((!deleting && path !== '/account/lifecycle/deactivate') || body.confirm !== (deleting ? 'DELETE' : 'yes')) return new Response('Confirm the account action first.',{status:400});
  const token = await makeFlow(env,'account-lifecycle',user.id,{},600,proof.auth_version), flow = await readFlow(env,token,'account-lifecycle');
  if (!flow) return new Response('Confirmation expired.',{status:400});
  const address = await env.DB.prepare('SELECT email FROM email_credentials WHERE user_id = ?').bind(user.id).first<{email:string}>();
  const now = Date.now(), writes: Write[] = [];
  const write = (sql:string, params:(string|number|null)[]) => writes.push({sql:sql + ` AND ${CHANGE_GATE}`,params});
  if (deleting) {
    writes.push({sql:`INSERT OR IGNORE INTO account_cleanup_objects (object_key) SELECT 'support/' || a.id FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id WHERE (m.user_id = ? OR m.ticket_id IN (SELECT id FROM tickets WHERE user_id = ?)) AND ${CHANGE_GATE}`,params:[user.id,user.id]});
    write('DELETE FROM ticket_attachments WHERE message_id IN (SELECT id FROM ticket_messages WHERE user_id = ? OR ticket_id IN (SELECT id FROM tickets WHERE user_id = ?))',[user.id,user.id]);
    write("UPDATE ticket_messages SET body = '[Removed with account deletion]', email_id = NULL WHERE (user_id = ? OR ticket_id IN (SELECT id FROM tickets WHERE user_id = ?))",[user.id,user.id]);
    write("UPDATE tickets SET email = '', name = 'Deleted account', status = 'closed', subject = 'Deleted account ticket', access_key = lower(hex(randomblob(32))) WHERE user_id = ?",[user.id]);
    write("UPDATE support_recovery_audit SET reason = '[Account deleted]' WHERE (actor_id = ? OR target_id = ?)",[user.id,user.id]);
    write("UPDATE comments SET body = '[Removed]', deleted_at = ? WHERE user_id = ?",[now,user.id]);
    write('UPDATE packs SET listed = 0 WHERE owner_id = ?',[user.id]);
    for (const table of ['email_credentials','oauth_identities','passkeys','totp_credentials','backup_codes','profile_pictures','account_security_events']) write(`DELETE FROM ${table} WHERE user_id = ?`,[user.id]);
    write("UPDATE users SET name = 'Deleted account', avatar = '', support_email = NULL, username = NULL, username_changed_at = ?, banned = 1, deleted_at = ?, deactivated_at = ? WHERE id = ?",[now,now,now,user.id]);
  } else write('UPDATE users SET deactivated_at = ? WHERE id = ?',[now,user.id]);
  const applied = await commitCredentialChange(env,flow,proof,{sql:'EXISTS (SELECT 1 FROM users WHERE id = ? AND deactivated_at = 0 AND deleted_at = 0)',params:[user.id]},writes,deleting ? 'account_deleted' : 'account_deactivated');
  if (!applied) return new Response('The account changed. Sign in and try again.',{status:409});
  if (address) {
    const notice = accountMail(env,address.email,'Blockworked account ' + (deleting ? 'deleted' : 'deactivated'), deleting ? 'Your Blockworked account was deleted. If you did not request this, contact support.' : 'Your Blockworked account was deactivated. Sign in with your normal credentials and MFA to reactivate. If you did not request this, contact support.');
    if (ctx) ctx.waitUntil(notice); else await notice;
  }
  if (deleting) { const cleanup = cleanupAccountObjects(env); if (ctx) ctx.waitUntil(cleanup); else await cleanup; }
  return logout(req,env,'/login');
}
