# Support and notifications

[Back to README](../README.md)

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

Locally, copy [`.dev.vars.example`](../.dev.vars.example) to `.dev.vars`
and fill it in. The helpdesk is at
`localhost:8787/support`, and
`curl -X POST "localhost:8787/cdn-cgi/handler/email?from=a@example.com&to=support@blockworked.com" --data-binary @mail.eml`
delivers an email to it.
