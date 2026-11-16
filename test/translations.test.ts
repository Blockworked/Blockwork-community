import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture } from './helpers/accounts.ts';
import { translateRoute } from '../src/translate.ts';
import { belongsTo, components, signedHeaders, snapshot, type Unit } from '../src/weblate.ts';
import type { User } from '../src/auth.ts';

const user: User = {id:'local:translator-1',name:'Translator <one>',avatar:'',banned:0};
const language = {code:'ar',name:'Arabic',direction:'rtl',plural:{number:6,formula:'n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5'}};
function setup() {
  const f = fixture();
  Object.assign(f.env,{WEBLATE_URL:'https://weblate.example.com',WEBLATE_COMPONENTS:'blockwork/ui',WEBLATE_READ_TOKEN:'read-only-secret',WEBLATE_SHARED_SECRET:'s'.repeat(64)});
  const translation = {language,total:10,translated:2,translated_percent:20,fuzzy:1,is_source:false};
  const unit: Unit = {id:42,source:['%n block','%n blocks'],target:['','','','','',''],state:0,content_hash:'original',context:'Editor',note:'<script>unsafe</script>',explanation:'',location:'Editor.qml:12',flags:'',translation:'https://weblate.example.com/api/translations/blockwork/ui/ar/',has_failing_check:false};
  const calls: {url:URL;init:RequestInit}[] = [];
  let failSave = 0, failRead = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({url,init});
    assert.equal(url.origin, f.env.WEBLATE_URL);
    if (init.method === 'PATCH') {
      assert.equal(url.pathname, '/api/units/42/');
      const headers = init.headers as Record<string,string>;
      assert.equal(headers.Authorization, undefined);
      const body = JSON.parse(String(init.body));
      assert.equal(body.state,20);
      assert.equal(body.target.length,6);
      const expected = [headers['X-Blockworked-Time'],headers['X-Blockworked-Nonce'],headers['X-Blockworked-Identity'],'PATCH','/api/units/42/',await import('../src/auth.ts').then(m=>m.hash(String(init.body)))].join('\n');
      assert.equal(headers['X-Blockworked-Signature'],createHmac('sha256',f.env.WEBLATE_SHARED_SECRET!).update(expected).digest('hex'));
      const identity = JSON.parse(Buffer.from(headers['X-Blockworked-Identity'],'base64url').toString());
      assert.deepEqual(identity,{id:user.id,name:user.name});
      if (failSave) return new Response('sensitive upstream details', {status:failSave});
      return Response.json({...unit,target:body.target,state:20});
    }
    assert.equal((init.headers as Record<string,string>).Authorization,'Token read-only-secret');
    if (failRead) return new Response('Read failed', {status:503});
    if (url.pathname.endsWith('/translations/')) return Response.json({results:[translation,{...translation,is_source:true,language:{...language,code:'en',name:'English'}}],next:null});
    if (url.pathname.endsWith('/units/')) {
      assert.equal(url.searchParams.get('q'),'state:<translated AND NOT has:read-only');
      return Response.json({results:[unit],count:8,next:null});
    }
    if (url.pathname === '/api/units/42/') return Response.json(unit);
    throw new Error('Unexpected upstream URL ' + url);
  };
  async function request(path = '/translate/blockwork/ui/ar', data?: object, signedIn: User | null = user, origin = f.env.SITE_URL) {
    return translateRoute(new Request(f.env.SITE_URL + path, data ? {method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data as Record<string,string>)} : {}),f.env,signedIn);
  }
  async function data() { return {unit:'42',revision:await snapshot(unit),...Object.fromEntries(Array.from({length:6},(_,i)=>[`target_${i}`,`%n translation ${i}`]))}; }
  return {...f,request,calls,unit,data,fail: (status:number)=>{failSave=status;},failReads:()=>{failRead=true;},restore:()=>{globalThis.fetch=original; f.sql.close();}};
}

test('configured projects and language picker use the existing shell and omit source language',async()=>{
  const f=setup(); try {
    const home=await f.request('/translate'); const html=await home.text();
    assert.match(html,/Help Blockwork speak/); assert.match(html,/Blockworked Translations/);
    assert.equal(f.calls.length,0);
    const response=await f.request('/translate/blockwork/ui'); const body=await response.text();
    assert.match(body,/Arabic/); assert.doesNotMatch(body,/data-language="English/);
    assert.match(body,/2 \/ 10 translated/);
    assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  } finally { f.restore(); }
});
test('editor renders every Arabic plural form, escapes source notes, and preserves direction',async()=>{
  const f=setup(); try {
    const body=await (await f.request()).text();
    assert.equal((body.match(/name="target_\d"/g)??[]).length,6);
    assert.match(body,/dir="rtl"/); assert.match(body,/&#60;script&#62;unsafe/);
    assert.doesNotMatch(body,/<script>unsafe/); assert.match(body,/GPL-3.0-only/);
    assert.doesNotMatch(body,/read-only-secret|ssssssss/);
  } finally { f.restore(); }
});
test('save signs the authenticated identity and body, forwards all plurals, then redirects',async()=>{
  const f=setup(); try {
    const response=await f.request(undefined,await f.data());
    assert.equal(response.status,303); assert.equal(response.headers.get('Location'),'/translate/blockwork/ui/ar?view=todo&page=1&saved=1');
    assert.equal(f.calls.filter(c=>c.init.method==='PATCH').length,1);
  } finally { f.restore(); }
});
test('cross-site saves, unknown components, and anonymous writes never reach Weblate',async()=>{
  const f=setup(); try {
    assert.equal((await f.request(undefined,await f.data(),user,'https://evil.example')).status,403);
    assert.equal((await f.request('/translate/private/component/ar')).status,404);
    const anon=await f.request(undefined,await f.data(),null);
    assert.equal(anon.status,303); assert.match(anon.headers.get('Location')!,/^\/login\?next=/);
    assert.equal(f.calls.length,0);
  } finally { f.restore(); }
});
test('foreign units and stale drafts cannot overwrite translations',async()=>{
  const f=setup(); try {
    const data=await f.data();
    f.unit.target[0]='A newer translation';
    const response=await f.request(undefined,data); const html=await response.text();
    assert.equal(response.status,409); assert.match(html,/A newer translation/); assert.match(html,/%n translation 0/);
    f.unit.translation='https://weblate.example.com/api/translations/private/ui/ar/';
    assert.equal((await f.request(undefined,await f.data())).status,404);
    assert.equal(f.calls.filter(c=>c.init.method==='PATCH').length,0);
  } finally { f.restore(); }
});
test('upstream failure keeps the draft and hides internal error details',async()=>{
  const f=setup(); try {
    f.fail(403); const response=await f.request(undefined,await f.data()); const html=await response.text();
    assert.equal(response.status,403); assert.match(html,/%n translation 5/);
    assert.match(html,/locked or your account/); assert.doesNotMatch(html,/sensitive upstream/);
  } finally { f.restore(); }
});
test('incomplete plurals cannot be saved',async()=>{
  const f=setup(); try {
    const data=await f.data(); data.target_5='';
    const response=await f.request(undefined,data);
    assert.equal(response.status,400); assert.match(await response.text(),/Fill in every/);
    assert.equal(f.calls.filter(c=>c.init.method==='PATCH').length,0);
  } finally { f.restore(); }
});
test('credentialed requests cannot follow redirects to another origin',async()=>{
  const f=setup(); try {
    await f.request(); assert.ok(f.calls.every(c=>c.init.redirect==='manual'));
    assert.ok(!belongsTo(f.env,{...f.unit,translation:'https://evil.example/api/translations/blockwork/ui/ar/'},'blockwork/ui','ar'));
    assert.deepEqual(components({...f.env,WEBLATE_COMPONENTS:'blockwork/ui, ../private, blockwork/ui'}),['blockwork/ui']);
  } finally { f.restore(); }
});
test('signature identity supports Unicode names without leaking private account data',async()=>{
  const headers=await signedHeaders('s'.repeat(64),{...user,name:'مترجم 🌍'},'PATCH','/api/units/42/','{}');
  assert.deepEqual(JSON.parse(Buffer.from(headers['X-Blockworked-Identity'],'base64url').toString()),{id:user.id,name:'مترجم 🌍'});
});

test('draft survives when Weblate is unavailable before the save can start',async()=>{
  const f=setup(); try {
    f.failReads(); const response=await f.request(undefined,await f.data()); const html=await response.text();
    assert.equal(response.status,503); assert.match(html,/%n translation 5/); assert.match(html,/Try saving again/);
    assert.match(html,/data-draft="true"/); assert.equal(f.calls.filter(c=>c.init.method==='PATCH').length,0);
  } finally {f.restore();}
});

test('Weblate redirects fail closed without sending credentials to the redirect target',async()=>{
  const f=setup(); let requests=0;
  try {
    globalThis.fetch=async(input,init)=>{
      requests++; assert.equal(new URL(String(input)).origin,f.env.WEBLATE_URL);
      assert.equal(init?.redirect,'manual');
      return new Response(null,{status:302,headers:{Location:'https://untrusted.example/collect'}});
    };
    const response=await f.request('/translate/blockwork/ui');
    assert.equal(response.status,503); assert.equal(requests,1);
  } finally {f.restore();}
});

test('dedicated translation host serves its root, keeps links there, and uses community sign-in',async()=>{
  const f=setup(); try {
    f.env.TRANSLATE_URL='https://translate.blockworked.com';
    const {default:worker}=await import('../src/index.ts');
    const response=await worker.fetch(new Request('https://translate.blockworked.com/'),f.env,{} as ExecutionContext);
    assert.equal(response.status,200); const html=await response.text();
    assert.match(html,/href="https:\/\/translate\.blockworked\.com\/blockwork\/ui"/);
    assert.match(html,/href="https:\/\/community.example.com\/login\?next=/);
    assert.doesNotMatch(html,/translate\.blockworked\.com\/\/blockwork/);
    const alias=await worker.fetch(new Request(f.env.SITE_URL+'/translate/blockwork/ui/ar?view=all'),f.env,{} as ExecutionContext);
    assert.equal(alias.status,308); assert.equal(alias.headers.get('Location'),'https://translate.blockworked.com/blockwork/ui/ar?view=all');
    const script=await worker.fetch(new Request('https://translate.blockworked.com/translate.js'),f.env,{} as ExecutionContext);
    assert.equal(script.status,200); assert.match(script.headers.get('Content-Type')!,/javascript/);
    const asset=await worker.fetch(new Request('https://translate.blockworked.com/site.js'),f.env,{} as ExecutionContext);
    assert.equal(asset.status,200);
  } finally { f.restore(); }
});
test('translation host saves accept only its own origin and stay on the translation host',async()=>{
  const f=setup(); try {
    f.env.TRANSLATE_URL='https://translate.blockworked.com';
    const body=new URLSearchParams(await f.data() as Record<string,string>);
    const request=(origin:string)=>new Request('https://translate.blockworked.com/blockwork/ui/ar',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body});
    assert.equal((await translateRoute(request(f.env.SITE_URL),f.env,user)).status,403);
    const saved=await translateRoute(request('https://translate.blockworked.com'),f.env,user);
    assert.equal(saved.status,303); assert.equal(saved.headers.get('Location'),'https://translate.blockworked.com/blockwork/ui/ar?view=todo&page=1&saved=1');
    const anon=await translateRoute(request('https://translate.blockworked.com'),f.env,null);
    const login=new URL(anon.headers.get('Location')!); assert.equal(login.origin,f.env.SITE_URL);
    assert.equal(login.searchParams.get('next'),'https://translate.blockworked.com/blockwork/ui/ar');
  } finally { f.restore(); }
});
test('sign-in return targets allow the exact configured translation origin, never lookalike domains',async()=>{
  const {safeNext}=await import('../src/auth.ts');
  const env={TRANSLATE_URL:'https://translate.blockworked.com'};
  const target='https://translate.blockworked.com/blockwork/ui/ar?view=all';
  assert.equal(safeNext(target,env),target);
  for(const bad of ['https://translate.blockworked.com.evil.example/','https://evil.example/','https://translate.blockworked.com@evil.example/','http://translate.blockworked.com/','https://evil@translate.blockworked.com/']) assert.equal(safeNext(bad,env),'/');
  assert.equal(safeNext('http://localhost:8787/translateevil',{TRANSLATE_URL:'http://localhost:8787/translate'}),'/');
});
