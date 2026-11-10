// Production bundle in workerd + D1, driven by Chromium's virtual WebAuthn authenticator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { totp } from '../src/totp.ts';
import { chromium, expect } from '@playwright/test';

test('email verification, passwords, browser passkeys, backup codes and reset in Workers', {timeout: 120000}, async () => {
  const build = mkdtempSync(join(tmpdir(), 'blockwork-auth-'));
  const compile = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', build], {encoding: 'utf8'});
  assert.equal(compile.status, 0, compile.stderr);
  const mail: any[] = [];
  let providerChallenge = '';
  let origin = '';
  const options = {
    rootPath: build, modulesRoot: build, modules: [{type: 'ESModule', path: join(build, 'index.js')}], compatibilityDate: '2026-10-01',
    d1Databases: ['DB'], r2Buckets: ['PACKS'],
    bindings: {SITE_URL: 'http://localhost', ADMINS: '', LIBRARY_NAME: 'Test community', LOCAL_AUTH_ENABLED: 'true', AUTH_TOTP_KEY: 'A'.repeat(43), SMTP2GO_API_KEY: 'test', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret'},
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      if (url.href === 'https://github.com/login/oauth/access_token') {
        const data = await req.json();
        assert.equal(createHash('sha256').update(data.code_verifier).digest('base64url'), providerChallenge);
        return Response.json({access_token: 'test-access'});
      }
      if (url.href === 'https://api.github.com/user') return Response.json({id: 987654321, login: 'linked-github', name: 'Linked GitHub'});
      if (url.hostname === 'api.pwnedpasswords.com') return new Response('0'.repeat(35) + ':0');
      if (url.hostname === 'api.smtp2go.com') { mail.push(await req.json()); return Response.json({data: {succeeded: 1, failed: 0}}); }
      return new Response('Unexpected outbound request', {status: 502});
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  let browser;
  try {
    const ready = await mf.ready;
    origin = `http://localhost:${ready.port}`;
    await mf.setOptions(convertV4MiniflareOptions({...options, port: Number(ready.port), bindings: {...options.bindings, SITE_URL: origin, SUPPORT_URL: origin + '/support'}}));
    const db = await mf.getD1Database('DB');
    for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) {
      const lines = readFileSync(join('migrations', file), 'utf8').replace(/--[^\n]*/g, '').split('\n');
      let statement = '', trigger = false;
      for (const line of lines) {
        if (/^\s*CREATE TRIGGER\b/i.test(line)) trigger = true;
        statement += line + '\n';
        if (line.trim().endsWith(';') && (!trigger || /^\s*END;\s*$/i.test(line))) {
          await db.prepare(statement.trim()).run(); statement = ''; trigger = false;
        }
      }
      assert.equal(statement.trim(), '');
    }
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}), args: ['--no-sandbox']});
    const context = await browser.newContext({reducedMotion:'reduce'});
    await context.route('https://github.com/login/oauth/authorize**', async route => {
      const authorization = new URL(route.request().url());
      providerChallenge = authorization.searchParams.get('code_challenge')!;
      await route.fulfill({status: 302, headers: {Location: origin + '/auth/github/callback?code=test-code&state=' + authorization.searchParams.get('state')}});
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true}});
    const initial = 'Correct unique test password 6315!';
    await page.goto(origin + '/auth/email/signup');
    await page.getByLabel('Display name').fill('Browser User');
    await page.getByLabel('Email', {exact: true}).fill('browser@example.com');
    await page.getByRole('button', {name: 'Verify email', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Check your email'})).toBeVisible();
    await expect.poll(() => mail.length).toBe(1);
    const verification = mail[0].text_body.match(/http:\/\/localhost:[0-9]+\/auth\/email\/verify\?token=[\w-]+/)[0];
    await page.goto(verification);
    await page.getByLabel('New password', {exact: true}).fill(initial);
    await page.getByRole('button', {name: 'Save password'}).click();
    await expect(page.getByRole('heading', {name: 'Email verified'})).toBeVisible();
    async function login(password: string, email = 'browser@example.com') {
      await page.goto(origin + '/login');
      await page.getByLabel('Email', {exact: true}).fill(email);
      await page.getByLabel('Password', {exact: true}).fill(password);
      await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    }
    await login(initial);
    await expect(page.getByRole('heading', {name: 'Account security', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Add passkey', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account/security?enrolled=1');
    await expect(page.locator('li').filter({hasText: 'My passkey'})).toBeVisible();
    await page.getByRole('button', {name: 'Generate new backup codes'}).click();
    await expect(page.getByRole('heading', {name: 'Save your backup codes'})).toBeVisible();
    const backupCodes = (await page.locator('pre').innerText()).split('\n');
    assert.equal(backupCodes.length, 10);
    await page.getByRole('link', {name: 'I saved my codes'}).click();
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await login(initial);
    await expect(page.getByRole('heading', {name: 'Verify your sign-in'})).toBeVisible();
    await page.getByRole('button', {name: 'Use a passkey', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await page.goto(origin + '/login');
    await page.getByRole('button', {name: 'Sign in with a passkey'}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await login(initial);
    await page.getByLabel('Backup code', {exact: true}).fill(backupCodes[0]);
    await page.getByRole('button', {name: 'Use backup code', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await expect(page.getByText(/9 unused codes/)).toBeVisible();
    await page.goto(origin + '/auth/email/forgot');
    await page.getByLabel('Email', {exact: true}).fill('browser@example.com');
    await page.getByRole('button', {name: 'Send reset link'}).click();
    await expect(page.getByRole('heading', {name: 'Check your email'})).toBeVisible();
    await expect.poll(() => mail.some(m => m.subject === 'Reset your Blockworked password')).toBe(true);
    const reset = mail.find(m => m.subject === 'Reset your Blockworked password').text_body.match(/http:\/\/localhost:[0-9]+\/auth\/email\/reset\?token=[\w-]+/)[0];
    await page.goto(reset);
    const next = 'Another unique test password 9876!';
    await page.getByLabel('New password', {exact: true}).fill(next);
    await page.getByRole('button', {name: 'Save password'}).click();
    await expect(page.getByRole('heading', {name: 'Password updated'})).toBeVisible();
    await login(initial);
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
    await login(next);
    await expect(page.getByRole('heading', {name: 'Verify your sign-in'})).toBeVisible();
    await page.getByRole('button', {name: 'Use a passkey', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM passkeys').first())!.n, 1);
    await page.getByRole('button', {name: 'Set up authenticator app', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Set up an authenticator app'})).toBeVisible();
    const appSecret = await page.locator('pre').innerText();
    assert.match(appSecret, /^[A-Z2-7]+$/);
    await expect(page.locator('svg').filter({has: page.locator('path')})).not.toHaveCount(0);
    await page.getByLabel('Six-digit code', {exact: true}).fill(totp(appSecret).generate());
    await page.getByRole('button', {name: 'Confirm authenticator app'}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await expect(page.getByText('Enabled. Your app generates a new six-digit code every 30 seconds.')).toBeVisible();
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await login(next);
    await page.getByLabel('Six-digit code', {exact: true}).fill(totp(appSecret).generate({timestamp: Date.now() + 30000}));
    await page.getByRole('button', {name: 'Verify authenticator code'}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM totp_credentials').first())!.n, 1);
    // The following independent settings flow starts with fresh rate-limit state.
    await db.prepare('DELETE FROM auth_limits').run();
    await page.getByRole('button', {name: 'Lock security settings'}).click();
    await expect(page.getByRole('heading', {name: 'Unlock security settings'})).toBeVisible();
    await page.getByRole('button', {name: 'Unlock with a passkey'}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await page.getByRole('button', {name: 'Connect GitHub', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Confirm account connection'})).toBeVisible();
    await page.getByRole('button', {name: 'Connect GitHub', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await expect(page.getByText('GitHub: Linked GitHub', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Disconnect GitHub', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await expect(page.getByText('GitHub: Not connected', {exact: true})).toBeVisible();
    await page.getByLabel('New email address', {exact: true}).fill('changed@example.com');
    await page.getByRole('button', {name: 'Request email change'}).click();
    await expect(page.getByRole('heading', {name: 'Confirm both email addresses'})).toBeVisible();
    const approval = mail.findLast(m => m.subject === 'Approve your Blockworked email change');
    const verificationMail = mail.findLast(m => m.subject === 'Verify your new Blockworked email');
    for (const email of [approval, verificationMail]) {
      const confirmation = await context.newPage();
      const link = email.text_body.match(/http:\/\/localhost:[0-9]+\/account\/email-change\/approve\?token=[\w-]+/)[0];
      await confirmation.goto(link);
      await confirmation.getByRole('button', {name: 'Confirm this email address'}).click();
      await expect(confirmation.getByRole('heading', {name: 'Email address confirmed'})).toBeVisible();
      await confirmation.close();
    }
    await page.goto(origin + '/account/security');
    await page.getByRole('button', {name: 'Finish email change'}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    await expect(page.getByText('changed@example.com', {exact: true})).toBeVisible();
    assert.equal((await db.prepare('SELECT count(*) AS n FROM passkeys').first())!.n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM totp_credentials').first())!.n, 1);
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await login(next);
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
    await login(next, 'changed@example.com');
    await expect(page.getByRole('heading', {name: 'Verify your sign-in'})).toBeVisible();
    await page.getByRole('button', {name: 'Use a passkey', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account/security');
    // Profile edits are separate from the security grant and work on narrow screens.
    await page.getByRole('link', {name:'Account settings',exact:true}).click();
    await expect(page).toHaveURL(origin + '/account/profile');
    await page.getByLabel('Display name',{exact:true}).fill('Updated Browser User');
    await page.getByRole('button',{name:'Save display name'}).click();
    await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Updated Browser User');
    await page.getByLabel('Username',{exact:true}).fill('Browser_User');
    await page.getByRole('button',{name:'Save username'}).click();
    await expect(page.getByLabel('Username',{exact:true})).toHaveValue('browser_user');
    await expect(page.getByRole('button',{name:'Save username'})).toBeEnabled();
    for (const username of ['browser_user_changed','browser_user']) {
      await page.getByLabel('Username',{exact:true}).fill(username);
      await page.getByRole('button',{name:'Save username'}).click();
      await expect(page.getByLabel('Username',{exact:true})).toHaveValue(username);
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    await page.getByRole('link',{name:/View public profile/}).click();
    await expect(page.getByRole('heading',{name:'Updated Browser User',exact:true})).toBeVisible();
    await expect(page.getByText('@browser_user',{exact:true})).toBeVisible();
    await expect(page).toHaveURL(origin + '/authors/browser_user');
    await page.goto(origin + '/account/profile');
    const inputPicture = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width=300; canvas.height=200;
      canvas.getContext('2d')!.fillRect(0,0,300,200); return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('Profile picture',{exact:true}).setInputFiles({name:'picture.png',mimeType:'image/png',buffer:Buffer.from(inputPicture,'base64')});
    await page.getByRole('button',{name:'Upload picture'}).click();
    await expect(page.getByRole('img',{name:'Current profile picture'})).toBeVisible();
    const pictureUrl = await page.getByRole('img',{name:'Current profile picture'}).getAttribute('src');
    const imageResponse = await context.request.get(pictureUrl!); assert.equal(imageResponse.status(),200);
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByRole('navigation',{name:'Account settings'})).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),false);
    await page.screenshot({path:'/tmp/blockwork-profile-mobile.png',fullPage:true});
    await page.getByRole('button',{name:'Remove picture'}).click();
    assert.equal((await context.request.get(pictureUrl!)).status(),404);
    await page.getByRole('navigation',{name:'Account settings'}).getByRole('link',{name:'Security',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Account security',exact:true})).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),false);
    const replace = await page.getByRole('button',{name:'Replace authenticator app'}).boundingBox();
    const remove = await page.getByRole('button',{name:'Remove authenticator app'}).boundingBox();
    assert.ok(replace && remove && remove.y >= replace.y + replace.height + 8);
    await page.screenshot({path:'/tmp/blockwork-security-mobile.png',fullPage:true});
    await page.setViewportSize({width:1280,height:900});
    const replaceWide=await page.getByRole('button',{name:'Replace authenticator app'}).boundingBox();
    const removeWide=await page.getByRole('button',{name:'Remove authenticator app'}).boundingBox();
    assert.ok(replaceWide && removeWide && Math.abs(replaceWide.y-removeWide.y)<1 && removeWide.x >= replaceWide.x+replaceWide.width+8);
    await page.screenshot({path:'/tmp/blockwork-security-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'Lock security settings'}).click();
    await page.getByRole('navigation',{name:'Account settings'}).getByRole('link',{name:'Profile',exact:true}).click();
    await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Updated Browser User');
    await page.goto(origin + '/support/new');
    await expect(page.locator('input[name=email]')).toHaveCount(0);
    await expect(page.getByText('Replies go to your account email: changed@example.com.')).toBeVisible();
    await page.getByLabel('Subject',{exact:true}).fill('Browser ticket');
    await page.getByLabel("What's going on?",{exact:true}).fill('Testing the account ticket flow.');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect(page.getByRole('heading',{name:/Browser ticket/})).toBeVisible();
    await page.goto(origin + '/account/security');
    await page.getByRole('button',{name:'Unlock with a passkey'}).click();
    await page.getByRole('link',{name:'Deactivate or delete account'}).click();
    await page.getByLabel('Deactivate my account',{exact:true}).check();
    await page.getByRole('button',{name:'Confirm deactivation'}).click();
    await expect(page).toHaveURL(origin + '/login');
    assert.equal((await context.request.get(origin + '/authors/browser_user')).status(),404);
    await page.getByRole('button',{name:'Sign in with a passkey'}).click();
    await expect(page.getByRole('heading',{name:'Reactivate account',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Reactivate my account'}).click();
    await expect(page).toHaveURL(origin + '/account/profile');
    assert.equal((await context.request.get(origin + '/authors/browser_user')).status(),200);
    await page.getByRole('navigation',{name:'Account settings'}).getByRole('link',{name:'Security',exact:true}).click();
    await page.getByRole('button',{name:'Unlock with a passkey'}).click();
    await page.getByRole('link',{name:'Deactivate or delete account'}).click();
    await page.getByLabel('Type DELETE to confirm').fill('DELETE');
    await page.getByRole('button',{name:'Delete my account permanently'}).click();
    await expect(page).toHaveURL(origin + '/login');
    assert.equal((await context.request.get(origin + '/authors/browser_user')).status(),404);
    assert.equal((await db.prepare('SELECT count(*) n FROM email_credentials').first())!.n,0);
    assert.equal((await db.prepare('SELECT count(*) n FROM passkeys').first())!.n,0);
    assert.equal((await db.prepare('SELECT count(*) n FROM totp_credentials').first())!.n,0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await mf.dispose();
    rmSync(build, {recursive: true, force: true});
  }
});
