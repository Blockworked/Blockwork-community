# Email accounts, passkeys and authenticator apps

The community and helpdesk share the existing Worker/D1 accounts. Local accounts
use opaque `local:<uuid>` IDs; existing provider IDs, pack ownership and support
history stay intact. D1 holds persistent state, so no sticky servers or in-memory
session store are required.

## Behavior

- Signup sends an email verification link. The recipient chooses a password
  **after** opening the link; no unverified password/account is activated. Links
  expire after 60 minutes. GET requests do not consume them, so email scanners
  do not activate accounts.
- Email/password and Google/GitHub are primary sign-in methods. Once a passkey
  or authenticator app is enrolled, all primary sign-ins require a passkey, app
  code or backup code before
  issuing a browser session. Passkeys can also sign in directly, using device
  verification (PIN/biometrics).
- Authenticator apps use standard six-digit, 30-second TOTP codes. Setup shows a
  locally generated QR code and manual key, and requires a valid code before
  activation. Seeds are encrypted in D1 using AES-256-GCM with a random nonce
  and account-bound authenticated data. Enrollment proofs contain encrypted
  seeds too. Codes accept at most one time step of clock drift in either
  direction; accepted time steps cannot be replayed. Verification is limited per
  account and IP. App replacement requires recent authentication and revokes
  other sessions; removing the last enrolled factor is refused.
- Add email credentials to an existing provider account through **Account
  security → Verify email**, while recently signed in. Finish verification in
  the same account after authenticating again if necessary. Accounts never merge
  automatically based on email. An email already attached to another account
  cannot be linked; sign into that account instead.
- Password reset links expire in 30 minutes and work once. Reset changes the
  password and revokes browsers, apps, app authorization codes and pending
  authentication proofs atomically. It preserves passkeys, authenticator apps
  and backup codes and does not log the recipient in.
- Ten random 128-bit backup codes are shown once. Each works once **after** a
  successful primary sign-in. Generating new codes invalidates the previous set.
  A recovery session can enroll a replacement passkey or authenticator app. The
  last factor cannot be removed; add its replacement first.
- Security changes require authentication within five minutes. Enrollment and
  passkey removal revoke other sessions and app authorization codes. The new
  authenticator gets a fresh browser session after enrollment; removal requires
  signing in again. **Sign out all browsers and apps** revokes pending proofs too.
- An email reset cannot bypass MFA. Someone who loses all their passkeys,
  authenticator apps and backup codes has no automated way to remove MFA. Support must not override
  this based solely on email access.

## Support recovery without impersonation

Staff and administrators have **Account recovery** in the helpdesk navigation.
The tool runs on the canonical community origin at `/staff/accounts` and requires
an MFA sign-in within five minutes. A password/provider session alone or a
backup-code recovery session does not grant access to staff recovery tools.

Every lookup and action requires a related ticket and a reason. Staff see masked
verified email, MFA enrollment and unused-code/session counts. They can send a
password-reset email to the **existing verified address** or revoke every browser,
app and pending sign-in proof. Staff cannot change the recipient, receive the
reset token, set a password, expose TOTP seeds/backup codes, remove MFA, or issue
an impersonation session. Provider-only accounts must recover access with the
provider until their owner adds a verified local email.

A D1 audit records the actor, target, ticket, reason, action and timestamp. The
recovery screen shows recent actions for that account. Rate limits protect the
tools and email delivery. Session revocation notifies the verified owner and
preserves every credential and MFA enrollment. Infrastructure administrators can
change deployed code and storage; that access is separate from these application
permissions and needs its own access controls.

## Security controls

Passwords use the audited primitive from `@noble/hashes`: salted scrypt with
`N=32768, r=8, p=3`, a 32-byte output, and a random 256-bit salt. These parameters
follow an [OWASP recommended configuration](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
Only one hash runs at a time per isolate, with at most two queued, to bound memory.
Overload returns 503; it never weakens the hash. Unknown addresses still run a
real dummy hash on password login. Passwords require 15–128 Unicode characters,
allow password managers/pasting, and do not have arbitrary composition rules or
periodic expiration. New passwords are screened against Pwned Passwords using
its padded SHA-1 range API; only five hex characters leave the Worker. Screening
failure blocks password creation/change, while existing logins continue working.
SHA-1 is used only for the breach query, never for password storage.

`@simplewebauthn/server` verifies challenges, RP ID, exact canonical origin,
signatures, presence, verification and counters. Challenges are single-use and
expire after ten minutes. Credential generation checks prevent an in-progress
login or desktop token exchange from surviving credential revocation. Synced
passkeys with a zero counter are supported. Private keys never reach the server.

D1 stores only hashes of session tokens, email links, authentication-flow cookies
and backup codes. Authentication mutations require the exact `SITE_URL` origin;
the helpdesk cannot enroll credentials. Strict host-only, HttpOnly, Secure cookies
bind WebAuthn/recovery ceremonies to the browser. Sessions retain the existing
HttpOnly, Secure, SameSite=Lax shared-domain cookie so the helpdesk works.
**Every sibling subdomain under `COOKIE_DOMAIN` remains inside that trust
boundary**: avoid untrusted hosting or dangling DNS there. Host-only sessions and
an explicit helpdesk SSO exchange would be a separate architecture change.

Shared, atomic D1 limits cover IPs, password addresses and mail requests. Generic
signup/reset responses and background delivery avoid exposing whether an address
exists through mail delivery times. Requests are bounded to 20 KB before parsing.
Security pages use no-store and origin-only referrers and retain the existing
CSP. HTTPS responses set HSTS. Password changes, passkey changes, backup-code generation and
backup-code use send security notices. Authentication mail never logs tokens or
uses the helpdesk's development logging fallback. Hourly cleanup removes expired
proofs, rate-limit buckets, sessions and app codes.

## Rollout

1. Apply D1 migrations `0012_local_accounts.sql` and
   `0013_totp_and_support_recovery.sql` **before deploying this code**:
   `npm run migrate:remote`. The updated provider and desktop login code uses
   the new schema even while local signup is disabled. Take the normal database
   backup before migration and verify on staging first.
2. Use a paid Workers plan with the configured 30,000 ms CPU allowance. Benchmark
   representative logins under load and monitor CPU, memory and 503s; do not
   lower scrypt parameters to fit the free plan. D1 rate limits are application
   protection; use Cloudflare edge rate limits/WAF for distributed abuse before
   requests reach hashing or D1.
3. Configure a verified SMTP2GO sender in `AUTH_FROM` (default: `noreply@blockworked.com`) and the existing
   `SMTP2GO_API_KEY` secret. Use `wrangler secret put SMTP2GO_API_KEY`, never chat
   or source control for the value. Configure SPF, DKIM and DMARC for the sender
   domain and test real delivery. Allow outbound HTTPS to `api.smtp2go.com` and
   `api.pwnedpasswords.com`. This is outbound transactional mail, not a mailbox.
4. Provision `AUTH_TOTP_KEY` as a Worker secret: exactly 32 cryptographically
   random bytes encoded as unpadded base64url (43 characters). Generate it in a
   secure local process and pipe it to `wrangler secret put AUTH_TOTP_KEY`; do not
   print it to logs/chat or store it in source control. Back up this key securely
   alongside the recovery plan. Losing it makes existing authenticator seeds
   unreadable. A future rotation must re-encrypt stored seeds before removing the
   old key; changing the key alone will break app verification.
5. Keep `SITE_URL` on its canonical HTTPS host; passkeys are scoped to that host.
   Review the shared cookie-domain trust boundary. Exclude authentication URLs,
   query tokens, cookies, passwords and request bodies from access/error logs and
   analytics. No reset/verification redirect is derived from a request Host header.
6. Set `LOCAL_AUTH_ENABLED = "true"`, deploy, then test signup, verification,
   provider linking, a real passkey on supported devices, authenticator-app
   setup/login, backup recovery, password reset and desktop revocation. Keep the flag enabled after users
   enroll passkeys: disabling credential routes does not disable their MFA.
7. Monitor authentication errors, mail failures, rate limiting and dependency
   advisories. Schedule an independent security review before production rollout;
   passing tests does not establish an audited authentication service.

## Verification

`npm run typecheck` and `npm test` include real SQLite transactions, signed
WebAuthn fixtures, missing-verification/wrong-origin/signature failures,
one-time replay checks, owner-bound linking, reset revocation, encrypted-seed
binding, TOTP replay protection, and staff permissions/recovery audits.

`npm run test:browser` builds the production Worker, runs it in workerd with D1,
and drives a Chromium virtual authenticator through signup, passkey enrollment,
password + passkey MFA, direct passkey login, backup codes, password reset,
authenticator-app enrollment and six-digit-code login.
Outbound email and breach queries are simulated locally. Install Chromium with
`npx playwright install chromium` or point `CHROMIUM_PATH` to an existing binary.
The test uses only local ephemeral storage and never sends real email.
