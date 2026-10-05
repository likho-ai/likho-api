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
                                              ├── likho-search        (lines matching a few words)
                   events on NATS ────────────┤   likho.media.ready / failed
                                              │   likho.live.segment
                                              │   likho.transcription.completed / failed
                                              │   likho.import.completed / failed   (a connector answers)
                   publishes ─────────────────┘   likho.transcription.requested
                                                  likho.import.requested             (fetch this call from the dialer)
                                                  likho.recording.deleted
```

Beyond uploads: **search** (`search(query, filter)` / `GET /api/v1/search?q=` - every transcript
line, either layer, typos allowed, matches marked, each hit with its recording; narrowed by
language, campaign, agent, disposition, source or when the call happened; `saveSearch` keeps
the words and the filter for everyone in the workspace), **the library by the facts of a call**
(`recordings(filter: { campaign, agent, disposition, source, since, until })` on the call time,
`recordingFacets(key)` for the values a fact takes with their counts; every recording's facts go
out as `likho.recording.updated` for likho-search), **imports**
(`requestImport(externalId)` / `POST /api/v1/imports` - a call asked for by its id in the
dialer; the connector fetches it and the recording appears, with `source` and `attributes`
such as campaign, agent, disposition and call time, which a connector sets when it uploads),
and the **vocabulary** (`glossary`, `spellings`, with how often each was heard and the last lines
a spelling was applied to; `importGlossaryCsv` / `importSpellingsCsv` and `glossaryCsv` /
`spellingsCsv`, or `GET` / `POST /api/v1/vocabulary/glossary.csv` and `spellings.csv` with the
file as the body).

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
  out, revoking or disabling a person takes effect at once. Passwords are hashed with scrypt.
- **Three roles.** An `admin` manages people, keys and settings; a `member` works with
  recordings (upload, transcribe, correct, vocabulary); a `viewer` reads, plays and searches.
  A viewer's mutation is refused with `forbidden`. API keys act as members.
- **People join by invitation**: an admin invites an email address with a role; the one-time
  link (seven days) is mailed when `SMTP_URL` is set and is shown to the admin either way. The
  person chooses a name and a password through the link. Password resets work the same way, by
  mail only. Tokens are stored hashed.
- **Every change is in the audit log** (`auditLog`, admins): who (person or API key), what
  (`recording.deleted`, `user.invited`, `transcript.corrected`, ...), to what, from which address,
  with the details that matter and never a secret.
- **API keys** (`Authorization: Bearer lk_...`) are made by an admin on the settings page, shown
  once, stored hashed, and revocable.
- **Workspaces keep people apart.** Every query is scoped to the caller's workspace; a recording
  of another workspace is simply not found.
- **Events are applied once.** Their ids are remembered, so a redelivery changes nothing twice.
- **Live lines reach every browser**, on any instance, through Redis. A page that opens late gets
  the lines so far first.
- **Auto-transcribe** (a workspace setting, on by default) queues a job the moment a recording is
  ready.
- **No job waits forever.** A job still queued after `JOB_QUEUED_MAX_MINUTES` is asked for again
  once, then failed as `no_worker`; a running job with no line for `JOB_STALL_MAX_MINUTES` is
  stopped, failed as `stalled`, and tried once more as a fresh job (`attempt` 2). A worker says at
  once that it took a job (`likho.transcription.started`), so a job is running while the model
  loads; a worker that starts a job already given up on (the stalled job's request, delivered once
  more when the worker comes back) is told to drop it. A transcript that arrives for a job given up
  on is kept all the same: the job is done after all. The service also keeps trying to reach NATS
  at start instead of exiting.
- **Metrics** at `GET /metrics` (Prometheus text, OpenTelemetry): jobs by status, the age of the
  oldest waiting job, jobs finished by outcome, the realtime factor of transcription, events
  handled, sweeps. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to push them to Grafana as well.

## Run it

Needs PostgreSQL, Redis and NATS from the [likho-infra](https://github.com/likho-ai/likho-infra)
stack (`bash scripts/up.sh`), and the three services it calls (they may be started later; calls
fail with `service_unavailable` until then).

```bash
pnpm install
pnpm start:dev        # reads .env.development: the local stack, and a first admin (see below)
```

The first start creates the admin and workspace named in `BOOTSTRAP_ADMIN_*` (in
`.env.development`: `admin@example.com` / `admin-password-1`, for your machine only). Everyone
else is invited by an admin from the admin app (or with the `inviteUser` mutation). From a shell,
without a browser:

```bash
pnpm build
pnpm users:add --email a@example.com --name "A. Person" --password "..." [--role admin|member|viewer]
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
| `MEDIA_GRPC_ADDR`, `TRANSCRIPTION_GRPC_ADDR`, `LANGUAGE_GRPC_ADDR`, `SEARCH_GRPC_ADDR` | `localhost:5010/5020/5030/5040` | The other services |
| `IMPORT_SOURCE` | `ameyo` | The connector that answers `requestImport` by default; empty = imports are off |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | The address browsers use; https makes cookies Secure |
| `SESSION_SECRET` | a development value | Keys sessions and API keys; required in production |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `SMTP_URL` | empty | Where invitation and reset mails go out: `smtp://user:pass@host:587` or `smtps://...:465`. Empty = no mail; admins pass invitation links on by hand, and password resets need an admin |
| `MAIL_FROM` | `Likho <likho@localhost>` | The sender of those mails |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_WORKSPACE_NAME` | unset | The first admin and workspace, made when there are no users |
| `CONSUMERS_ENABLED` | `true` | Take events from the bus (and sweep jobs) |
| `CONSUMER_GROUP` | `likho-api` | Instances with the same name share the events |
| `NATS_CONNECT_TIMEOUT_SECONDS` | `120` | How long to keep trying to reach NATS at start |
| `JOB_SWEEP_SECONDS` | `60` | How often stuck and stalled jobs are looked for; 0 = never |
| `JOB_QUEUED_MAX_MINUTES` | `15` | A job still queued after this is asked for again, then failed (`no_worker`) |
| `JOB_STALL_MAX_MINUTES` | `10` | A running job with no line for this long is stopped, failed (`stalled`) and tried once more |
| `JOB_MAX_ATTEMPTS` | `2` | Tries a job gets in all |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | Also push the metrics there (OTLP/HTTP, e.g. `http://localhost:4318`); `/metrics` is always on |
| `TZ` | the machine's | A connector's `callTime` attribute that carries no zone (a dialer's `2026-10-02 10:55:02`) is read in this zone; set the company's zone in `.env.<env>.local` or the deployment |

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
