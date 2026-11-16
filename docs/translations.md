# Blockworked translations

The community Worker serves `https://translate.blockworked.com/`: a project
picker, searchable language cards, and a focused editor. It uses existing Blockworked sessions and the shared
site theme. Weblate remains responsible for files, quality checks, permissions,
history and GitHub pull requests. No translation database is duplicated here.

The editor supports singular strings, every target-language plural form, RTL,
context, notes, skip, review-all, keyboard save, and a completion screen. It
preserves drafts after failed saves and detects a source or target that changed
since the page was loaded. This last comparison is a best-effort check immediately
before PATCH, not a database transaction spanning the two services. Existing
Weblate reviews remain in Weblate; the contributor UI saves state 20 (translated),
never state 30 (approved). Translation files reach the app through the existing
review/release process.

## Configure the Worker

Add these variables to `wrangler.toml`'s `[vars]` or `.dev.vars` for local work:

```toml
TRANSLATE_URL = "https://translate.blockworked.com"
WEBLATE_URL = "https://weblate-backend.example.com"
WEBLATE_COMPONENTS = "blockwork/ui"
WEBLATE_TRANSLATION_LICENSE = "GPL-3.0-only"
```

Use the actual component slugs from Weblate. The allowlist is comma-separated;
only explicitly listed components are exposed. **Their strings become public
through this UI**, including source text, notes and context. Only list projects
intended for public community translation. `WEBLATE_URL` must be an HTTPS origin,
without a path, query or credentials. It must use a different origin from `TRANSLATE_URL`. Set the license to the actual license of
all exposed projects (the existing Blockwork setup specifies GPL-3.0-only).

Set Worker secrets through Wrangler, never in source control:

```bash
npx wrangler secret put WEBLATE_READ_TOKEN
npx wrangler secret put WEBLATE_SHARED_SECRET
```

`WEBLATE_READ_TOKEN` belongs to a dedicated Weblate account with only **View
project** access to the exposed projects, or an equivalent project-scoped token.
Do not use an administrator token. Public Weblate reads work without this token,
but have a very small anonymous API quota, so configure the token for production.

Generate a random signing secret of at least 32 characters (for example,
`openssl rand -hex 32`). Store the same value as `WEBLATE_SHARED_SECRET` in the
Worker and `BLOCKWORKED_SHARED_SECRET` on the Weblate server. Neither secret nor
read token is sent to the browser. Read tokens are never sent on signed edits;
credentials are never forwarded through HTTP redirects or API-provided links.

Without URL/components configured, the page shows a setup message. Without a
signing secret, browsing works but editing is disabled. Do not enable saves
until the server adapter below has been installed and tested.

## Install the Weblate authentication adapter

`ops/weblate/blockworked_auth.py` provides a narrowly scoped DRF authenticator.
This is server customization, not a new Weblate login provider. Contributors
sign in on Blockworked; the Worker signs individual translation edits. Normal
Weblate administration/login is unchanged.

1. Create a dedicated **Blockworked translators** team in Weblate. Give it the
   **Translate** role for only the exposed projects. Do not grant Review,
   management, repository administration, or global permissions. Record its
   numeric ID from its administration URL.
2. Install `ops/weblate/blockworked_auth.py` as the importable module
   `blockworked_auth` inside Weblate. With the official Docker image, mount it at
   `/app/data/python/blockworked_auth.py` (the additional Python module directory).
   The file needs to be readable by the Weblate container user.
3. Merge the following into Weblate's existing
   `/app/data/settings-override.py`. Preserve any other custom settings and
   existing authentication classes:

   ```python
   import os

   BLOCKWORKED_SHARED_SECRET = os.environ["BLOCKWORKED_SHARED_SECRET"]
   BLOCKWORKED_COMPONENTS = ["blockwork/ui"]
   BLOCKWORKED_TRANSLATOR_GROUP_ID = 123  # actual team ID
   REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"] = (
       "blockworked_auth.SignedBlockworkedAuthentication",
       *REST_FRAMEWORK["DEFAULT_AUTHENTICATION_CLASSES"],
   )
   ```

4. Pass `BLOCKWORKED_SHARED_SECRET` to the container from your server's secret
   configuration. For Compose, extend the existing override, for example:

   ```yaml
   services:
     weblate:
       environment:
         BLOCKWORKED_SHARED_SECRET: ${BLOCKWORKED_SHARED_SECRET:?Set the shared signing secret}
       volumes:
         - ./blockworked_auth.py:/app/data/python/blockworked_auth.py:ro
         # Merge into your existing settings override instead if one is already mounted.
         - ./settings-override.py:/app/data/settings-override.py:ro
   ```

5. Restart Weblate. Confirm its Django cache uses a shared backend such as the
   official Docker setup's Redis. Replay prevention relies on atomic `cache.add`
   across processes; a per-process memory cache is unsuitable in production.
6. Check the module imports and settings before enabling the Worker:

   ```bash
   docker compose exec weblate weblate shell -c 'from blockworked_auth import SignedBlockworkedAuthentication; from django.conf import settings; print(settings.BLOCKWORKED_COMPONENTS, settings.BLOCKWORKED_TRANSLATOR_GROUP_ID)'
   ```

The adapter uses Weblate internals (`User`, `Group`, `Unit`, and
`weblate.utils.change_origin`). Verify compatibility with your installed Weblate
release and recheck on upgrades. The protocol and adapter tests cover signatures,
scope, account mapping and replay, but do not replace a smoke test on the real
installed Weblate version.

## Identity and permission behavior

Every saved edit carries an HMAC over timestamp, random nonce, UTF-8 public
identity, HTTP method, exact path, and SHA-256 body hash. Requests expire after
60 seconds and nonces are single-use. Only `PATCH /api/units/<id>/` with exactly
`target` and translated state 20 is accepted. The adapter independently checks
its own component allowlist before creating or selecting a contributor.

Contributor usernames derive from the immutable Blockworked account ID, never
from a changeable display name. Accounts get an unusable password, the public
display name, a stable synthetic `.invalid` email (no real email is shared), and
membership of the explicitly configured translation team. The Weblate change
origin is recorded as API with the real mapped contributor as acting user.
Weblate's own translation permissions and locks still apply. Existing Weblate
accounts/history are not merged by email or display name; these are new mapped
accounts.

Banned, deactivated and deleted Blockworked accounts cannot obtain a valid
community session and therefore cannot initiate signed edits. Removing an
existing mapped account from the translation team or deactivating it in Weblate
also blocks future edits; the adapter does not restore removed membership.
Account deletion does not automatically erase published translation history or
Git commits. Treat contributor names/history under the project's contribution
and retention policy. No password or native Weblate API token is issued to a
mapped contributor.

## Validation and rollout

```bash
npm run typecheck
npm test
npm run test:browser
# In a Python environment with Django and djangorestframework installed:
python -m unittest discover -s ops/weblate
npx wrangler deploy --dry-run
```

The browser test runs the actual Worker in workerd with D1 and an intercepted
Weblate API. It verifies shared-session attribution and HMAC signing, failed
save draft retention, keyboard save, all plural forms, theme switching, and
mobile sizing. `CHROMIUM_PATH` can select an installed Chromium executable.
`TRANSLATION_SCREENSHOT=/tmp/editor.png` saves desktop and mobile screenshots
of the local test fixture.

Before going live, test on the actual Weblate instance: browse a configured
language, sign in with a normal Blockworked account, save a disposable/test
string, verify its individual author and translated state in Weblate, verify
an edit to a different project is refused, and verify a removed team member
cannot save. Then publish the Worker through the existing deployment process.
The public UI stays at `https://translate.blockworked.com/`. The Worker config
includes that custom domain as a commented route until the backend is ready; community `/translate` links redirect to it. Account
settings and sign-in remain on `community.blockworked.com`, with an explicitly
allowlisted return URL back to the translation page. `COOKIE_DOMAIN` must remain
`blockworked.com` so the session is shared.

Before assigning the existing translation domain to the Worker, make Weblate
reachable at a separate HTTPS backend hostname (for example,
`weblate.blockworked.com`) and set `WEBLATE_URL` to that origin. Update Weblate's
site domain, allowed hosts, TLS/reverse proxy, and GitHub webhook destination to
the backend hostname so generated API links and repository hooks keep working.
Verify the backend and install the adapter there first, configure the Worker
backend variables and secrets, then uncomment the `translate.blockworked.com`
custom-domain route in `wrangler.toml` and deploy the Worker to switch the public
host. The route is disabled initially because every push to `master` deploys
automatically; publishing the code must not take over the existing Weblate host
before its replacement is ready. Keep the previous
DNS/proxy configuration available for rollback. Do not point `WEBLATE_URL` back
at the public UI: the Worker rejects that configuration to prevent a request loop.

Local development can use
`TRANSLATE_URL=http://localhost:8787/translate`, as in `.dev.vars.example`.
To disable saves, remove the
Worker signing secret or remove the authenticator from Weblate. To remove the
UI entirely, remove its component allowlist.
