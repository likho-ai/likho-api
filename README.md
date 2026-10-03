# likho-api

The API of [Likho](https://github.com/likho-ai): who is signed in, which recordings exist,
what is being transcribed, and the lines as they arrive. Browsers use **GraphQL**; scripts and
connectors use **REST** with an API key. Everything else (audio, transcripts, vocabulary) lives
in the other services; this one calls them over gRPC and listens to their events.

NestJS 12, Apollo Server 5, PostgreSQL (Drizzle), Redis, NATS JetStream, Connect clients to
likho-media, likho-transcription and likho-language.

## What it does

```
browser ── GraphQL /graphql ──┐
script  ── REST    /api/v1 ───┤── likho-api ──┬── likho-media         (upload links, playback links, delete)
browser ── SSE     /events ───┘               ├── likho-transcription (transcripts, cancel, engines)
                                              ├── likho-language      (glossary, spellings)
                   events on NATS ────────────┤   likho.media.ready / failed
                                              │   likho.live.segment
                                              │   likho.transcription.completed / failed
                   publishes ─────────────────┘   likho.transcription.requested
```

A recording's life, as the API sees it:

| Status | Meaning | Set by |
| --- | --- | --- |
| `uploading` | `requestUpload` handed out a link; the file has not arrived | the API |
| `uploaded` | the file arrived; likho-media is looking at it | (not used yet: media reports ready directly) |
| `ready` | it is audio; it can be transcribed | `likho.media.ready` |
| `failed` | it is not audio that can be read | `likho.media.failed` |
| `queued` | a job waits for a worker | `createJob`, or `ready` with auto-transcribe on |
| `transcribing` | a worker is on it | the first `likho.live.segment` |
| `done` | a transcript exists | `likho.transcription.completed` |

What you can rely on:

- **Sign-in is a cookie**, `likho_session`, HttpOnly and SameSite=Lax. Sessions are rows: logging
  out or revoking takes effect at once. Passwords are hashed with scrypt.
- **API keys** (`Authorization: Bearer lk_...`) are made by an admin on the settings page, shown
  once, stored hashed, and revocable.
- **Workspaces keep people apart.** Every query is scoped to the caller's workspace; a recording
  of another workspace is simply not found.
- **Events are applied once.** Their ids are remembered, so a redelivery changes nothing twice.
- **Live lines reach every browser**, on any instance, through Redis. A page that opens late gets
  the lines so far first.
- **Auto-transcribe** (a workspace setting, on by default) queues a job the moment a recording is
  ready.

## Run it

Needs PostgreSQL, Redis and NATS from the [likho-infra](https://github.com/likho-ai/likho-infra)
stack (`bash scripts/up.sh`), and the three services it calls (they may be started later; calls
fail with `service_unavailable` until then).

```bash
pnpm install
pnpm start:dev        # reads .env.development: the local stack, and a first admin (see below)
```

The first start creates the admin and workspace named in `BOOTSTRAP_ADMIN_*` (in
`.env.development`: `admin@example.com` / `admin-password-1`, for your machine only). More users:

```bash
pnpm build
pnpm users:add --email a@example.com --name "A. Person" --password "..." [--admin]
```

Then, through the gateway at http://localhost:8080:

| Path | What |
| --- | --- |
| `POST /graphql` | The GraphQL API; `schema.graphql` in this repository is the schema |
| `GET /api/docs`, `GET /api/openapi.json` | The REST API, described; `openapi.json` and the Postman collection in `postman/` are the same |
| `GET /events/jobs/:id`, `GET /events/recordings` | Live updates as server-sent events |
| `GET /healthz`, `GET /readyz` | Alive; database, Redis and bus answer |

With Docker, on the stack's network:

```bash
docker build -t likho-api .
docker run --rm --network likho -p 4000:4000 \
  -e DATABASE_URL=postgres://likho_api:likho_api@postgres:5432/likho_api \
  -e REDIS_URL=redis://redis:6379 -e NATS_URL=nats://nats:4222 \
  -e MEDIA_GRPC_ADDR=likho-media:5010 -e TRANSCRIPTION_GRPC_ADDR=likho-transcription:5020 \
  -e LANGUAGE_GRPC_ADDR=likho-language:5030 \
  -e BOOTSTRAP_ADMIN_EMAIL=you@example.com -e BOOTSTRAP_ADMIN_PASSWORD=choose-one \
  likho-api
```

## A session, in GraphQL

```graphql
mutation { login(email: "you@example.com", password: "...") { name workspace { name } } }

mutation { requestUpload(input: { originalName: "call.mp3", sizeBytes: 104976 }) {
  uploadUrl                      # PUT the file here (a likho-media link through the gateway)
  recording { id status }
} }

query { recordings(first: 20) { items { id originalName status durationSeconds detectedLanguage } hasMore endCursor } }

query { recording(id: "rec_...") {
  status playbackUrl peaksUrl
  jobs { id status progressSeconds totalSeconds }
  latestTranscript { segments { startSeconds endSeconds textScript textRoman } }
} }
```

While a job runs, `GET /events/jobs/<job id>` streams `segment` events (`textScript`,
`textRoman`, `startSeconds`, `endSeconds`) and ends with a `job` event whose `status` is `done`.

## A script, in REST

```bash
curl -H "Authorization: Bearer lk_..." -H "Content-Type: application/json" \
  -d '{"originalName":"call.mp3","sizeBytes":104976,"externalId":"your-id"}' \
  http://localhost:8080/api/v1/recordings
# → { "recording": {...}, "uploadUrl": "http://localhost:8080/media/uploads/med_...?token=..." }
curl -X PUT --data-binary @call.mp3 "<uploadUrl>"
curl -H "Authorization: Bearer lk_..." http://localhost:8080/api/v1/recordings/rec_.../transcript
```

Errors always look like `{"error": {"code": "not_found", "message": "The recording was not found."}}`
with the codes `unauthenticated`, `forbidden`, `not_found`, `invalid`, `conflict`,
`service_unavailable`; GraphQL carries the same code in `extensions.code`.

## Configuration

Settings come from environment variables and from `.env` files chosen by `LIKHO_ENV`
(`development` by default). The files are read in this order, each overriding the one before,
and a real environment variable wins over all of them:

```
.env   .env.local   .env.<LIKHO_ENV>   .env.<LIKHO_ENV>.local
```

`.env.development`, `.env.staging` and `.env.production` are committed and hold no secrets.
`.env.<env>.local` holds the secrets of that environment on your machine; git ignores it, and
`likho-infra/scripts/make-env-secrets.py` makes it. In Kubernetes the same values come from
ConfigMaps and Secrets.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HTTP_PORT` | `4000` | |
| `DATABASE_URL` | local stack, database `likho_api` | PostgreSQL; tables are created on start |
| `REDIS_URL` | `redis://localhost:6380` | Live updates between instances |
| `NATS_URL` | `nats://localhost:4222` | Event bus |
| `MEDIA_GRPC_ADDR`, `TRANSCRIPTION_GRPC_ADDR`, `LANGUAGE_GRPC_ADDR` | `localhost:5010/5020/5030` | The other services |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | The address browsers use; https makes cookies Secure |
| `SESSION_SECRET` | a development value | Keys sessions and API keys; required in production |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_WORKSPACE_NAME` | unset | The first admin and workspace, made when there are no users |
| `CONSUMERS_ENABLED` | `true` | Take events from the bus |
| `CONSUMER_GROUP` | `likho-api` | Instances with the same name share the events |

## Develop

```bash
pnpm lint && pnpm typecheck
pnpm test          # against the local stack; the other services are faked
pnpm export        # rewrites schema.graphql, openapi.json and the Postman collection
pnpm db:generate   # a new SQL migration after a change to src/db/schema.ts
```

The tests run the real application against PostgreSQL (each run in its own schema), NATS and
Redis, with likho-media, likho-transcription and likho-language replaced by small gRPC servers
in the test process. Without the stack they are skipped; with `LIKHO_REQUIRE_STACK=1` (set in CI)
they fail instead.
