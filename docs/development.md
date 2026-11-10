# Development and deployment

[Back to README](../README.md). Run commands from the repository root.

## Library routes and rendering

- `GET /index.json` lists each listed pack's newest approved version, in
  the format Blockwork reads. Each entry pins the file's SHA-256, and
  `official` marks the team account's packs (Blockwork shows a verified
  badge for them, from this library only).
- `GET /packs/<sha256>.json` serves an approved pack file.
- `/` lists packs with search (names, blocks, descriptions, authors) and
  filters for permissions, official packs and sort order, all as query
  parameters (`?q=&uses=&official=1&sort=`).
- `/packs/<id>` is a pack's page: its blocks, what they can do, its
  versions and comments. `/packs/<id>/source` shows the pack in Blockwork's
  own editor or as the pack file (`?view=json`, `?v=<sha256>` for an older
  version). `/authors/<public id>` lists one account's packs.
- The site never draws blocks itself. The source view embeds the pack viewer,
  blockworked.com's web build of the editor (`/packview/`, built from
  `qt-demo/PackView.qml` in that repo), and `/browse.js` hands it the pack.
  Cards and block lists show pictures that viewer drew (`src/renders.ts`):
  opening a version's review page draws and saves them (PNGs per theme in R2
  under `renders/<sha256>/`), and `/admin/renders` draws any still missing.
  `MAIN_SITE_URL` says where the viewer lives (and goes in the CSP's
  `frame-src`).
- Signed-in accounts can comment on a pack; the writer, the pack's owner and
  admins can delete a comment.
- `/submit` takes uploads, `/me` shows their status, `/admin` is the review
  queue (approve, reject with a reason, take a pack down, ban an account).

A pack id belongs to the account that first submitted it, so only that
account can publish new versions. A new upload stays pending, and the
listed version stays up until it's approved.

`packs/` and `index.json` hold the starter packs. Blockwork releases that
still read `index.json` from this repo keep working, and `npm run seed:*`
loads the same packs into the Worker.

## Running it

Needs Node and a Cloudflare account.

```bash
npm install
npm run migrate:local && npm run seed:local
npm run dev        # http://localhost:8787
npm test           # pack, api, auth, browse and support tests
npm run typecheck
```

What a pack's blocks can do (the "This pack can" list) comes from
`src/capabilities.json`, a copy of Blockwork's `blockwork-core/capabilities.json`.
After a Blockwork change to it, run `node scripts/sync-capabilities.js
[path/to/Blockwork]`; `npm test` fails while a `../Blockwork` checkout disagrees.

Locally, copy `.dev.vars.example` to `.dev.vars` and fill it in. It points
the site, the helpdesk (`localhost:8787/support`) and sign-in at localhost and
makes you an admin.

## The app's API

Blockwork signs in through the browser: it listens on `127.0.0.1`, opens
`/app/login?port&state&challenge&label`, and the page sends a one-time code
back to that port once the person confirms. The app swaps the code and its
PKCE verifier at `POST /api/v1/app/token` for a token that lasts a year.
Everything under `/api/v1/` takes that token as `Authorization: Bearer`,
never the site's cookie:

- `GET /api/v1/packs/:id`: a pack's versions and comments
- `POST /api/v1/packs/:id/comments`, `DELETE /api/v1/comments/:id`
- `GET /api/v1/me`: the account and its packs, every upload with its review status
- `POST /api/v1/packs`: upload a `.blockpack` (a new pack or an update), reviewed like the form's
- `POST /api/v1/app/logout`

## Deploying

1. `npx wrangler d1 create blockwork-library` and put the id in
   `wrangler.toml`; `npx wrangler r2 bucket create blockwork-library`.
2. Set `SITE_URL` and `ADMINS` in `wrangler.toml`. Adding an admin or
   changing who is told about tickets (`SUPPORT_NOTIFY`) is an edit there and
   a deploy.
3. Create a GitHub OAuth app and a Google OAuth client with callbacks
   `<SITE_URL>/auth/github/callback` and `<SITE_URL>/auth/google/callback`,
   then `npx wrangler secret put` each of the four client values.
4. `npm run migrate:remote && npm run seed:remote && npm run deploy`.

After that, every push to master deploys on its own
(`.github/workflows/deploy.yml`): it typechecks, runs the tests, applies any
new migrations and deploys the Worker. When a push changes `packs/`, it
then runs `npm run seed:remote` to publish the starter packs to the live
library. Manual workflow runs also reseed, so they can retry a failed seed.
It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (a token from the
"Edit Cloudflare Workers" template, with permission to edit D1 and write
R2 objects) and `CLOUDFLARE_ACCOUNT_ID`.
