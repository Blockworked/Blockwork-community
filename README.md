# Blockwork community blocks

The block library Blockwork shows under My Blocks > Browse library, served
by a Cloudflare Worker. People sign in with GitHub or Google to submit
packs; every upload is reviewed before it's listed.

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

## Adding a pack

1. Make the blocks in a macro, then right-click one in the My Blocks palette
   and pick "Share blocks as a pack...". Blocks they call come along.
2. Sign in on the library site, open Submit a pack and upload the file.
   Keep the same id for later versions so they replace the old blocks.

Each entry in `blocks.block_defs` can include `identifier` (for example,
`ClickGrid`) and `description` for Blockwork's Details screen. These can
also be set in the app's Make/Edit Block dialog. Keep the internal `id`
stable across versions so installed calls continue to match. An uploaded
`identifier` can't contain `:`; the site stores each one as
`<uploader>:<identifier>` (letters and digits of the account name, then the
ID), so `JohnDoe:OpenYouTubeStudio`, and sets the file's `author` to the
account name. The starter packs predate this and keep `Blockworked_ClickGrid`,
which Blockwork shows as `Blockworked:ClickGrid`. Set `description` on each
block to explain its inputs and behavior. Older packs without these fields still load.
Run `python3 scripts/build-block-index.py` after editing starter packs to
refresh their checksums.

A pack's variables are private to it in Blockwork, so use plain names
(`line`, not `Author pack: line`); they can't clash with the user's own.
Starter packs before 1.1.0 carried a `Blockworked <pack>: ` prefix.

Inputs can include an optional `default_value` literal. Blockwork uses it in
the sidebar and for new calls; updating a pack preserves existing call values.
For example, an active-window input can start empty and a monitor input at 1:

```json
[
  {"kind":"Input","id":"window-input","name":"window","value_type":"Any","default_value":{"kind":"Text","value":""}},
  {"kind":"Input","id":"monitor-input","name":"monitor","value_type":"Any","default_value":{"kind":"Number","value":1}}
]
```

`Any` inputs accept `Text` or finite `Number` defaults. `Bool` inputs accept
`{"kind":"Bool","value":true}` or `false` in the same shape. Defaults cannot
contain expressions or custom block calls. Without a default, inputs keep the
legacy zero or empty Boolean slot. Older app versions ignore the new field.

## Official packs

These packs combine multiple built-in blocks into reusable workflows. Their
definitions were checked against Blockwork's instruction and operator palettes.

| Pack | Blocks |
| --- | --- |
| Clipboard tools | Remove duplicate lines, remove blank lines, clean whitespace |
| Text extraction | Text between literal markers, all lines containing text, value for a `key=value` key |
| Window layouts | Center on a monitor, tile two windows side by side, capture geometry, restore geometry |
| Mouse patterns | Click a grid, drag through points, click relative to a window |
| Mouse helpers | Click, double click, right click and drag at a screen position |
| Text helpers | Check for empty text, get the last letter |

Clipboard tools replace clipboard text after processing it. Line-based blocks
accept LF, CRLF and CR, and produce LF. Duplicate lines and text markers match
exactly, including case. Key lookup trims keys and values, uses the first
matching entry and preserves additional `=` signs in its value.

Window patterns match the first window whose title or app contains the text.
Use patterns that identify different windows for tiling. Monitor numbers start
at 1; layouts use the full monitor rectangle, including panels. Window control
depends on the desktop, and window managers may enforce minimum sizes. Save
the geometry reporter's JSON in a variable, then pass it to the restore block;
it records position and size, not maximized or minimized state.

Mouse grids use absolute screen coordinates and visit columns within each row.
Rows and columns are nonnegative whole numbers; spacing may be negative.
Drag paths contain at least two `x,y` pairs separated by semicolons, such as
`100,100; 200,200`. Line-separated paths are also supported. Pauses
are in milliseconds. Window-relative clicks use offsets from the client area's
top-left and focus the window before clicking.

The first four packs are generated with stable IDs (`build-official-packs.py`
copies its pack settings from `text-helpers.json`). Mouse helpers and Text
helpers are edited by hand:

```bash
python3 scripts/build-official-packs.py
python3 scripts/build-block-index.py
```

For behavior tests using Blockwork's actual Rust parser and interpreter, first
build `blockwork-core` in a Blockwork checkout with the current Rust toolchain,
then run:

```bash
npm run test:runtime -- /path/to/Blockwork/target/debug/deps
```

These tests simulate clipboard/window I/O and record mouse events without
controlling the desktop. They cover all 13 official blocks, Unicode and literal
matching, line endings, invalid inputs, monitor offsets and action order.

CI runs them, and `node scripts/sync-capabilities.js --check`, against the
Blockwork commit in `.blockwork-rev`. Move that commit when Blockwork's
runner or capability table changes.

Reviewers: read the whole pack. The review page lists what its blocks can
do, but a pack in this library should not run commands, go online, write
files or read secrets unless that's plainly its purpose.

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

## Support

The same Worker is the helpdesk at support.blockworked.com (`src/support.ts`).
Signed-in accounts file tickets on the site; anyone can email
support@blockworked.com. Staff (`ADMINS` plus `SUPPORT_STAFF`) answer from
`/queue`, and each answer is emailed to whoever filed the ticket through
smtp2go. They can reply by email (matched by `In-Reply-To` or the `[#n]` in the
subject, and only from the address that filed it) or on the ticket's page,
which the emailed link opens without an account. `SUPPORT_NOTIFY` hears about
pack submissions, new tickets and requester replies.

Ticket forms and replies accept PNG, JPEG, GIF and WebP images (up to four,
3 MiB each and 6 MiB total). Incoming emails keep these image attachments,
including inline images; other attachment types are omitted with a note.
The total incoming email limit is 10 MiB. Invalid or oversized image attachments
reject the email. Images appear in the ticket thread and are attached to staff
notification emails, receipts and staff answers. Internal-note images stay on
the site. R2 stores images under `support/`; downloads require access to the
parent ticket, and internal-note images require staff access. Apply migration
`0011_ticket_attachments.sql` before deploying.

Staff notification channels run independently; failures are logged and do not
reject the submission. Delivery is best effort, without automatic retries.
Pack uploads through both the website and app send a link to their review page.
Requester emails continue to use smtp2go regardless of staff push settings.

To enable all three staff notification channels:

- Keep `SUPPORT_NOTIFY` set to the recipient addresses and configure
  `SMTP2GO_API_KEY` for email.
- Run `wrangler secret put NTFY_TOPIC` with a private topic, subscribe to it
  in the ntfy app, and optionally set `NTFY_TOKEN` for an access-controlled
  topic. Set `NTFY_URL` in `[vars]` for a self-hosted server (default:
  `https://ntfy.sh`). A topic name alone is a bearer secret on public ntfy;
  use an access-controlled topic for private support messages.
- Create a Discord channel webhook and run
  `wrangler secret put DISCORD_WEBHOOK_URL`. Mention parsing is disabled.

Push channels include ticket message text and staff-only links, but no ticket
access keys or image files. Configure destinations suitable for support data.
An unset topic or webhook disables that channel.

Setting it up once:

- `support.blockworked.com` is a custom domain route in `wrangler.toml`; the
  first deploy creates its DNS record.
- In Email Routing, a rule for `support@blockworked.com` with the action "Send
  to a Worker" and this Worker (`blockwork-library`).
- `wrangler secret put SMTP2GO_API_KEY`. Without it, mail is only logged.
- `COOKIE_DOMAIN = "blockworked.com"` makes sign-ins cover the helpdesk; people
  signed in before it sign in once more to use the helpdesk.

Locally, with `.dev.vars` from above, the helpdesk is at
`localhost:8787/support`, and
`curl -X POST "localhost:8787/cdn-cgi/handler/email?from=a@example.com&to=support@blockworked.com" --data-binary @mail.eml`
delivers an email to it.

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

## Other libraries

Anyone can host a library: an `index.json` in this format plus the pack
files, over `https://`. People add its address in Blockwork's settings.
