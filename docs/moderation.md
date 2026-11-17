# Spam prevention and moderation

Everything people can post goes through `screen()` in `src/moderation.ts`:
pack uploads (site and app), comments (site and app), tickets, language
requests and translation saves. Moderation pages are under `/admin/moderation`
(admins only).

## What stops a flood

- **Per-account and per-network limits.** Each action has a limit per account
  for new accounts and one per network for everyone, so one network can't
  spread a flood over many accounts. Networks are stored only as keyed hashes
  (`IP_HASH_KEY`), dropped after 90 days.
- **New accounts** (under 3 days old with nothing approved) get tighter
  limits, see Turnstile on comments, and a comment of theirs with a link waits
  for review.
- **Flood brake.** Past 25 comments an hour from new accounts, every new
  account's comment waits for review and admins are told once an hour.
- **Turnstile** (Cloudflare's CAPTCHA) on email sign-up, password reset, new
  tickets, web uploads and new accounts' comments. Off until both
  `TURNSTILE_SITE_KEY` (a var) and `TURNSTILE_SECRET` (a secret) are set.
- **Reports.** Signed-in people can report a comment or pack. Three reports
  hold a comment.
- **Emergency switches** on `/admin/moderation`: pause posting for new
  accounts or everyone but admins, and close sign-ups (email and OAuth).
- **Blocklist**: networks (added by rollbacks), email addresses and domains
  (refused at sign-up and dropped from support@).
- **Duplicate comments** within a day are refused.

## Cleaning up

- **Ban** signs an account out everywhere and hides its packs and comments.
- **Shadowban** lets an account keep posting while only it sees its comments;
  its uploads sit apart in the review queue and its tickets go to Spam.
- **Roll back** (`/admin/users/<id>`, or several accounts from the moderation
  page): over the last hour, day, week or all time, removes the account's
  comments, rejects its uploads (a listed pack falls back to its previous
  version), takes down packs it started, marks its tickets spam, declines its
  language requests, then bans or shadowbans it and optionally blocks its
  networks. "Roll back this account and all on its networks" does the same to
  every account that posted from those networks.
- **Undo.** Every action is in `/admin/moderation/log` with what it changed,
  and Undo puts it back (sessions a ban ended stay ended).
- **Bulk**: select comments on the moderation page or uploads in the review
  queue and remove, reject or roll back their writers at once.

## Support mail

support@ arrives through Cloudflare Email Routing (`src/support-inbound.ts`).
Its Authentication-Results decide what happens: a DMARC failure is filed in
Spam, mail where neither SPF nor DKIM passed gets no receipt (so a spoofed
sender gets no backscatter), blocked addresses and domains are dropped, and
past 40 new email tickets an hour the rest go to Spam unannounced. Staff can
mark a ticket Spam and block its sender; replies to a spam ticket stay there.

## Translations

Translation saves, suggestions, votes and comments go to Weblate as the
contributor, so `screen()` limits them and a ban or shadowban stops them. To
undo what a contributor already did there, run `ops/weblate/rollback_user.py`
in the Weblate container with the `bw_...` name the account page shows (dry run
first, then `--apply`). It blocks the contributor, puts their strings back and
deletes their suggestions and comments.

## Setup

```sh
wrangler secret put IP_HASH_KEY        # 32+ random bytes
wrangler secret put TURNSTILE_SECRET   # from the Turnstile widget
# and TURNSTILE_SITE_KEY under [vars] in wrangler.toml
```

Add community.blockworked.com, support.blockworked.com and
translate.blockworked.com as the Turnstile widget's hostnames.
