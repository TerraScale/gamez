# @gamez/game

The phase-0 walking skeleton. One Worker serves the Pixi client (as Workers static assets), the API and the Durable Objects.

## What runs where

| Piece                               | File                         | Job                                                                                                                                                               |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker                              | `src/server/index.ts`        | `POST /api/guest`, `GET /ws` (verifies the token, picks a relay), `GET /api/health`, sync queue consumer                                                          |
| `RelayDO` `relay:<continent>:0`     | `src/server/do/relay.ts`     | Client WebSockets (Hibernation API) and a cached copy of the chunk; each delta is encoded once and broadcast                                                      |
| `ChunkDO` `classic:0:0`             | `src/server/do/chunk.ts`     | Presence authority for the town: validates `moveTo` with A\*, sends coalesced deltas (at most one every 50 ms) once per relay, saves final tiles to the character |
| `CharacterDO` `<accountId>:classic` | `src/server/do/character.ts` | Authoritative character row plus a transactional outbox, drained to the `gamez-sync` queue by an alarm                                                            |
| Queue consumer                      | `src/server/index.ts`        | `applyBatch` into D1 (`character_summary`, `sync_cursor`); ack, or retry on error                                                                                 |
| Client                              | `src/client/`                | Guest login, socket with backoff and resync, clock sync, entity store, self prediction, render loop                                                               |

Code that both sides use (the wire codec and the walk maths) lives in `src/shared/`. It has no Workers APIs, so the client imports it too. To switch the wire format, change the one line in `src/shared/codec.ts`.

### Flow

1. The client calls `POST /api/guest` once and caches `{token, accountId, name}` in localStorage.
2. It opens `GET /ws?token=…`. The Worker verifies the HMAC token. A bad token gets close code `4401`, which tells the client to log in again. A good one goes to `relay:<request.cf.continent>:0`, with a location hint near the player. The verified identity travels in `x-gamez-*` headers.
3. The relay calls `CharacterDO.getOrCreate`, then `ChunkDO.subscribe` if its cache is cold, then `ChunkDO.join`. Finally it sends `welcome` with the full snapshot.
4. When the player taps, the client sends `moveTo` and predicts its own path straight away. The chunk replans from where the avatar is right now: it finishes the current tile step, so the avatar never snaps back. The new path goes out in the next delta. Every client interpolates with `walkAt(…, serverNow)`.
5. When a walk ends, a chunk alarm calls `CharacterDO.savePosition`. That writes the row and a `character_summary` outbox record in one transaction. The outbox alarm (about 2 s) sends a `ReplicationBatch` to the queue, and the consumer upserts it into D1 with a version guard.

### Robustness notes

- Each delta carries a seq. If the relay sees a gap, it rebuilds its cache from the chunk and re-welcomes its sockets. If a client sees a gap, it reconnects.
- A relay that wakes from hibernation re-subscribes and passes the characters it still has sockets for (`liveIds`). The chunk then drops avatars that joined through that relay but are no longer connected, which is what happens after a restart or a deploy.
- If deliveries to a relay fail 3 times in a row, the chunk drops that relay and its avatars. The relay's next `moveTo` gets `not-joined`, so it re-subscribes and rejoins.
- When two tabs share one account, they share one avatar. It leaves the world when the last tab closes.

## Development

```sh
cp .dev.vars.example .dev.vars   # AUTH_SECRET for local dev
vp dev                            # Vite + @cloudflare/vite-plugin: client, Worker and DOs in workerd
vp test                           # unit tests (tests/server, tests/client, tests/shared)
vp build
```

Smoke test:

```sh
curl localhost:5173/api/health
curl -X POST localhost:5173/api/guest
```

### Local state and D1 migrations

`vp dev` runs everything in workerd (Miniflare) and keeps the local state in **`apps/game/.cloudflare/state/v3/`**: D1, DO SQLite, queues and KV. That state survives restarts. Delete the directory to start fresh.

The dev server does **not** apply D1 migrations, so a fresh state has no `character_summary` table. The queue consumer then fails, and after 3 retries the message is dropped. Apply the migrations once per fresh state, while `vp dev` is running (from the repo root):

```sh
vp run migrate-local                         # default http://localhost:5173
vp run migrate-local http://localhost:5288   # another port
```

This applies `migrations/*.sql` in order through the Cloudflare Vite plugin's local explorer API (`/cdn-cgi/local/explorer/api/d1/database/DB-gamez/raw`) and records them in `d1_migrations`, the same table `cf d1 migrations apply` uses. The explorer API only exists in local dev, so it cannot touch a remote database. It is also handy for checking replication by hand:

```sh
curl -s -X POST localhost:5173/cdn-cgi/local/explorer/api/d1/database/DB-gamez/raw \
  -H 'content-type: application/json' -d '{"sql":"SELECT * FROM character_summary"}'
```

**With `cf`.** `cf d1 migrations apply <database-id> --local --persist-to .cloudflare/state` applies `./migrations/*.sql` in order and records them in `d1_migrations`. It uses the same `v3/d1` layout as the dev server. However, `cf` accepts only a database **UUID**, and the dev server keys its local D1 by the binding id. They only point at the same local database once `bindings.d1({ name: "gamez-read", id: "<uuid>" })` sets that id in `cloudflare.config.ts`. Until then, use `vp run migrate-local`. Without `--persist-to`, `cf --local` writes to `~/.config/cloudflare/state`, which `vp dev` never reads.

### Remote

- `cf deploy` provisions missing binding resources by default (`--provision`), including the `gamez-read` D1 database and the `gamez-sync` queue. It does not apply D1 migrations.
- After the first deploy, apply them with `cf d1 migrations apply <database-id>` (find the id with `cf d1 list`). New migration files come from `cf d1 migrations create <message>`. Each migration must run before the code that needs it starts sending sync traffic.
- Set the secret: `AUTH_SECRET` (a long random string). Rotating it logs every guest out, and they come back as new guests.
