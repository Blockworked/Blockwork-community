// The real Worker bundle, session lookup, CSP, D1 limits, forms and Weblate wire protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium, expect } from '@playwright/test';

test('Blockworked contributor browses languages, signs saves, and retains failed drafts in the real Worker', {timeout:120000}, async()=>{
  const build=mkdtempSync(join(tmpdir(),'blockwork-translate-'));
  const compile=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir',build],{encoding:'utf8'});
  assert.equal(compile.status,0,compile.stderr);
  const secret='browser-test-shared-secret-'.repeat(3);
  const languages=[{code:'fr',name:'French',direction:'ltr',plural:{number:2,formula:'n > 1'}},{code:'ar',name:'Arabic',direction:'rtl',plural:{number:6,formula:'n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5'}}];
  const unit={id:42,source:['Open project'],target:[''],state:0,content_hash:'original',context:'Welcome screen',note:'Button label',explanation:'',location:'Welcome.qml:42',flags:'',translation:'https://weblate.example.com/api/translations/blockwork/ui/fr/',has_failing_check:false};
  let saves=0, failSave=false;
  const options={rootPath:build,modulesRoot:build,modules:[{type:'ESModule',path:join(build,'index.js')}],compatibilityDate:'2026-10-01',d1Databases:['DB'],r2Buckets:['PACKS'],
    bindings:{SITE_URL:'http://localhost',SUPPORT_URL:'http://localhost/support',ADMINS:'',LIBRARY_NAME:'Community',COOKIE_DOMAIN:'',WEBLATE_URL:'https://weblate.example.com',WEBLATE_COMPONENTS:'blockwork/ui',WEBLATE_READ_TOKEN:'read-secret',WEBLATE_SHARED_SECRET:secret},
    outboundService:async(req:Request)=>{
      const url=new URL(req.url);
      assert.equal(url.origin,'https://weblate.example.com');
      if(req.method==='PATCH') {
        const body=await req.text();
        const canonical=[req.headers.get('X-Blockworked-Time'),req.headers.get('X-Blockworked-Nonce'),req.headers.get('X-Blockworked-Identity'),req.method,url.pathname,createHash('sha256').update(body).digest('hex')].join('\n');
        assert.equal(req.headers.get('X-Blockworked-Signature'),createHmac('sha256',secret).update(canonical).digest('hex'));
        assert.equal(req.headers.get('Authorization'),null);
        const identity=JSON.parse(Buffer.from(req.headers.get('X-Blockworked-Identity')!,'base64url').toString());
        assert.deepEqual(identity,{id:'local:browser-translator',name:'Browser Translator'});
        if(failSave) return new Response('Internal backend detail',{status:503});
        const data=JSON.parse(body); assert.equal(data.state,20);
        unit.target=data.target; unit.state=20; saves++;
        return Response.json({target:data.target,state:20});
      }
      assert.equal(req.headers.get('Authorization'),'Token read-secret');
      if(url.pathname.endsWith('/translations/')) return Response.json({results:languages.map(language=>({language,total:1,translated:saves,translated_percent:saves*100,fuzzy:0,is_source:false})),next:null});
      if(url.pathname.endsWith('/units/')) {
        if(url.pathname.includes('/ar/')) return Response.json({results:[{...unit,source:['%n block','%n blocks'],target:Array(6).fill(''),translation:'https://weblate.example.com/api/translations/blockwork/ui/ar/'}],count:1,next:null});
        return Response.json({results:unit.state===20 && url.searchParams.get('q')?.includes('state:<translated')?[]:[unit],count:1,next:null});
      }
      if(url.pathname==='/api/units/42/') return Response.json(unit);
      return new Response('Unexpected API route',{status:500});
    }};
  const mf=new Miniflare(convertV4MiniflareOptions(options));
  let browser, bridge: Server | undefined;
  try {
    const ready=await mf.ready;
    // A local HTTP bridge preserves each test host through real browser redirects.
    bridge=createServer(async(request,response)=>{
      try {
        const chunks: Buffer[]=[];
        for await(const chunk of request) chunks.push(Buffer.from(chunk));
        const body=Buffer.concat(chunks);
        const headers=Object.fromEntries(Object.entries(request.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v as string]));
        const result=await mf.dispatchFetch(`http://${request.headers.host}${request.url}`,{method:request.method,headers,body:body.length?body:undefined,redirect:'manual'});
        response.writeHead(result.status,Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {response.writeHead(500);response.end('Test bridge failed');}
    });
    await new Promise<void>(resolve=>bridge!.listen(0,'127.0.0.1',resolve));
    const address=bridge.address();
    assert.ok(address && typeof address!=='string');
    const origin=`http://community.blockworked.localhost:${address.port}`, translateOrigin=`http://translate.blockworked.localhost:${address.port}`;
    await mf.setOptions(convertV4MiniflareOptions({...options,port:Number(ready.port),bindings:{...options.bindings,SITE_URL:origin,SUPPORT_URL:origin+'/support',TRANSLATE_URL:translateOrigin}}));
    const db=await mf.getD1Database('DB');
    for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()) {
      const lines=readFileSync(join('migrations',file),'utf8').replace(/--[^\n]*/g,'').split('\n');
      let statement='', trigger=false;
      for(const line of lines) {
        if(/^\s*CREATE TRIGGER\b/i.test(line)) trigger=true;
        statement+=line+'\n';
        if(line.trim().endsWith(';')&&(!trigger||/^\s*END;\s*$/i.test(line))) {await db.prepare(statement.trim()).run();statement='';trigger=false;}
      }
      assert.equal(statement.trim(),'');
    }
    await db.prepare('INSERT INTO users (id,name,created_at) VALUES (?,?,?)').bind('local:browser-translator','Browser Translator',Date.now()).run();
    await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(createHash('sha256').update('browser-session').digest('hex'),'local:browser-translator',Date.now()+3600000).run();
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
    const context=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:'reduce',colorScheme:'dark'});
    const page=await context.newPage(), errors:string[]=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.goto(translateOrigin+'/');
    await expect(page.getByRole('heading',{name:'Help Blockwork speak your language.'})).toBeVisible();
    await page.getByRole('link',{name:/Blockwork · UI/}).click();
    await expect(page.getByRole('heading',{name:'Choose your language.'})).toBeVisible();
    await page.getByRole('searchbox',{name:'Find a language'}).fill('fr');
    await expect(page.locator('[data-language="Arabic ar"]')).toBeHidden();
    await page.getByRole('link',{name:/French fr/}).click();
    await expect(page.getByLabel('French',{exact:true})).toBeDisabled();
    await expect(page.getByRole('link',{name:'Sign in with Blockworked to translate'})).toHaveAttribute('href',/next=.*translate.blockworked.localhost/);
    const signin = page.getByRole('link',{name:'Sign in with Blockworked to translate'});
    const signinUrl = new URL((await signin.getAttribute('href'))!);
    assert.equal(signinUrl.origin,origin);
    assert.equal(new URL(signinUrl.searchParams.get('next')!).origin,translateOrigin);
    await signin.click();
    await expect(page).toHaveURL(signinUrl.href);
    await context.addCookies([{name:'session',value:'browser-session',domain:'.blockworked.localhost',path:'/'}]);
    await page.goto(signinUrl.searchParams.get('next')!);
    await page.reload();
    await expect(page.getByLabel('French',{exact:true})).toBeEnabled();
    await page.getByText('Context and notes',{exact:true}).click();
    await expect(page.getByText('Welcome screen',{exact:true})).toBeVisible();
    await page.getByLabel('French',{exact:true}).fill('Ouvrir le projet');
    if(process.env.TRANSLATION_SCREENSHOT) await page.screenshot({path:process.env.TRANSLATION_SCREENSHOT,fullPage:true});
    failSave=true;
    await page.getByRole('button',{name:'Save and next'}).click();
    await expect(page.getByRole('alert')).toContainText('Your draft is below');
    await expect(page.getByLabel('French',{exact:true})).toHaveValue('Ouvrir le projet');
    assert.equal(saves,0);
    failSave=false;
    await page.getByLabel('French',{exact:true}).press('Control+Enter');
    await expect(page.getByRole('heading',{name:'All caught up.'})).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Translation saved');
    assert.equal(saves,1); assert.deepEqual(unit.target,['Ouvrir le projet']);
    await page.goto(translateOrigin+'/blockwork/ui/ar');
    await expect(page.locator('textarea')).toHaveCount(6);
    await expect(page.getByLabel('Plural form 1',{exact:true})).toHaveAttribute('dir','rtl');
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByRole('button',{name:'Save and next'})).toBeVisible();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile page should not overflow');
    await page.getByRole('button',{name:'Toggle light/dark theme'}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme','light');
    if(process.env.TRANSLATION_SCREENSHOT) await page.screenshot({path:process.env.TRANSLATION_SCREENSHOT.replace('.png','-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();if(bridge){bridge.closeAllConnections();await new Promise<void>(resolve=>bridge!.close(()=>resolve()));}await mf.dispose();rmSync(build,{recursive:true,force:true});}
});
