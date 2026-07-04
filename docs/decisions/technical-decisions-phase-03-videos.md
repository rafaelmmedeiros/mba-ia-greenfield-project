---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-04
scope_description: "Backend foundation for video upload and processing: message queue, 10GB direct-to-storage upload, object storage access, a separate FFmpeg worker, metadata/thumbnail extraction, unique public URLs, range streaming/download, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module plus the new infrastructure: object storage integration, the processing queue, and the FFmpeg worker (upload orchestration, automatic processing, streaming/download, and the status lifecycle).
- `next-frontend/` — Frontend deferred: the video UI (player, upload screen, channel video management) is explicitly **out of scope** for Phase 03, which is a backend-only phase. No open decision in this document.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (metadata extraction + thumbnail generation) is CPU-heavy and must run in the background so it never blocks the API or the uploader. A queue decouples the API (job producer) from the worker (consumer). The project plan leaves the queue technology explicitly **"TBD"** — this is the phase's primary stack decision. Constraint: it must run as a real service in Docker Compose and be exercised by integration tests.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue. NestJS integration via `@nestjs/bullmq`: `BullModule.registerQueue`, `@Processor` + `WorkerHost`, `@OnWorkerEvent`. Built-in retries (`attempts` + exponential `backoff`), automatic `failed` state, concurrency, delayed jobs, and events.
- **Pros:** De-facto NestJS standard with a first-class module; retries/backoff/failed-state map directly onto the video status lifecycle (TD-08); a separate worker process consumes the same queue; trivial to integration-test against a real Redis in Compose; rich tooling (bull-board).
- **Cons:** Adds a Redis service (new infra) and two deps (`bullmq`, `@nestjs/bullmq`). Redis is another moving part to operate.

### Option B: pg-boss (PostgreSQL-backed queue)
- Queue implemented on the existing PostgreSQL via `SKIP LOCKED`. No new infrastructure service.
- **Pros:** Zero new infra — reuses the Postgres already in the stack; transactional enqueue alongside DB writes; fewer moving parts.
- **Cons:** Lower throughput ceiling than Redis; couples queue load to the primary DB; no native NestJS module (manual integration); fewer ergonomics (events, dashboards) than BullMQ.

### Option C: RabbitMQ (`@nestjs/microservices` / amqplib)
- Dedicated AMQP broker with a NestJS microservices transport.
- **Pros:** Mature broker; powerful routing/exchange semantics; good for complex fan-out topologies.
- **Cons:** Heaviest new infra; routing power is overkill for a single processing queue; retry/backoff/DLQ must be assembled manually; more operational complexity than the phase needs.

**Recommendation:** **Option A (BullMQ + Redis)** — the retry/backoff/failed-state model maps directly onto the `draft → processing → ready/failed` lifecycle (TD-08), it has the strongest NestJS integration, and a real Redis is trivial to add to Compose and exercise in integration tests. pg-boss is the compelling "no new infra" alternative if avoiding Redis is a priority.

**Decision:** A (BullMQ + Redis)

**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: Large-File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB file must not pass through the API — buffering or streaming it through the process would exhaust memory/time and block the event loop, and the challenge fails any design that routes the file through the API. The client uploads **directly to object storage**; the API orchestrates (pre-registers the draft, hands out upload credentials, finalizes, enqueues processing). This is a client↔storage contract that the API defines. Depends on TD-03 (storage access).

**Options:**

### Option A: S3 multipart upload via presigned URLs
- API `CreateMultipartUpload` → returns an `uploadId` + presigned `UploadPart` URLs; the client PUTs parts directly to storage; the client calls a "complete" endpoint → API `CompleteMultipartUpload` and enqueues processing. Single presigned PUT caps at 5GB (S3 limit), so 10GB **mandates** multipart (up to 10,000 parts, ≥5MB each).
- **Pros:** File never touches the API; native to S3/MinIO; parallel part uploads; resumable at part granularity; standard, well-documented (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).
- **Cons:** Multi-step handshake (init → parts → complete) the client must implement; the API tracks upload lifecycle; ETag/part bookkeeping.

### Option B: tus resumable upload protocol
- Open resumable-upload protocol; `@tus/server` with an S3 store terminates uploads and forwards to storage.
- **Pros:** Best-in-class resumability (survives connection drops — the project-plan's stated concern); one protocol handles chunking + resume; mature clients.
- **Cons:** Adds a tus server component and protocol surface; bytes flow through the tus endpoint (not pure presigned direct-to-storage), so it must be streamed/sized carefully; more infra than presigned multipart.

### Option C: Single presigned PUT URL
- API returns one presigned PUT; the client uploads the whole file in one request directly to storage.
- **Pros:** Simplest handshake (one URL); file bypasses the API.
- **Cons:** **S3 caps a single PUT at 5GB — cannot satisfy the 10GB requirement**; no resumability (a dropped connection restarts the whole upload). Disqualified by the 10GB limit.

**Recommendation:** **Option A (S3 multipart presigned)** — it keeps the 10GB file entirely off the API, is native to the chosen S3/MinIO storage, and gives part-level resumability. tus (Option B) is the stronger choice if first-class resumability is prioritized over infra simplicity.

**Decision:** A (S3 multipart via presigned URLs)

---

## TD-03: Object Storage Access — SDK & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage engine is **fixed** (S3-compatible; MinIO locally, S3 in production). Open here is *how* the API and worker talk to it: which client SDK, how buckets/keys are organized, and how presigned URLs are issued. Constrains TD-02 (upload) and TD-07 (streaming/download).

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official modular S3 client; points at MinIO via `endpoint` + `forcePathStyle: true`; presigns via `getSignedUrl`. The same code runs against real S3 in production by swapping the endpoint/credentials.
- **Pros:** Vendor-portable (MinIO ↔ S3 with no code change — matches "trocaria por S3 em produção"); modular/tree-shakeable; canonical multipart + presign APIs; broad documentation.
- **Cons:** More verbose command-based API; several packages; presigning multipart parts is some ceremony.

### Option B: MinIO JS SDK (`minio`)
- MinIO's own client; simpler `presignedPutObject` / `presignedGetObject`; also works against S3.
- **Pros:** Simpler presign ergonomics; MinIO-first; fewer packages.
- **Cons:** Less idiomatic for real S3 in production; weaker multipart-presign story; ties the mental model to MinIO's client rather than the S3 standard.

**Recommendation:** **Option A (AWS SDK v3)** — the project explicitly targets "S3-compatible, swap MinIO → S3 in production," and the AWS SDK is the portable, standard choice; MinIO is exercised locally purely via the `endpoint` override. Bucket/key layout (e.g., a single bucket with `videos/{videoId}/source.<ext>` and `videos/{videoId}/thumbnail.jpg`) is specified in the plan's Data/Events specs.

**Decision:** A (AWS SDK v3)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-04: Video Worker Runtime & Packaging

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Processing (FFmpeg/ffprobe) is CPU-heavy and must run in a **separate process/container** from the API so it never blocks request handling. The worker consumes queue jobs, reads/writes storage, and updates the DB — so it needs the same config/repository/queue wiring the API has. Decision: how to package and boot it. Depends on TD-01 (queue).

**Options:**

### Option A: Standalone Nest application context, separate container
- A second entrypoint (`src/worker/main.ts`) boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server), registering the BullMQ processor and reusing `ConfigModule` / `TypeOrmModule` / storage / queue providers. Shipped as its own Compose service with a Dockerfile that adds `ffmpeg`.
- **Pros:** Full reuse of DI, typed config, entities/repositories and the queue module; no monorepo restructuring; one codebase / one `package.json`; runs as a genuinely separate container/process.
- **Cons:** A second bootstrap file + a worker Dockerfile; must scope a `WorkerModule` to only what the worker needs.

### Option B: NestJS monorepo (`apps/api` + `apps/worker`)
- Convert `nest-cli.json` to projects mode with two apps and a shared `libs/`.
- **Pros:** First-class multi-app structure; explicit shared libraries; clear boundaries.
- **Cons:** Restructures the whole build (nest-cli, tsconfig, paths) — a sizable change to a single-app project mid-course; more ceremony than a two-entrypoint split needs.

### Option C: Plain Node BullMQ worker (no Nest)
- A standalone script instantiating a `bullmq` `Worker` directly, without the Nest container.
- **Pros:** Lightest footprint; no Nest bootstrap in the worker.
- **Cons:** Loses DI/config/TypeORM reuse — must re-wire DB access, config parsing and the storage client by hand; diverges from project conventions (services, repositories, typed config).

**Recommendation:** **Option A (standalone application context)** — reuses the existing Nest DI/config/repository/queue layer without the cost of converting to monorepo mode, and runs as a genuinely separate container/process.

**Decision:** A (Standalone Nest application context)

---

## TD-05: Video Processing Tooling (metadata + thumbnail)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata (ffprobe) and generate a thumbnail from a frame (ffmpeg). FFmpeg is a system binary (installed in the worker image via `apt install ffmpeg`); the decision is how Node invokes it. Depends on TD-04 (worker).

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- High-level Node API over ffmpeg/ffprobe: `.ffprobe()` returns parsed metadata; `.screenshots()` extracts a thumbnail frame.
- **Pros:** Ergonomic — metadata parsing and thumbnail extraction in a few typed calls; handles argument construction and stream plumbing; widely used.
- **Cons:** Maintenance has been slow/uncertain — the maintained version/fork must be confirmed via Context7 at `plan-resolve`; an extra dependency wrapping a CLI you still have to install.

### Option B: Direct `child_process` (spawn ffmpeg / ffprobe)
- Invoke `ffprobe -show_format -show_streams -print_format json` and `ffmpeg -ss <t> -frames:v 1 ...` directly; parse ffprobe JSON.
- **Pros:** Zero extra dependency; full control over exact flags; robust and future-proof (no wrapper-maintenance risk); transparent about what runs.
- **Cons:** More boilerplate (spawn, buffer stdout/stderr, parse JSON, error handling); you build the small abstractions fluent-ffmpeg provides.

**Recommendation:** **Option B (direct `child_process`)** — for a small, well-defined task (ffprobe JSON + one thumbnail frame) it avoids a maintenance-uncertain dependency and gives full control, at the cost of a little boilerplate. `fluent-ffmpeg` (Option A) is reasonable if ergonomics are prioritized — pin a maintained version at `plan-resolve`.

**Decision:** B (Direct `child_process`)

---

## TD-06: Unique Public Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, URL-safe **public** identifier (the project-plan calls for "uma URL curta e única que nunca conflite"), distinct from the internal UUID primary key. It appears in the watch/stream/download URLs.

**Options:**

### Option A: `nanoid` short id (dedicated unique, indexed column)
- Generate a short URL-safe id (default 21 chars over `A-Za-z0-9_-`; `customAlphabet`/size to shorten). Store in a unique, indexed `public_id` column.
- **Pros:** Purpose-built, tiny, cryptographically strong, URL-safe by default; tunable length vs collision (21 chars ≈ UUIDv4); well-understood collision math.
- **Cons:** **CJS/ESM gotcha:** nanoid v4+ is ESM-only — in this CommonJS Nest build, pin **v3** (`^3.3.x`, the last CommonJS release) or load v5 via a dynamic `import()`. A retry-on-unique-violation guard is still needed (as `ChannelsService` already does for nicknames).

### Option B: Node `crypto`, zero-dependency (`randomBytes` → base64url)
- `crypto.randomBytes(n).toString('base64url')` (or a custom base62 over `randomBytes`) for a short URL-safe id. No dependency.
- **Pros:** Zero new dependency; CJS-native (no ESM friction); short and URL-safe; full control over length/alphabet; consistent with the project's "prefer built-ins" leaning (cf. TD-10 nickname generation).
- **Cons:** Must hand-roll the encoding/length; collision math is on you (choose enough bytes, e.g., 9–12).

### Option C: UUID v4 as the public id
- Expose the entity's `uuid` (or a second `uuid`) as the public URL id.
- **Pros:** Trivial — already generated by the DB; guaranteed unique; no new dependency.
- **Cons:** 36 chars — not "curta"; exposes a UUID; misses the "short URL" intent of the plan.

**Recommendation:** **Option A (nanoid)** — the standard, purpose-built short-id generator that matches the "short unique URL" intent; the only caveat is pinning the CommonJS-compatible v3 (resolved at `plan-resolve`). Option B (zero-dep `crypto`) is an equally valid, dependency-free alternative that sidesteps the ESM issue. Either way, keep the existing unique-violation retry pattern.

**Decision:** A (nanoid — pin CommonJS v3)

**Libraries:** nanoid

---

## TD-07: Streaming & Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTTP `Range` / `206 Partial Content`), and the user must be able to download the file. The C4 diagram shows the client streaming directly from storage. Decision: does the API serve the bytes, or hand out a storage URL? Depends on TD-03 (storage access).

**Options:**

### Option A: Presigned GET, streamed directly from storage
- API returns (or `302`-redirects to) a short-lived presigned GET URL; the client streams from MinIO/S3, which natively honors `Range` / `206`. Download uses the same URL with `response-content-disposition=attachment`.
- **Pros:** Bytes never pass through the API (matches the diagram's frontend→storage "Streams"); storage handles range/206 for free; scales without API CPU/bandwidth; download and stream share one mechanism.
- **Cons:** Presigned URLs expose a temporary direct link (short TTL mitigates); access control is enforced at URL-issue time, not per byte; harder to inject per-request logic (e.g., view counting) into the stream itself.

### Option B: API range-proxy endpoint (`206` through the API)
- API endpoint reads `Range`, issues a ranged `GetObject` to storage, and streams back `206 Partial Content`.
- **Pros:** Storage stays fully private (no public URLs); the API can enforce per-request authorization and hook analytics (views); self-contained and trivial to exercise in e2e tests.
- **Cons:** Playback/download bytes flow through the API (CPU/bandwidth cost — acceptable for range chunks, not for the 10GB upload path); must implement range parsing and `206` correctly.

**Recommendation:** **Option A (presigned GET)** as the primary path — it keeps the byte stream off the API and matches the target architecture — with an optional Option B range-proxy endpoint where a self-contained, easily-tested API surface or fully-private storage is preferred.

**Decision:** A (Presigned GET, direct from storage)

---

## TD-08: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video moves from pre-registration through processing to a terminal state, and the model must record what happens when processing fails. This drives the entity's `status` column and the worker/queue error handling. Depends on TD-01 (queue).

**Options:**

### Option A: Enum `draft → processing → ready / failed`, with BullMQ retries + failure reason
- Postgres enum `video_status` (`draft`, `processing`, `ready`, `failed`). `draft` on upload-init; `processing` when the job starts; `ready` on success; `failed` after BullMQ exhausts `attempts` (exponential backoff), storing a `failure_reason`.
- **Pros:** Explicit, queryable states map 1:1 to the challenge's "rascunho → processando → pronto/erro"; BullMQ's `attempts`/`backoff`/failed-event give retries and a clean terminal-failure hook; `failure_reason` aids debugging; matches the existing enum-column convention (`verification_tokens_type_enum`).
- **Cons:** Enum migrations are slightly rigid (adding a state later needs a migration); worker state transitions and DB writes must be kept consistent.

### Option B: Boolean flags (`is_processed`, `is_failed`)
- Two booleans instead of an enum.
- **Pros:** No enum type; simplest columns.
- **Cons:** Representable illegal combinations (processed AND failed); no single source of truth for state; awkward to extend; poorer query semantics than an enum.

### Option C: Explicit state-machine library
- Model transitions with a state-machine library that enforces legal moves.
- **Pros:** Enforced legal transitions; self-documenting state graph.
- **Cons:** Extra dependency and abstraction for a 4-state, near-linear flow; overkill relative to an enum + a few guarded transitions.

**Recommendation:** **Option A (enum + BullMQ retries)** — it mirrors the challenge's stated status cycle exactly, reuses BullMQ's retry/failed model from TD-01, and follows the project's existing Postgres-enum convention.

**Decision:** A (Enum `draft → processing → ready/failed` + BullMQ retries)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Backend | Large-File Upload Strategy (10GB) | S3 multipart via presigned URLs | A (S3 multipart presigned) |
| TD-03 | Backend | Object Storage Access — SDK & keys | AWS SDK v3 (`@aws-sdk/client-s3` + presigner) | A (AWS SDK v3) |
| TD-04 | Backend | Video Worker Runtime & Packaging | Standalone Nest application context | A (Standalone Nest application context) |
| TD-05 | Backend | Video Processing Tooling | Direct `child_process` (ffprobe/ffmpeg) | B (Direct `child_process`) |
| TD-06 | Backend | Unique Public Video URL Identifier | `nanoid` (pin CJS v3) | A (nanoid — pin CJS v3) |
| TD-07 | Backend | Streaming & Download Delivery | Presigned GET (direct from storage) | A (Presigned GET) |
| TD-08 | Backend | Video Status Lifecycle & Failure | Enum `draft→processing→ready/failed` + BullMQ retries | A (Enum + BullMQ retries) |
