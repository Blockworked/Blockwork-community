# Blockwork community blocks

The library shown in Blockwork under **My Blocks → Browse library**, served
by a Cloudflare Worker. Sign in with GitHub or Google to submit packs;
every upload is reviewed before it is listed. The approved version stays
available while updates are reviewed.

- [Browse and submit packs](https://community.blockworked.com)
- [Get support](https://support.blockworked.com) or email support@blockworked.com

The Worker serves the pack index and files, account and review pages, the app
API, and support tickets with private image attachments. Staff notifications
can use email, ntfy, and Discord.

## Share a pack

1. In Blockwork, right-click a block in **My Blocks** and choose
   **Share blocks as a pack…**. Blocks it calls come along.
2. Sign in on the library site and upload the file. Keep the same pack ID
   when publishing later versions.

## Run locally

Requires Node.js and npm. Copy `.dev.vars.example` to `.dev.vars` and fill
in the local sign-in settings.

```bash
npm install
npm run migrate:local && npm run seed:local
npm run dev        # http://localhost:8787
npm test
npm run typecheck
```

## Documentation

- [Pack authoring and official packs](docs/packs.md): identifiers, input
  defaults, pack behavior, generation, and runtime tests.
- [Development and deployment](docs/development.md): routes, rendering, the
  app API, Cloudflare setup, and automatic deployments from `master`.
- [Support and notifications](docs/support.md): email routing, attachment
  limits and privacy, and email, ntfy, and Discord configuration.

## Other libraries

Anyone can host an `index.json` in this format and its pack files over HTTPS.
People add the library's address in Blockwork's settings. The starter packs
in `packs/` and the repository's `index.json` remain available to older releases.
