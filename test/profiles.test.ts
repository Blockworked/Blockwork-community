import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { fixture, cookieOf } from './helpers/accounts.ts';
import { issueSession } from '../src/account-security.ts';
import { cleanProfilePng } from '../src/profile-image.ts';
import { profilePicture, USERNAME_COOLDOWN } from '../src/profile.ts';

function png(width = 2, height = 2, metadata = false, raster?: Buffer) {
  const chunk = (type: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(type),bytes]); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size,data,checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(metadata ? [chunk('tEXt',Buffer.from('location\0private location'))] : []),chunk('IDAT',deflateSync(raster ?? Buffer.alloc(height*(width*4+1)))),chunk('IEND',Buffer.alloc(0))]);
}
async function owner(f: ReturnType<typeof fixture>, id = 'local:profile') {
  f.sql.prepare("INSERT INTO users (id,name,created_at,public_id) VALUES (?, 'Original', 1, lower(hex(randomblob(6))))").run(id);
  return cookieOf(await issueSession(f.env,id,0,'primary','/'));
}

test('profile and sidebar work while security is locked; only one settings entry', async () => {
  const f=fixture(), session=await owner(f);
  assert.equal((await f.request('/account',undefined,session)).headers.get('Location'),'/account/profile');
  const profile=await f.request('/account/profile',undefined,session), html=await profile.text();
  assert.equal(profile.status,200); assert.match(html,/aria-current="page">Profile/);
  assert.equal((html.match(/href="\/account">Account settings/g) ?? []).length,1);
  assert.equal((await f.request('/account/security',undefined,session)).headers.get('Location'),'/account/unlock');
  assert.equal((await f.request('/account/profile')).headers.get('Location'),'/login?next=%2Faccount%2Fprofile');
  assert.equal((await f.request('/account/profile',{action:'name',name:'New Name'},session)).status,303);
  assert.equal(f.sql.prepare('SELECT name FROM users').get()!.name,'New Name');
  for (const name of ['Blockworked','bad\u202ename','bad\u0000name','x'.repeat(81)]) assert.equal((await f.request('/account/profile',{action:'name',name},session)).status,400);
  assert.equal((await f.request('/account/profile',{action:'name',name:'CSRF'},session,'https://evil.example')).status,403);
});

test('usernames normalize case, are unique, and enforce a persisted thirty-day cooldown', async () => {
  const f=fixture(), a=await owner(f), b=await owner(f,'local:other');
  assert.equal((await f.request('/account/profile',{action:'username',username:'Alice_12'},a)).status,303);
  assert.equal(f.sql.prepare("SELECT username FROM users WHERE id='local:profile'").get()!.username,'alice_12');
  assert.equal((await f.request('/account/profile',{action:'username',username:'ALICE_12'},b)).status,409);
  assert.equal((await f.request('/account/profile',{action:'username',username:'alice_12'},a)).status,303);
  const cooldown=await f.request('/account/profile',{action:'username',username:'new_name'},a);
  assert.equal(cooldown.status,429); assert.ok(Number(cooldown.headers.get('Retry-After')) > 29*86400);
  f.sql.prepare('UPDATE users SET username_changed_at = ? WHERE id = ?').run(Date.now()-USERNAME_COOLDOWN-1000,'local:profile');
  assert.equal((await f.request('/account/profile',{action:'username',username:'new_name'},a)).status,303);
  assert.equal((await f.request('/account/profile',{action:'username',username:'alice_12'},b)).status,409);
  f.sql.prepare('UPDATE username_history SET hold_until=0').run();
  assert.equal((await f.request('/account/profile',{action:'username',username:'alice_12'},b)).status,303);
});

test('reserved and invalid handles cannot be claimed; profile writes are throttled per account', async () => {
  const f=fixture(), session=await owner(f);
  for (const username of ['ab','1alice','foo-bar','álîce','admin','su_pp_ort','blockworked','bl0ckwork']) assert.equal((await f.request('/account/profile',{action:'username',username},session)).status,400);
  f.sql.exec('DELETE FROM auth_limits');
  for (let i=0;i<20;i++) assert.equal((await f.request('/account/profile',{action:'name',name:'Name '+i},session)).status,303);
  assert.equal((await f.request('/account/profile',{action:'name',name:'Too many'},session)).status,429);
  f.sql.exec('DELETE FROM sessions');
  assert.equal((await f.request('/account/profile',{action:'name',name:'Logged out'},session)).status,303);
  assert.equal(f.sql.prepare('SELECT name FROM users').get()!.name,'Name 19');
});

test('PNG processing removes metadata and rejects corrupt, oversized and inflated images', async () => {
  const clean=await cleanProfilePng(png(2,2,true)); assert.ok(!Buffer.from(clean).includes(Buffer.from('private location')));
  assert.deepEqual(clean,await cleanProfilePng(png()));
  const corrupt=png(); corrupt[corrupt.length-1]^=1;
  for (const bytes of [corrupt,png(513,1),png(1,1,false,Buffer.alloc(100000)),Buffer.from('<svg onload="alert(1)"/>'),Buffer.concat([png(),Buffer.from('payload')]),png(1,1,false,Buffer.from([5,0,0,0,0]))]) await assert.rejects(cleanProfilePng(bytes));
});

test('picture upload serves safe bytes, replaces and removes old pictures without keeping copies', async () => {
  const f=fixture(), session=await owner(f);
  let response=await f.request('/account/profile/picture',{png:png(2,2,true).toString('base64')},session);
  assert.equal(response.status,200);
  const first=f.sql.prepare('SELECT id FROM profile_pictures').get()!.id as string;
  const image=await profilePicture(f.env,first); assert.equal(image.headers.get('Content-Type'),'image/png');
  assert.ok(!Buffer.from(await image.arrayBuffer()).includes(Buffer.from('location')));
  response=await f.request('/account/profile/picture',{png:png().toString('base64')},session); assert.equal(response.status,200);
  assert.equal((await profilePicture(f.env,first)).status,404);
  const second=f.sql.prepare('SELECT id FROM profile_pictures').get()!.id as string;
  assert.equal((await f.request('/account/profile',{action:'picture-remove'},session)).status,303);
  assert.equal((await profilePicture(f.env,second)).status,404);
  assert.equal(f.sql.prepare('SELECT avatar FROM users').get()!.avatar,'');
  assert.equal((await f.request('/account/profile/picture',{png:Buffer.from('<svg/>').toString('base64')},session)).status,400);
  assert.equal((await f.request('/account/profile/picture',{png:'A'.repeat(360001)},session)).status,413);
});
