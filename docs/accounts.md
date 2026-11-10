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
  account and IP. App replacement requires unlocked security settings and revokes
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
- Account security is unlocked once with a password plus enrolled MFA, a passkey,
  or an already-connected provider plus enrolled MFA. The unlock belongs only to
  that browser session. It lasts 30 minutes without security-setting activity
  and at most one hour total; **Lock security settings** ends it immediately.
  A full sign-in directed to Account security also unlocks it. Ordinary older
  sessions are redirected to the unlock prompt on entry. Individual actions no
  longer require a sign-in in the last five minutes. Enrollment and
  passkey removal revoke other sessions and app authorization codes. The new
  authenticator gets a fresh browser session after enrollment; removal requires
  signing in again. **Sign out all browsers and apps** revokes pending proofs too.
- An email reset cannot bypass MFA. Someone who loses all their passkeys,
  authenticator apps and backup codes has no automated way to remove MFA. Support must not override
  this based solely on email access.

## Change linked email

Use **Account security → Change linked email**. Both the current and proposed
addresses receive separate, single-use confirmations valid for one hour. The
current mailbox also receives a cancellation link. Opening a link is read-only:
email scanners cannot approve or cancel a request. The owner must explicitly
confirm both mailboxes, then finish the change from unlocked security settings.
A mailbox confirmation never signs someone in or changes the address by itself.

The old address remains active until finalization. Finalization checks current
ownership, credential generation, both confirmations, unique address ownership
and the active browser's unlock in one D1 transaction. It invalidates other
browser/app sessions, authorization codes and pending recovery proofs, retains
the password and MFA credentials, and rotates the current browser session while
preserving the original settings unlock deadline. Both addresses receive a
completion notice. Replacing a pending request invalidates its earlier links;
failed delivery cancels the pending change. An address on another account cannot
be used to merge accounts. Owners must retain access to the current mailbox;
support cannot substitute a new recovery address.

## Connect and disconnect provider sign-ins

**Connected sign-in accounts** supports one Google identity and one GitHub
identity per account. Connection starts only from a protected POST in unlocked
settings, completes OAuth, then asks the owner to confirm the provider identity.
The flow is tied to that browser session, account and credential generation.
Account IDs, roles, packs, support tickets and MFA remain with the original
account. Identities belonging to another account cannot be connected or moved.
Provider profile email addresses never automatically link or merge accounts.

OAuth uses hashed, one-time state, a host-only SameSite=Lax cookie, PKCE S256,
exact callback addresses and minimum profile scopes. Google ID tokens are also
verified against its public signing keys, including issuer, audience, expiry,
nonce and matching userinfo subject. Tokens are used only for sign-in verification
and discarded; no provider access/refresh tokens are stored.

Disconnect requires another usable primary sign-in: verified email/password,
a passkey, or another connected provider. TOTP and backup codes alone do not
count. Removing the last passkey also checks this rule. Connection changes are
atomic, revoke other sessions and pending proofs, retain the current settings
session deadline, and notify the verified account email when one exists. The
account activity table records successful changes without bearer secrets.
Disconnect removes a sign-in connection in Blockworked; users can also revoke
profile permissions from the provider's own connected-app settings.

Migration `0014_account_connections.sql` backfills existing provider IDs into
explicit identity mappings without changing canonical account IDs or admin IDs.
A disconnected provider signing in again creates a separate account if its old
ID still exists. It cannot silently regain access to the earlier account.
In-flight OAuth sign-ins started before this migration must be restarted.

## Support recovery without impersonation

Staff and administrators have **Account recovery** in the helpdesk navigation.
The tool runs on the canonical community origin at `/staff/accounts` and requires
an MFA-authenticated session with security settings unlocked. A password/provider session alone or a
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

1. Apply D1 migrations `0012_local_accounts.sql`,
   `0013_totp_and_support_recovery.sql` and `0014_account_connections.sql` **before deploying this code**:
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
one-time replay checks, mailbox changes, OAuth linking/unlinking, settings unlocks,
owner-bound linking, reset revocation, encrypted-seed
binding, TOTP replay protection, and staff permissions/recovery audits.

`npm run test:browser` builds the production Worker, runs it in workerd with D1,
and drives a Chromium virtual authenticator through signup, passkey enrollment,
password + passkey MFA, direct passkey login, backup codes, password reset,
authenticator-app enrollment, six-digit-code login, settings re-authentication,
provider connection confirmation and linked-email changes.
Outbound email and breach queries are simulated locally. Install Chromium with
`npx playwright install chromium` or point `CHROMIUM_PATH` to an existing binary.
The test uses only local ephemeral storage and never sends real email.

## Profile and settings navigation

The single **Account settings** navigation entry opens `/account/profile`.
A responsive sidebar switches between Profile and Security (`/account/security`).
Profile edits require a live browser session and exact-Origin POSTs; only the
Security page requires the existing settings unlock. Display names remain
non-unique and can be edited independently of credentials. Provider sign-ins
never overwrite profile edits.

Usernames are optional public handles, separate from email sign-in. They use
3–30 ASCII letters, digits or underscores, begin with a letter, and normalize
to lowercase. A unique database index arbitrates concurrent claims. Team and
staff names are reserved. Username changes have no delay by default. Set `USERNAME_COOLDOWN_DAYS` to a
positive number to restore a configurable cooldown, using the stored last-change
time. Failed attempts do not start a cooldown. Released handles
remain reserved to the same owner for 90 days to limit impersonation. Handles
appear on public author pages and in the app profile API; `/authors/username` is the canonical profile URL. Stable ID URLs and `/@username`
redirect to it without caching redirects across future username changes. Author
links in packs, comments and the app API use the username when present. Claims
that collide with another account’s stable public ID are refused.
Existing users select their own handle rather than inheriting provider names.

Profile edits are limited to 20 requests per account per hour, pictures to 10.
The browser center-crops and re-encodes PNG/JPEG/WebP uploads (up to 5 MiB) into
a 256-pixel static PNG. The server checks chunk structure/checksums, dimensions,
and a bounded decompressed raster; it rejects animation and strips metadata.
Only the current picture is stored in D1. Replacement/removal invalidates its
previous URL and image responses use no-store. Migration `0015_profiles.sql`
is additive and leaves credentials, ownership and sessions intact.

## Support email and account lifecycle

New signed-in support tickets automatically use the verified account email and
do not ask for another address. The server ignores a posted replacement address.
Accounts without an attached email can optionally provide one or leave it blank;
receipts and reply emails are skipped when blank, and answers remain in My tickets.

Security settings link to a separate deactivation/deletion confirmation page.
Both actions require a valid settings unlock, enrolled MFA when present, an
exact-Origin POST and explicit confirmation. Recovery-code sessions must first
sign in using a full credential/MFA method before taking these actions.

Deactivation atomically hides public profiles, packs, comments, downloads and
avatars, increments the credential generation and revokes sessions, app codes and
pending account proofs. Credentials and usernames are preserved. Normal sign-in
must still complete enrolled MFA before it issues a short-lived browser-bound
reactivation intent. An explicit reactivation POST consumes the intent, advances
the credential generation and issues a fresh session. It cannot bypass bans.

Deletion removes email/password credentials, OAuth identities, passkeys, TOTP,
backup codes, profile pictures and personal profile fields. It removes comment
text, unlists packs, redacts owned support ticket contents and contact details,
rotates ticket access keys and queues attachment removal from R2. Failed R2
cleanup retries hourly. An internal tombstone preserves ownership and audit
references; deletion cannot restore sign-in or reassign old packs via OAuth.
Published pack files and existing downloads/backups are not recalled. Minimal
ownership/security audit records remain, as the confirmation page explains.
Migration `0016_account_lifecycle.sql` adds lifecycle flags and the cleanup queue.
