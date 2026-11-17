import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/accounts.ts';
import { translateRoute } from '../src/translate.ts';
import { snapshot, termsIn, type Unit } from '../src/weblate.ts';
import { normalizeCode } from '../src/language-proposals.ts';
import { inLanguage, negotiate, t, tn, tp, raw, languages } from '../src/i18n.ts';
import { CATALOGS } from '../src/locales.generated.ts';
import type { User } from '../src/auth.ts';

const user: User = {id:'local:translator-1',name:'Translator One',avatar:'',banned:0};
const admin: User = {id:'github:1',name:'Admin',avatar:'',banned:0};
const fr = {code:'fr',name:'French',direction:'ltr',plural:{number:2,formula:'n > 1'}};
const API = 'https://weblate.example.com';

function setup() {
  const f = fixture();
  Object.assign(f.env,{WEBLATE_URL:API,WEBLATE_COMPONENTS:'blockwork/ui,blockworked/website',WEBLATE_READ_TOKEN:'read',WEBLATE_SHARED_SECRET:'s'.repeat(64),WEBLATE_LANGUAGE_TOKEN:'languages',ADMINS:admin.id});
  f.sql.prepare('INSERT INTO users (id,name,created_at) VALUES (?,?,?), (?,?,?)').run(user.id,user.name,1,admin.id,admin.name,1);
  const unit: Unit = {id:42,source:['Save %1 to {folder}'],target:[''],state:0,content_hash:'h',context:'Toolbar',note:'',explanation:'',location:'Main.qml:3',flags:'',
    translation:`${API}/api/translations/blockwork/ui/fr/`,has_failing_check:false,source_unit:`${API}/api/units/7/`,language_code:'fr',has_suggestion:true,has_comment:true,previous_source:''};
  const calls: {method:string;url:URL;body:any}[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    calls.push({method,url,body: init.body ? JSON.parse(String(init.body)) : undefined});
    if (method !== 'GET') {
      if (url.pathname.startsWith('/api/components/')) return Response.json({}, {status:201});
      return Response.json({}, {status: method === 'POST' ? 201 : 200});
    }
    if (url.pathname.match(/^\/api\/components\/[^/]+\/[^/]+\/translations\/$/)) {
      if (url.pathname.includes('blockworked/website')) return new Response('missing', {status:404});
      return Response.json({results:[{language:fr,total:10,translated:4,translated_percent:40,fuzzy:0,is_source:false},{language:{...fr,code:'de',name:'German'},total:10,translated:9,translated_percent:90,fuzzy:0,is_source:false}],next:null});
    }
    if (url.pathname === '/api/translations/blockwork/ui/fr/units/') return Response.json({results: url.searchParams.get('page_size') === '50' ? [unit, {...unit,id:43,source:['Open'],target:['Ouvrir'],state:20}] : [unit],count:2,next:null});
    if (url.pathname === '/api/units/42/') return Response.json(unit);
    if (url.pathname === '/api/units/7/translations/') return Response.json([{...unit,id:44,language_code:'de',target:['%1 in {folder} speichern']}]);
    if (url.pathname === '/api/units/42/suggestions/') return Response.json({results:[{id:5,unit:`${API}/api/units/42/`,target:['Enregistrer %1 dans {folder}'],timestamp:'2026-11-01T00:00:00Z',votes:2}]});
    if (url.pathname === '/api/units/42/comments/') return Response.json({results:[{id:1,comment:'Is "save" a verb here?',timestamp:'2026-11-02T00:00:00Z'}]});
    if (url.pathname === '/api/units/7/screenshots/') return Response.json({results:[{id:3,name:'Toolbar',translation:`${API}/api/translations/blockwork/ui/en/`}]});
    if (url.pathname === '/api/translations/blockwork/glossary/fr/units/') return Response.json({results:[{...unit,source:['folder'],target:['dossier'],explanation:'A place on disk'}],next:null});
    throw new Error('Unexpected upstream URL ' + url);
  };
  const request = (path: string, data?: Record<string,string>, who: User | null = user) =>
    translateRoute(new Request(f.env.SITE_URL + path, data ? {method:'POST',headers:{Origin:f.env.SITE_URL,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)} : {}), f.env, who);
  return {...f, unit, calls, request, restore: () => { globalThis.fetch = original; f.sql.close(); }};
}

test('projects page hides a project Weblate does not have yet and links to proposals', async () => {
  const f = setup(); try {
    const html = await (await f.request('/translate')).text();
    assert.match(html, /Blockwork app/); assert.doesNotMatch(html, /blockworked\.com<\/span>/);
    assert.match(html, /65% translated overall/); assert.match(html, /\/translate\/languages\/new/);
  } finally { f.restore(); }
});

test('editor shows placeholders, glossary, screenshots, suggestions, other languages and comments', async () => {
  const f = setup(); try {
    const html = await (await f.request('/translate/blockwork/ui/fr')).text();
    assert.match(html, /data-insert="%1"/); assert.match(html, /data-insert="\{folder\}"/);
    assert.match(html, /dossier/); assert.match(html, /A place on disk/);
    assert.match(html, /\/translate\/screenshots\/3/);
    assert.match(html, /Enregistrer %1 dans \{folder\}/); assert.match(html, /2 votes/);
    assert.match(html, /German/); assert.match(html, /speichern/);
    assert.match(html, /Is &#34;save&#34; a verb here\?/);
    assert.match(html, /String 1 of 2/); assert.match(html, /Toolbar/);
    const q = f.calls.find(c => c.url.pathname.endsWith('/fr/units/'))!.url.searchParams.get('q');
    assert.equal(q, 'state:<translated AND NOT is:read-only');
  } finally { f.restore(); }
});

test('search and filters build one Weblate query and the list links into the editor', async () => {
  const f = setup(); try {
    const html = await (await f.request('/translate/blockwork/ui/fr/strings?filter=fuzzy&q=sa"ve%5C')).text();
    const q = f.calls.find(c => c.url.pathname.endsWith('/fr/units/'))!.url.searchParams.get('q');
    assert.equal(q, 'is:needs-editing AND NOT is:read-only AND (source:"save" OR target:"save" OR context:"save" OR note:"save")');
    assert.match(html, /2 strings/); assert.match(html, /Ouvrir/);
    assert.match(html, /href="\/translate\/blockwork\/ui\/fr\?filter=fuzzy&amp;q=save&amp;page=2"|href="\/translate\/blockwork\/ui\/fr\?filter=fuzzy&q=save&page=2"/);
  } finally { f.restore(); }
});

test('needs editing saves state 10 and keeps the place in the list', async () => {
  const f = setup(); try {
    const response = await f.request('/translate/blockwork/ui/fr?view=todo&page=1', {unit:'42',revision:await snapshot(f.unit),target_0:'Enregistrer %1 dans {folder}',needs_editing:'1',action:'save'});
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/translate/blockwork/ui/fr?view=todo&page=2&saved=editing');
    const patch = f.calls.find(c => c.method === 'PATCH')!;
    assert.deepEqual(patch.body, {target:['Enregistrer %1 dans {folder}'],state:10});
  } finally { f.restore(); }
});

test('suggest, vote and comment post signed requests to their own endpoints', async () => {
  const f = setup(); try {
    const base = {unit:'42',revision:await snapshot(f.unit)};
    assert.equal((await f.request('/translate/blockwork/ui/fr', {...base,target_0:'Enregistrer',action:'suggest'})).status, 303);
    assert.equal((await f.request('/translate/blockwork/ui/fr', {...base,action:'vote',suggestion:'5'})).status, 303);
    assert.equal((await f.request('/translate/blockwork/ui/fr', {...base,action:'comment',comment:'Means "save as"',scope:'report'})).status, 303);
    const posts = f.calls.filter(c => c.method === 'POST');
    assert.deepEqual(posts.map(p => [p.url.pathname, p.body]), [
      ['/api/units/42/suggestions/', {target:['Enregistrer']}],
      ['/api/units/42/suggestions/', {target:['Enregistrer %1 dans {folder}']}],
      ['/api/units/42/comments/', {scope:'report',comment:'Means "save as"'}],
    ]);
    assert.equal((await f.request('/translate/blockwork/ui/fr', {...base,action:'vote',suggestion:'99'})).status, 409);
    assert.equal((await f.request('/translate/blockwork/ui/fr', {...base,action:'approve'})).status, 400);
  } finally { f.restore(); }
});

test('a language proposal collects helpers and an admin adds it to every project', async () => {
  const f = setup(); try {
    const made = await f.request('/translate/languages/new', {name:'Brazilian Portuguese',code:'pt-br',note:'I can help'});
    assert.equal(made.status, 303); assert.match(made.headers.get('Location')!, /done=proposed/);
    const row = f.sql.prepare('SELECT id, code, status FROM language_proposals').get() as {id:number;code:string;status:string};
    assert.equal(row.code, 'pt_BR');
    const again = await f.request('/translate/languages/new', {name:'Portuguese (Brazil)',code:'pt_BR'}, admin);
    assert.match(again.headers.get('Location')!, /done=joined/);
    const open = await f.request('/translate/languages/new', {name:'French',code:'fr'}, admin);
    assert.equal(open.status, 409);
    let list = await (await f.request('/translate/languages')).text();
    assert.match(list, /2 people will help/); assert.match(list, /You’ll help/);
    assert.equal((await f.request(`/translate/languages/${row.id}`, {action:'add',code:'pt_BR'})).status, 403);
    const added = await f.request(`/translate/languages/${row.id}`, {action:'add',code:'pt_BR',reply:'Open now'}, admin);
    assert.match(added.headers.get('Location')!, /done=added/);
    const creates = f.calls.filter(c => c.method === 'POST' && c.url.pathname.startsWith('/api/components/'));
    assert.deepEqual(creates.map(c => c.url.pathname), ['/api/components/blockwork/ui/translations/', '/api/components/blockworked/website/translations/']);
    assert.deepEqual(creates[0].body, {language_code:'pt_BR'});
    list = await (await f.request('/translate/languages')).text();
    assert.match(list, /Added/); assert.match(list, /Open now/);
    assert.equal((await f.request('/translate/languages/new', {name:'x',code:'not a code'})).status, 400);
  } finally { f.restore(); }
});

test('language codes and glossary matching', () => {
  assert.equal(normalizeCode('PT-br'), 'pt_BR'); assert.equal(normalizeCode('zh_hans'), 'zh_Hans'); assert.equal(normalizeCode('sr@latin'), 'sr@latin');
  const terms = [{source:'block',target:'bloc',note:''},{source:'save',target:'enregistrer',note:''}];
  assert.deepEqual(termsIn('Blocks save time', terms).map(t => t.source), ['save']);
  assert.deepEqual(termsIn('One block.', terms).map(t => t.source), ['block']);
});

test('site strings follow the cookie or browser language and stay escaped', () => {
  CATALOGS.de = {tag:'de',name:'Deutsch',dir:'ltr',offered:true,complete:1,plural:(n:number)=>Number(n != 1),messages:{
    'Sign in': ['Anmelden'], '{n} language': ['{n} Sprache', '{n} Sprachen'], 'Hello {name}': ['Hallo {name}'],
  }};
  CATALOGS.xx = {tag:'xx',name:'Unfinished',dir:'ltr',offered:false,complete:0.1,plural:()=>0,messages:{}};
  try {
    const req = (headers: Record<string,string>) => new Request('https://example.com/', {headers});
    assert.equal(negotiate(req({'Accept-Language':'fr;q=0.9, de-AT;q=0.8'})), 'de');
    assert.equal(negotiate(req({'Accept-Language':'xx'})), 'en');
    assert.equal(negotiate(req({Cookie:'bw-theme=dark; bw-lang=en','Accept-Language':'de'})), 'en');
    assert.equal(negotiate(req({Cookie:'bw-lang=de'})), 'de');
    inLanguage('de', () => {
      assert.equal(t('Sign in'), 'Anmelden');
      assert.equal(tn('{n} language', '{n} languages', 3), '3 Sprachen');
      assert.equal(t('Hello {name}', {name:'<b>'}), 'Hallo &#60;b&#62;');
      assert.equal(t('Hello {name}', {name:raw('<b>x</b>')}), 'Hallo <b>x</b>');
      assert.equal(tp('Not translated <yet>'), 'Not translated <yet>');
      assert.deepEqual(languages().map(l => l.code), ['en', 'de']);
    });
    assert.equal(t('Sign in'), 'Sign in');
  } finally { delete CATALOGS.de; delete CATALOGS.xx; }
});
