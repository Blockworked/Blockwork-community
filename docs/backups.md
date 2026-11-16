# Blockwork service backups

Encrypted off-site backups are installed on `treetrain1@treetrain1-cachyos`.
The destination is the private Cloudflare R2 bucket `blockwork-server-backups`
in account `02bbf53523ab2217dade43c8aad5e4b7`. These are full snapshots,
encrypted with GnuPG AES256 before upload. A separate provider would also
protect against losing access to the Cloudflare account.

## Schedule and operation

- Nightly at 03:30 America/Chicago, with up to ten minutes of random delay.
- Sundays at 05:00 America/Chicago: download, decrypt, check file checksums
  and archives, import D1 into SQLite, and restore Mailcow and Weblate databases
  into disposable containers with networking disabled.
- Retain the newest successful snapshot for 14 days, 8 weeks, and 12 months.
  Multiple runs in one day can replace that day's retained snapshot.
- Timers are persistent. The user manager has lingering enabled; missed runs
  are attempted when the PC's user manager starts again.

Source scripts/units are in [ops/backups](../ops/backups). Installed scripts
are under `~/.local/lib/blockwork-backup/`, user units under
`~/.config/systemd/user/`, and private configuration/passphrase under
`~/.config/blockwork-backup/`. Credentials are not stored in this repository.

```sh
systemctl --user list-timers 'blockwork-backup*'
systemctl --user start blockwork-backup.service
systemctl --user start blockwork-backup-verify.service
journalctl --user -u blockwork-backup.service -u blockwork-backup-verify.service
cat ~/.local/share/blockwork-backup/last-success.json
```

The bucket's `last-success.json` points to the latest complete manifest.
Failed jobs appear in systemd's status/journal. **Independent missing-backup
alerts are not configured.** An external monitor should alert after 26 hours
without a remote success heartbeat, through a channel independent of this PC
and Blockwork mail.

## Coverage

| Service | Captured data |
| --- | --- |
| Mailcow | Logical dump of all MariaDB databases; mailbox/index, encryption-key, Redis, Rspamd and Postfix volumes; Mailcow directory excluding Git history. Includes the custom `.cloudflare/inbound` bridge and token. |
| Mail routing | `mail-injector.service`, deployed `mailcow-inbound` Worker source/settings, DNS records, Email Routing rules/catch-all, and local Cloudflare Tunnel configuration. |
| Weblate | PostgreSQL custom-format dump, `weblate-data`, Compose configuration/secrets, and container metadata recording runtime configuration and image versions. |
| Community/support | Complete D1 `blockwork-library` export (`d99e2800-5159-4d2f-949a-a92508b6f2ec`), all R2 `blockwork-library` objects with keys/metadata, and deployed Worker source/settings. Keep the source repository and migrations as well. |
| Blockwork notifications | ntfy state volume, server/Compose configuration, and existing notification credentials. |
| Backup system | Configuration/script, file checksums, object inventory and an outer manifest containing encrypted chunk sizes/hashes. Future snapshots also include the restore-test helper. |

Nextcloud, Immich, Odysseus and personal files are outside this Blockwork
backup's scope. The shared tunnel configuration is included as a dependency.
The Minecraft dataset server documented in another repository was not found
among the running services during inventory.

Mailcow writers and the Weblate application pause briefly during their paired
database/file captures. `finally` handlers and systemd's post-stop handler
resume services on failure/timeout. Database servers remain running for logical
dumps. ntfy pauses while its SQLite files are copied. Initial captures paused
Mailcow for about three seconds and Weblate for about two seconds; larger
datasets can take longer.

D1/R2 have no shared atomic snapshot. The job captures objects before exporting
D1, then captures additions and verifies that all exported packs and ticket
attachments are present. It verifies pack hashes and fails if an observed
object changes during capture. Missing referenced objects fail the snapshot.
This validates references rather than claiming a provider-wide atomic snapshot.

Each encrypted chunk is uploaded, downloaded and hash-checked before the complete
manifest/heartbeat are published. Plaintext staging is private and removed on
normal completion or handled exceptions. Retention removes only complete
snapshots created by this tool. Interrupted uploads are not marked successful;
their abandoned chunks can require manual cleanup.

## Initial verification

The first scheduled-service run and the verification job both completed
successfully. The latest tested snapshot contained 295 checksum-verified files.
D1 imported with 24 tables and matching row counts; isolated database restores
recovered Mailcow's 3 mailboxes/1 domain and Weblate's 7 users/62 translations.
Public R2 access was confirmed disabled, with no custom domains on the bucket.
The initial verification record is stored as `last-verification.json` locally
and in the backup bucket. Temporary plaintext restore files were removed.
This initial record is not an automatically updated verification heartbeat;
subsequent verification results are in the systemd journal.

## Recovery

**Save the recovery passphrase outside this PC**, in a password manager accessible
without Blockwork mail. A downloadable copy was supplied in the setup chat.
Retain Cloudflare account recovery and independent access to a replacement scoped
API token too. An encrypted archive cannot recover its own passphrase.

Cloudflare does not return existing Worker secret values through the ordinary
API. Secret names and locally stored originals are captured, but this does not
establish a recovery copy of every Worker secret. Preserve the original
`AUTH_TOTP_KEY` separately: D1's existing authenticator seeds cannot be decrypted
without it. Also retain OAuth credentials and the SMTP2GO key, or plan to reissue
them if lost.

On a replacement Linux host with Python 3.12+, GnuPG and Docker, copy the scripts
and configure the account, bucket, API-token file and passphrase file, updating
paths for that host. Read the bucket's `last-success.json` using an authenticated
Cloudflare client to obtain the manifest key:

```sh
python3 backup.py --restore snapshots/TIMESTAMP/manifest.json --destination /private/restore
python3 restore-smoketest.py /private/restore/snapshot
```

The restore command downloads ordered chunks, checks hashes, decrypts the archive
and verifies recovered file hashes. It leaves plaintext in the chosen private
directory; remove it after recovery. Original database images from
`containers.json` must be available to run the isolated database test.

Recreate services with the backed-up Compose configuration and compatible
images. Restore Mailcow's logical database dump and volumes using a procedure
appropriate to that version; these are not native `backup_and_restore.sh`
archives. Reload MariaDB privileges after importing its grant tables. Restore
Weblate's database and data volume together. Recreate/import D1 from
`community.sql`; use `objects.json` to map hashed local R2 filenames to original
keys, content types and metadata. Restore Worker source, variables, secrets,
routes, DNS, Email Routing, tunnel/injector configuration and ntfy as required.

Keep outbound mail, public traffic, notifications and translation pushes disabled
until recovery is verified. Automated tests cover archive recovery, database
imports and data counts; full end-to-end application recovery is a separate
exercise.
