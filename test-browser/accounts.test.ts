// Production bundle in workerd + D1, driven by Chromium's virtual WebAuthn authenticator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { totp } from '../src/totp.ts';
import { chromium, expect } from '@playwright/test';

test('email verification, passwords, browser passkeys, backup codes and reset in Workers', {timeout: 120000}, async () => {
  const build = mkdtempSync(join(tmpdir(), 'blockwork-auth-'));
  const compile = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', build], {encoding: 'utf8'});
  assert.equal(compile.status, 0, compile.stderr);
  const mail: any[] = [];
  const options = {
    rootPath: build, modulesRoot: build, modules: [{type: 'ESModule', path: join(build, 'index.js')}], compatibilityDate: '2026-10-01',
    d1Databases: ['DB'], r2Buckets: ['PACKS'],
    bindings: {SITE_URL: 'http://localhost', ADMINS: '', LIBRARY_NAME: 'Test community', LOCAL_AUTH_ENABLED: 'true', AUTH_TOTP_KEY: 'A'.repeat(43), SMTP2GO_API_KEY: 'test'},
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      if (url.hostname === 'api.pwnedpasswords.com') return new Response('0'.repeat(35) + ':0');
      if (url.hostname === 'api.smtp2go.com') { mail.push(await req.json()); return Response.json({data: {succeeded: 1, failed: 0}}); }
      return new Response('Unexpected outbound request', {status: 502});
    },
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  let browser;
  try {
    const ready = await mf.ready;
    const origin = `http://localhost:${ready.port}`;
    await mf.setOptions(convertV4MiniflareOptions({...options, port: Number(ready.port), bindings: {...options.bindings, SITE_URL: origin}}));
    const db = await mf.getD1Database('DB');
    for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) {
      for (const statement of readFileSync(join('migrations', file), 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    }
    browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}), args: ['--no-sandbox']});
    const context = await browser.newContext();
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
    async function login(password: string) {
      await page.goto(origin + '/login');
      await page.getByLabel('Email', {exact: true}).fill('browser@example.com');
      await page.getByLabel('Password', {exact: true}).fill(password);
      await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    }
    await login(initial);
    await expect(page.getByRole('heading', {name: 'Account security', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Add passkey', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account?enrolled=1');
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
    await expect(page).toHaveURL(origin + '/account');
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await page.goto(origin + '/login');
    await page.getByRole('button', {name: 'Sign in with a passkey'}).click();
    await expect(page).toHaveURL(origin + '/account');
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await login(initial);
    await page.getByLabel('Backup code', {exact: true}).fill(backupCodes[0]);
    await page.getByRole('button', {name: 'Use backup code', exact: true}).click();
    await expect(page).toHaveURL(origin + '/account');
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
    await expect(page).toHaveURL(origin + '/account');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM passkeys').first())!.n, 1);
    await page.getByRole('button', {name: 'Set up authenticator app', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Set up an authenticator app'})).toBeVisible();
    const appSecret = await page.locator('pre').innerText();
    assert.match(appSecret, /^[A-Z2-7]+$/);
    await expect(page.locator('svg').filter({has: page.locator('path')})).not.toHaveCount(0);
    await page.getByLabel('Six-digit code', {exact: true}).fill(totp(appSecret).generate());
    await page.getByRole('button', {name: 'Confirm authenticator app'}).click();
    await expect(page).toHaveURL(origin + '/account');
    await expect(page.getByText('Enabled. Your app generates a new six-digit code every 30 seconds.')).toBeVisible();
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await login(next);
    await page.getByLabel('Six-digit code', {exact: true}).fill(totp(appSecret).generate({timestamp: Date.now() + 30000}));
    await page.getByRole('button', {name: 'Verify authenticator code'}).click();
    await expect(page).toHaveURL(origin + '/account');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM totp_credentials').first())!.n, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await mf.dispose();
    rmSync(build, {recursive: true, force: true});
  }
});
