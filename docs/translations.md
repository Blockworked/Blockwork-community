# Blockworked translations

The community Worker serves `https://translate.blockworked.com/`: a project
picker, searchable language cards, and a focused editor. It uses existing Blockworked sessions and the shared
site theme. Weblate remains responsible for files, quality checks, permissions,
history and GitHub pull requests. No translation database is duplicated here.

The editor supports singular strings, every target-language plural form, RTL,
context, notes, skip, review-all, keyboard save, and a completion screen.
Translators also get: a string list per language (50 a page) with filters for
untranslated, needs editing, has suggestions, has comments, failing checks and
translated, plus search over source, translation, context and notes; previous
and next string (Alt+Left/Right); placeholder chips that insert at the caret and
a warning when one is missing; Copy English; the glossary's terms found in the
string (`<project>/glossary`, when the project has one); the source string's
screenshots, proxied through the Worker; the same string in other languages;
suggestions with voting and "use this"; comments (translation, source-string
issue or report); a "needs editing" box; and "Suggest instead" for people unsure
of a translation. It
preserves drafts after failed saves and detects a source or target that changed
since the page was loaded. This last comparison is a best-effort check immediately
before PATCH, not a database transaction spanning the two services. Existing
Weblate reviews remain in Weblate; the contributor UI saves state 20 (translated),
never state 30 (approved). Translation files reach the app through the existing
review/release process.

## Projects

Three components are exposed: `blockwork/ui` (the app), `blockworked/website`
(blockworked.com, `locales/website.pot` in Blockworked/blockworked.com) and
`blockworked/community` (this site, `locales/community.pot`). Both sites are
gettext: the English text is the message id, `npm run i18n:extract` (here) or
`pnpm i18n:extract` (blockworked.com) rewrites the template, and each build
compiles `locales/*.po` and fails while the template is stale. A language
appears on a site once half its strings are translated, and the `bw-lang`
cookie on `blockworked.com` carries the visitor's choice between the two.
Components that don't exist on Weblate yet are left off the project list.

Create the Weblate side once, with an administrator token used only for the run:

```bash
WEBLATE_URL=https://weblate.blockworked.com WEBLATE_ADMIN_TOKEN=... \
  python3 ops/weblate/setup_site_projects.py --translators 8 --reader 9
```

It creates project `blockworked` and both components (gettext PO,
`locales/*.po`, new languages from the template), copies the repository push
settings from `blockwork/ui`, adds the msgmerge add-on, turns suggestion voting
on for all three components, and adds the project to both teams. If either team
selects components rather than projects, add the two new components to it in
Weblate's team settings instead. Then add both components to
`BLOCKWORKED_COMPONENTS` (below) and restart Weblate.

## Language requests

Anyone signed in can ask for a language at `/languages/new` (a Weblate code
such as `pt_BR`, a name and why); others add their support to an open request,
five requests a day per account. Requests are kept in D1
(`language_proposals`, `language_supporters`) and admins are notified. An admin
adds a request, which creates that translation in every exposed component, or
declines it with a reply. Adding needs `WEBLATE_LANGUAGE_TOKEN` (below): a
token for an account with **Add new language** on the exposed projects and
nothing else. Without it, add the language in Weblate and then mark the request
added.

## Configure the Worker

Add these variables to `wrangler.toml`'s `[vars]` or `.dev.vars` for local work:

```toml
TRANSLATE_URL = "https://translate.blockworked.com"
WEBLATE_URL = "https://weblate-backend.example.com"
WEBLATE_COMPONENTS = "blockwork/ui,blockworked/website,blockworked/community"
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
npx wrangler secret put WEBLATE_LANGUAGE_TOKEN   # optional, for language requests
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
   BLOCKWORKED_COMPONENTS = ["blockwork/ui", "blockworked/website", "blockworked/community"]
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
`weblate.utils.change_origin` when available). Weblate 2026.10.1 attributes
changes directly through the authenticated request user; newer releases also
receive the explicit API change-origin context. Recheck compatibility on upgrades. The protocol and adapter tests cover signatures,
scope, account mapping and replay, but do not replace a smoke test on the real
installed Weblate version.

## Identity and permission behavior

Every saved edit carries an HMAC over timestamp, random nonce, UTF-8 public
identity, HTTP method, exact path, and SHA-256 body hash. Requests expire after
60 seconds and nonces are single-use. Only three writes are accepted:
`PATCH /api/units/<id>/` with exactly `target` and state 20 (translated) or 10
(needs editing), `POST /api/units/<id>/suggestions/` with exactly `target` (an
existing suggestion's text counts as a vote), and `POST
/api/units/<id>/comments/` with exactly `scope` (`translation`, `global` or
`report`) and a 1-1000 character `comment`. Approving, accepting or deleting a
suggestion stays in Weblate. The adapter independently checks
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
binds that custom domain; community `/translate` links redirect to it. Account
settings and sign-in remain on `community.blockworked.com`, with an explicitly
allowlisted return URL back to the translation page. `COOKIE_DOMAIN` must remain
`blockworked.com` so the session is shared.

Before assigning the existing translation domain to the Worker, make Weblate
reachable at a separate HTTPS backend hostname (for example,
`weblate.blockworked.com`) and set `WEBLATE_URL` to that origin. Update Weblate's
site domain, allowed hosts, TLS/reverse proxy, and GitHub webhook destination to
the backend hostname so generated API links and repository hooks keep working.
Verify the backend and install the adapter there first, configure the Worker
backend variables and secrets, then enable the `translate.blockworked.com`
custom-domain route in `wrangler.toml` and deploy the Worker to switch the public
host. Every push to `master` deploys automatically, so a new installation should
keep the public-domain route disabled until its backend is ready. The live
installation now has its backend configured and the route enabled. Keep the previous
DNS/proxy configuration available for rollback. Do not point `WEBLATE_URL` back
at the public UI: the Worker rejects that configuration to prevent a request loop.

Local development can use
`TRANSLATE_URL=http://localhost:8787/translate`, as in `.dev.vars.example`.
To disable saves, remove the
Worker signing secret or remove the authenticator from Weblate. To remove the
UI entirely, remove its component allowlist.

## Live backend configuration

The backend runs Weblate 2026.10.1 at `https://weblate.blockworked.com`, through
Cloudflare Tunnel `27bcc95d-55ed-4ba9-ae22-7b6480e9c245`. That tunnel is managed
by Cloudflare: its remote ingress configuration is authoritative. Keep the local
`~/nextcloud/cloudflared/config.yml` synchronized for recovery. Both backend and
original translation host ingress rules remain available for rollback.

The `Blockworked translators` team (ID 8) grants Translate on `blockwork/ui` only,
until `setup_site_projects.py` adds the sites' project. The adapter on the
server must also be replaced with the current file, which accepts suggestions,
votes and comments; the older one refuses them, so those buttons fail until then.
The reader account belongs only to `Blockworked UI reader` (ID 9), with no edit
role. Newly mapped contributors have Weblate's automatic default team memberships
replaced by the dedicated translator team. Native Weblate administration remains
at the backend address.

The adapter is installed in `/app/data/python/blockworked_auth.py`, configured
by `/app/data/settings-override.py`. Secret values are private files in Weblate's
backed-up data volume: `/app/data/blockworked-shared-secret` and
`/app/data/blockworked-reader-token`. A private copy of the signing key also lives
under `~/.config/blockworked-translations/` on the server. Worker secret values
were set directly through Cloudflare and are never committed to Git.

The public `/hooks/github/` endpoint forwards POST requests to the fixed backend
hostname, retaining the event/signature headers and body while stripping account
cookies. This preserves existing GitHub webhook deliveries through the domain
cutover. Weblate still performs the hook validation and repository synchronization.
The backend client uses an explicit application User-Agent so Cloudflare Browser
Integrity Check does not mistake it for an unidentified script.

Before rollout, a private database/configuration/DNS rollback snapshot was saved
on the server under `~/.local/share/blockworked-translations/rollbacks/`; the
`current-rollback` file in its parent records the exact snapshot directory. That
snapshot includes the remote tunnel configuration. Roll back the public hostname
by detaching its Worker custom domain and restoring its saved tunnel CNAME; keep
the backend running and do not restore the whole database over newer contributions.
