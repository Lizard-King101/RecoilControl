# Community library

The first version is local and free to share. Open **Community** in the top bar.
The app starts a private loopback service on demand; no separate command, account,
BLE hardware, or internet connection is required. There are no seeded community
profiles, ratings, download totals, or claims of verified tuning.

## Use the library

1. Select the game you want to share in the sidebar. Open Community and choose
   **Publish a pack**. Enter a title, author display name, release, description,
   optional game build, and up to eight tags.
2. Review the snapshot, then choose **Publish locally**. This stores a listing on
   this device; it does not publish to the internet. Re-publishing identical content
   reuses the existing listing. Changed content creates a new immutable listing.
3. Browse/search by game, title, author, or tags; filter by game and sort by recency
   or title. Select a card to inspect its reference settings and preview each
   weapon, attachment variant, and stance pattern.
4. **Add to my games** previews the installation, then adds a separate collection.
   Existing games and bindings stay unchanged. Duplicate game names receive a
   suffix. The new game uses default global controls, unassigned posture keys, and
   no weapon hotkeys. Compensation is disabled during installation.
5. **Export pack** produces a JSON file. Someone else can use **Add pack file** to
   put it in their local library, inspect it, then install it. Removing a local
   listing leaves installed collections and exported files alone. Conversely,
   **Delete game** / **Delete weapon** in Loadout removes only the installed copy;
   the library pack stays available to reinstall, even after deleting every game.

Input settings are the author's reference values, not a certification. Test and
tune the installed collection. Changing sensitivity does not automatically create
an imported calibration record. Save your own local calibration when appropriate.

## Portable game packs

`recoil-control/game-pack-v1` contains:

- Title, author display name, release label, optional game version, description,
  and tags. Author names are unverified in this local prototype.
- Game name, reference DPI/sensitivity/ADS multiplier, and dynamic stance definitions.
- All weapon slots, Base patterns, named attachment setups, per-slot attachment
  labels, selected setups, RPM, repeat modes, activation conditions, and vectors.

Exports bake current strength, sensitivity compensation, stance multipliers, and
legacy-unit conversion into counts vectors. This preserves current effective
movement at the published reference settings. Calibration timestamps, personal
shortcuts, output-device configuration, and HUD settings are excluded. Invalid or
out-of-range effective vectors fail validation rather than being clipped.

Imports validate the full pack, including vectors and attachment/stance references.
They strip submitted hotkeys and local calibration claims. Imported games and
weapons receive fresh IDs. Files are limited to 2 MB; the local library holds up to
200 immutable packs. A pack needs at least one configured pattern; empty weapon
slots may be included for subsequent authoring.

## Local service

The desktop uses `src/community/service.ts` through narrowly scoped main-process
IPC. The renderer cannot make arbitrary network requests. The service binds only
to `127.0.0.1`, requires an ephemeral bearer token, checks Host, and rejects browser
Origin requests. This is a private development boundary, **not public user auth**.
The HUD cannot invoke library operations.

`FilePackRepository` implements the `PackRepository` interface with atomic JSON
writes under `<app userData>/community-library/`. On Linux this is normally
`~/.config/Recoil Control/community-library/`. Filenames are SHA-256 IDs of the
canonical sanitized pack. Reads verify content against the ID. Publication and
removal requests are serialized. Back up this directory to preserve the library.

For development, run a separate service:

```sh
npm run library:serve
```

It defaults to `127.0.0.1:5189` and `.tmp/community-library`. Override
`RECOIL_LIBRARY_PORT`, `RECOIL_LIBRARY_DATA`, and `RECOIL_LIBRARY_TOKEN` as needed.
If no token is supplied, it prints a generated development token at startup. The
standalone service has separate storage from the app unless explicitly configured
to use another path; run only one writer per directory. The app currently uses
its own private instance, not this development endpoint.

All routes require `Authorization: Bearer <token>`:

| Method | Route | Result |
| --- | --- | --- |
| GET | `/v1/packs` | Summary catalog, newest first |
| GET | `/v1/packs/:sha256` | Immutable pack and publication timestamp |
| POST | `/v1/packs` | Validate/publish a game pack; exact duplicates are idempotent |
| DELETE | `/v1/packs/:sha256` | Remove the local listing |

POST uses `Content-Type: application/json`. No arbitrary URLs, files, shell
commands, or executable plugins are accepted. This service is for local use;
do not expose its shared-token write/delete model as a public community API.

## Hosting plan

Recommended first deployment: **Linode for the API, Cloudflare for DNS/TLS proxying**.
This keeps the Node runtime, validation logic, and HTTP API close to the local
implementation. Linode documents [Node.js hosting](https://www.akamai.com/cloud/guides/how-to-install-nodejs/)
and an [NGINX reverse proxy](https://www.akamai.com/cloud/guides/use-nginx-reverse-proxy/).
Run a dedicated service under a process supervisor, with a persistent volume and
backups. Keep the application port private behind the proxy. Use a separate
hosted request/auth adapter; the local Host/Origin/token rules are intentionally
not a production deployment configuration.

| Layer | Linode first | Cloudflare alternative |
| --- | --- | --- |
| API | Node service behind a TLS reverse proxy | Workers request handler |
| Searchable catalog / ownership | PostgreSQL; SQLite can serve a small single-instance pilot | D1 |
| Immutable pack bodies | Persistent storage initially; R2 also works | R2 objects keyed by content hash |
| Identity | External identity provider, verified sessions, ownership checks | Same identity contract, verified in Worker |
| Desktop | HTTPS catalog client plus account session | Same client and pack format |

Cloudflare provides [D1 for SQL storage](https://developers.cloudflare.com/d1/)
and [R2 for objects](https://developers.cloudflare.com/r2/). Its Node filesystem
is an [in-memory virtual filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/),
so the current file repository is not durable there. A Workers deployment needs
`PackRepository` backed by D1/R2, a Fetch API request adapter, and extraction of
pure package/settings validators from desktop filesystem imports. It is a
reasonable second adapter, not a change to the exported game-pack format.

Before a public pilot:

1. Add verified accounts and publisher IDs. Derive author identity from the session,
   not the editable display-name field. Restrict release changes/removal to owners
   and moderators; provide report/unpublish tools.
2. Separate pack identity from immutable releases. Suggested tables: publishers,
   packs (owner/game/name), releases (pack/version/content hash/blob key/visibility),
   tags, and reports. Keep current content hashes so exported packs remain verifiable.
   Enforce a unique release version within each pack.
3. Replace local catalog limits with server-side pagination/search, request quotas,
   payload limits, and transactional writes. Do not fabricate popularity metrics;
   only introduce them with an explicit definition and actual data.
4. Add a hosted-library client configuration and sign-in to the desktop. Keep tokens
   in OS-backed secret storage. Retain local packs and file sharing offline. Do not
   automatically migrate or upload existing local content.
5. Test owner permissions, interrupted uploads, restore from backups, and old-client
   compatibility in staging. Add a release migration policy before auto-update
   discovery; never overwrite a locally edited game collection automatically.

Nothing in this change deploys infrastructure, configures an account, opens a
public port, or uploads an existing user profile.

## Verification

`node --test tests/community.test.cjs` covers sanitization, effective counts,
custom stances and attachments, non-destructive installation, invalid inputs,
HTTP authorization, deduplication, persistence, deletion, and content validation.
`npm run test:community-desktop` exercises actual Electron navigation, publishing
review, escaped metadata, search, pattern preview, file sharing, import isolation,
persistence, removal, and compact layouts with isolated test data and no hardware.
