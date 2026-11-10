import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture,cookieOf } from './helpers/accounts.ts';
import { issueSession,finishPrimary,makeFlow } from '../src/account-security.ts';
import { currentUser, hash } from '../src/auth.ts';
import { authorPage, authorLink, published } from '../src/browse.ts';
import { supportRoute,addMessage } from '../src/support.ts';

async function owner(f:ReturnType<typeof fixture>, next='/account/security') {
  f.sql.prepare("INSERT INTO users(id,name,created_at,public_id,username) VALUES('local:owner','Owner',1,'abcdef123456','owner')").run();
  const session=cookieOf(await issueSession(f.env,'local:owner',0,'primary',next));
  const user=(await currentUser(new Request(f.env.SITE_URL,{headers:{Cookie:session}}),f.env))!;
  return {session,user};
}
function content(f:ReturnType<typeof fixture>) {
  f.sql.exec(`INSERT INTO packs(id,owner_id,created_at) VALUES('pack','local:owner',1);
    INSERT INTO versions(pack_id,sha256,name,description,version,blocks,capabilities,status,submitted_by,submitted_at) VALUES('pack','abc','Pack','Description','1','[]','[]','approved','local:owner',1);
    INSERT INTO comments(pack_id,user_id,body,created_at) VALUES('pack','local:owner','Personal comment',1);
    INSERT INTO tickets(subject,email,name,user_id,access_key,created_at,updated_at) VALUES('Private question','owner@example.com','Owner','local:owner','old-key',1,1);
    INSERT INTO ticket_messages(ticket_id,kind,user_id,body,created_at) VALUES(1,'requester','local:owner','Private message',1);
    INSERT INTO ticket_attachments(id,message_id,name,type,size) VALUES('image-id',1,'private.png','image/png',10);`);
}
test('username author paths are canonical; ID links and /@ aliases redirect without taking ownership',async()=>{
 const f=fixture();const {session}=await owner(f,'/');
 const legacy=await authorPage(f.env,null,false,'abcdef123456');assert.equal(legacy.status,302);assert.equal(legacy.headers.get('Location'),'/authors/owner');
 assert.equal((await authorPage(f.env,null,false,'owner')).status,200);
 assert.equal((await authorPage(f.env,null,false,'OWNER')).headers.get('Location'),'/authors/owner');
 assert.equal((await authorPage(f.env,null,false,'owner',true)).headers.get('Location'),'/authors/owner');
 assert.match(authorLink('Owner','owner',false),/href="\/authors\/owner"/);
 assert.equal((await f.request('/account/profile',{action:'username',username:'next_name'},session)).status,303);
 assert.equal((await f.request('/account/profile',{action:'username',username:'another_name'},session)).status,303);
 f.sql.prepare("INSERT INTO users(id,name,created_at,public_id) VALUES('local:other','Other',1,'reserved_id')").run();
 assert.equal((await f.request('/account/profile',{action:'username',username:'reserved_id'},session)).status,409);
});

test('support form uses verified account email even if a different address is posted; no email is optional',async t=>{
 const f=fixture(),{user}=await owner(f);const mail:any[]=[];
 t.mock.method(globalThis,'fetch',async(_url:any,init:any)=>{mail.push(JSON.parse(init.body));return Response.json({data:{succeeded:1,failed:0}})});
 async function support(body?:Record<string,string>) {
  const form=new FormData();for(const [k,v] of Object.entries(body??{}))form.set(k,v);
  return supportRoute(new Request('https://support.example.com/new',body?{method:'POST',body:form}:undefined),f.env,'/new',user);
 }
 let html=await (await support()).text();assert.match(html,/Email \(optional\)/);assert.doesNotMatch(html,/name="email" required/);
 assert.equal((await support({subject:'Question',body:'Help please'})).status,303);
 assert.equal(f.sql.prepare('SELECT email FROM tickets').get()!.email,'');assert.equal(mail.length,0);
 const ticket=f.sql.prepare('SELECT * FROM tickets').get() as any;
 await addMessage(f.env,ticket,'staff',user.id,'Answer',null);assert.equal(mail.length,0);
 f.sql.prepare("INSERT INTO email_credentials(user_id,email,password_hash) VALUES(?,?,?)").run(user.id,'verified@example.com','hash');
 html=await(await support()).text();assert.doesNotMatch(html,/name="email"/);assert.match(html,/verified@example.com/);
 assert.equal((await support({email:'attacker@example.com',subject:'Account question',body:'Help'})).status,303);
 assert.equal(f.sql.prepare('SELECT email FROM tickets ORDER BY id DESC LIMIT 1').get()!.email,'verified@example.com');
 assert.equal(mail.length,1);assert.deepEqual(mail[0].to,['verified@example.com']);
});

test('deactivation revokes all access and hides content; normal MFA sign-in and confirmation restore access',async()=>{
 const f=fixture(),{session,user}=await owner(f);content(f);
 assert.equal((await f.request('/account/lifecycle/deactivate',{confirm:'no'},session)).status,400);
 assert.equal((await f.request('/account/lifecycle/deactivate',{confirm:'yes'},session)).status,303);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sessions').get()!.n,0);
 assert.equal((await published(f.env)).length,0);assert.equal((await authorPage(f.env,null,false,'owner')).status,404);
 assert.equal(await currentUser(new Request(f.env.SITE_URL,{headers:{Cookie:session}}),f.env),null);
 f.sql.prepare('INSERT INTO totp_credentials(user_id,encrypted_secret,last_step,created_at) VALUES(?,?,?,?)').run(user.id,'encrypted',0,1);
 assert.equal((await finishPrimary(f.env,user.id,1,'/account/profile')).headers.get('Location'),'/auth/second-factor');
 // issueSession is reached only after the existing MFA verifier succeeds.
 const signed=await issueSession(f.env,user.id,1,'totp','/account/profile');assert.equal(signed.headers.get('Location'),'/account/reactivate');
 assert.equal(f.sql.prepare('SELECT count(*) n FROM sessions').get()!.n,0);
 const intent=cookieOf(signed,'__Host-reactivation');assert.ok(intent);
 assert.equal((await f.request('/account/reactivate',undefined,intent)).status,200);
 const activated=await f.request('/account/reactivate',{},intent);assert.equal(activated.status,303);assert.ok(cookieOf(activated));
 assert.equal(f.sql.prepare('SELECT deactivated_at FROM users').get()!.deactivated_at,0);
 assert.equal((await authorPage(f.env,null,false,'owner')).status,200);
 assert.equal((await f.request('/account/reactivate',{},intent)).status,401);
});

test('deletion requires a security grant and confirmation; erases credentials and personal content permanently',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({data:{succeeded:1,failed:0}}));
 const f=fixture(),{session,user}=await owner(f);content(f);const removed:string[]=[];
 f.env.PACKS={delete:async(key:string)=>{removed.push(key)}} as any;
 f.sql.prepare('INSERT INTO email_credentials(user_id,email,password_hash) VALUES(?,?,?)').run(user.id,'owner@example.com','hash');
 f.sql.prepare("INSERT INTO oauth_identities(provider,subject,user_id,label,created_at) VALUES('github','123',?,'Owner',1)").run(user.id);
 await makeFlow(f.env,'reset',user.id,{});
 assert.equal((await f.request('/account/lifecycle/delete',{confirm:'DELETE'})).status,303);
 assert.equal((await f.request('/account/lifecycle/delete',{confirm:'delete'},session)).status,400);
 const deleted=await f.request('/account/lifecycle/delete',{confirm:'DELETE'},session);assert.equal(deleted.status,303);
 const row=f.sql.prepare('SELECT * FROM users').get()!;assert.ok(Number(row.deleted_at)>0);assert.equal(row.name,'Deleted account');assert.equal(row.username,null);assert.equal(row.avatar,'');assert.equal(row.support_email,null);
 for(const table of ['sessions','app_codes','auth_flows','email_credentials','oauth_identities','passkeys','totp_credentials','backup_codes','profile_pictures','ticket_attachments']) assert.equal(f.sql.prepare('SELECT count(*) n FROM '+table).get()!.n,0,table);
 assert.equal(f.sql.prepare('SELECT email FROM tickets').get()!.email,'');assert.notEqual(f.sql.prepare('SELECT access_key FROM tickets').get()!.access_key,'old-key');
 assert.equal(f.sql.prepare('SELECT body FROM ticket_messages').get()!.body,'[Removed with account deletion]');assert.deepEqual(removed,['support/image-id']);
 assert.equal(f.sql.prepare('SELECT body FROM comments').get()!.body,'[Removed]');
 assert.throws(()=>f.sql.prepare("INSERT INTO comments(pack_id,user_id,body,created_at) VALUES('pack','local:owner','Late private comment',2)").run(),/Account deleted/);
 assert.throws(()=>f.sql.prepare("INSERT INTO ticket_attachments(id,message_id,name,type,size) VALUES('late',1,'private.png','image/png',1)").run(),/Account deleted/);
 assert.equal((await issueSession(f.env,user.id,1,'primary')).status,401);assert.equal((await authorPage(f.env,null,false,'abcdef123456')).status,404);
});

test('locked settings, recovery-code sessions and cross-origin requests cannot delete an account',async()=>{
 const f=fixture(),{session,user}=await owner(f,'/');
 assert.equal((await f.request('/account/lifecycle/delete',{confirm:'DELETE'},session)).headers.get('Location'),'/account/unlock');
 const recovery=cookieOf(await issueSession(f.env,user.id,0,'recovery','/account/security'));
 assert.equal((await f.request('/account/lifecycle/delete',{confirm:'DELETE'},recovery)).headers.get('Location'),'/account/unlock');
 assert.equal((await f.request('/account/lifecycle/delete',{confirm:'DELETE'},session,'https://evil.example')).status,403);
 assert.equal(f.sql.prepare('SELECT deleted_at FROM users').get()!.deleted_at,0);
});
