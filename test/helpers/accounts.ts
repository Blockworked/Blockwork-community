import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { Env } from '../../src/index.ts';
import { login, callback } from '../../src/oauth.ts';
import { localAuth } from '../../src/local-auth.ts';

/** Real SQLite constraints, RETURNING, and transactions behind the D1 interface. */
export function fixture(beforeConnections?: (sql: DatabaseSync) => void) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(new URL('../../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    if (file.startsWith('0014_')) beforeConnections?.(sql);
    sql.exec(readFileSync(new URL('../../migrations/' + file, import.meta.url), 'utf8'));
  }
  class Statement {
    query: string; values: unknown[] = [];
    constructor(query: string) { this.query = query; }
    bind(...values: unknown[]) { this.values = values; return this; }
    async first() { return sql.prepare(this.query).get(...this.values as any[]) ?? null; }
    async all() { return {results: sql.prepare(this.query).all(...this.values as any[])}; }
    async run() {
      // D1 reports total changes, including writes performed by triggers.
      const before = Number(sql.prepare('SELECT total_changes() AS n').get()!.n);
      sql.prepare(this.query).run(...this.values as any[]);
      return {meta: {changes: Number(sql.prepare('SELECT total_changes() AS n').get()!.n) - before}};
    }
  }
  const db = {prepare: (q: string) => new Statement(q), async batch(statements: Statement[]) {
    sql.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
    catch (e) { sql.exec('ROLLBACK'); throw e; }
  }};
  const env = {DB: db, SITE_URL: 'https://community.example.com', ADMINS: '', LOCAL_AUTH_ENABLED: 'true', AUTH_TOTP_KEY: 'A'.repeat(43), SMTP2GO_API_KEY: 'test', COOKIE_DOMAIN: 'example.com'} as unknown as Env;
  async function request(path: string, body?: object, cookie = '', origin = env.SITE_URL) {
    const req = new Request(env.SITE_URL + path, body ? {method: 'POST', headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {headers: {Cookie: cookie}});
    let response = await localAuth(req, env);
    if (!response) {
      const match = /^\/auth\/(github|google)\/(login|callback)$/.exec(new URL(req.url).pathname);
      if (match) response = match[2] === 'login' ? await login(env, match[1] as 'github' | 'google', new URL(req.url).searchParams.get('next')) : await callback(req, env, match[1] as 'github' | 'google');
    }
    if (!response) throw new Error('No account route');
    return response;
  }
  return {sql, env, request};
}
export function cookieOf(response: Response, name = 'session'): string {
  const item = response.headers.getSetCookie().find(s => s.startsWith(name + '=') && !s.startsWith(name + '=;'));
  return item?.split(';')[0] ?? '';
}

/** A signing authenticator fixture; assertions go through the production WebAuthn verifier. */
export function authenticator(rp = 'community.example.com') {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const jwk = publicKey.export({format: 'jwk'});
  const id = crypto.getRandomValues(new Uint8Array(32));
  const id64 = Buffer.from(id).toString('base64url');
  const publicCose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  let count = 0;
  const client = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({type, challenge, origin, crossOrigin: false}));
  const auth = (flags: number, counter: number) => { const n = Buffer.alloc(4); n.writeUInt32BE(counter); return Buffer.concat([createHash('sha256').update(rp).digest(), Buffer.from([flags]), n]); };
  return {
    id: id64,
    registration(challenge: string, origin = 'https://' + rp, verified = true) {
      const data = Buffer.concat([auth(0x41 | (verified ? 4 : 0), 0), Buffer.alloc(16), Buffer.from([0, id.length]), id, publicCose]);
      const attestation = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]));
      return {id: id64, rawId: id64, type: 'public-key', clientExtensionResults: {}, response: {clientDataJSON: client('webauthn.create', challenge, origin).toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal']}};
    },
    assertion(challenge: string, origin = 'https://' + rp, verified = true) {
      const data = client('webauthn.get', challenge, origin);
      const authData = auth(1 | (verified ? 4 : 0), ++count);
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(data).digest()]), privateKey);
      return {id: id64, rawId: id64, type: 'public-key', clientExtensionResults: {}, response: {clientDataJSON: data.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url')}};
    },
  };
}
