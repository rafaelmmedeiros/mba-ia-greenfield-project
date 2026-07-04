---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-04T12:32:06-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-04T15:17:52-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-04T12:32:06-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-04T12:32:06-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-04T12:32:06-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo, categorias, visibilidade público/unlisted, fluxo rascunho→publicação e painel de gerenciamento (Fase 04); página de visualização com player e contagem de views (Fase 05); interações sociais — likes, comentários, inscrições (Fase 06). All frontend UI (player, tela de upload, painel de vídeos do canal) is deferred — this is a backend-only phase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — the video UI (player, upload screen, channel video management) starts in Fases 04–05; no video interface is built in this phase.

**Sequencing notes:** Depends on Fase 01 (base infra/config) and Fase 02 (auth, users, channels). A video belongs to a **channel** (the `channels` table owns `user_id`); ownership of a video resolves through the authenticated user's channel. Introduces three new infrastructure components (object storage, queue, worker) that the target architecture (`docs/diagrams/software-arch.mermaid`) already anticipates.

**Neighbors (for boundary detection only):**

- **Phase 02 — Cadastro, Login e Gerenciamento de Conta:** provides the `channels` entity a video belongs to and the JWT identity of the uploader; upstream dependency.
- **Phase 04 — Gerenciamento de Vídeos e Canal:** edits video info, visibility and the draft→publish flow; consumes the video entity and status produced here; downstream dependency.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | — |
| phase-03-videos/TD-02 | phase | Backend | Large-File Upload Strategy (10GB) | decided | A (S3 multipart presigned) | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Access — SDK & keys | decided | A (AWS SDK v3) | — |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Runtime & Packaging | decided | A (Standalone Nest application context) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Processing Tooling | decided | B (Direct `child_process`) | — |
| phase-03-videos/TD-06 | phase | Backend | Unique Public Video URL Identifier | decided | A (nanoid — CJS v3) | — |
| phase-03-videos/TD-07 | phase | Backend | Streaming & Download Delivery | decided | A (Presigned GET) | — |
| phase-03-videos/TD-08 | phase | Backend | Video Status Lifecycle & Failure | decided | A (Enum + BullMQ retries) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

_Libraries are pinned downstream by `plan-resolve` (→ `library-refs.md`); "—" here means not yet fixed._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the retry/backoff/failed-state model maps directly onto the `draft → processing → ready/failed` lifecycle (TD-08), it has the strongest NestJS integration, and a real Redis is trivial to add to Compose and exercise in integration tests. pg-boss is the compelling "no new infra" alternative if avoiding Redis is a priority.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** it keeps the 10GB file entirely off the API, is native to the chosen S3/MinIO storage, and gives part-level resumability. A single presigned PUT caps at 5GB (S3 limit), so 10GB mandates multipart. tus is the stronger choice if first-class resumability is prioritized over infra simplicity.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** the project explicitly targets "S3-compatible, swap MinIO → S3 in production," and the AWS SDK is the portable, standard choice; MinIO is exercised locally purely via the `endpoint` override (`forcePathStyle: true`). Bucket/key layout (e.g., a single bucket with `videos/{videoId}/source.<ext>` and `videos/{videoId}/thumbnail.jpg`) is specified in the plan's Data/Events specs.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** a second entrypoint booting `NestFactory.createApplicationContext(WorkerModule)` reuses the existing Nest DI/config/repository/queue layer without the cost of converting to monorepo mode, and runs as a genuinely separate container/process (its own Dockerfile with `ffmpeg`).
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** for a small, well-defined task (ffprobe JSON + one thumbnail frame) direct `child_process` avoids a maintenance-uncertain dependency and gives full control, at the cost of a little boilerplate. `fluent-ffmpeg` is reasonable if ergonomics are prioritized. FFmpeg is a system binary installed in the worker image via `apt install ffmpeg`.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** nanoid is the standard, purpose-built short-id generator that matches the "short unique URL" intent; the only caveat is pinning the CommonJS-compatible v3 (nanoid v4+ is ESM-only). A zero-dependency `crypto` `randomBytes` → base64url approach is an equally valid alternative that sidesteps the ESM issue. Either way, keep the existing unique-violation retry pattern (cf. `ChannelsService`).
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** presigned GET keeps the byte stream off the API and matches the target architecture (client streams from storage, which honors `Range`/`206` natively); download reuses the same URL with `response-content-disposition=attachment`. An optional API range-proxy endpoint is available where a self-contained, easily-tested API surface or fully-private storage is preferred.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** a Postgres enum `video_status` (`draft`, `processing`, `ready`, `failed`) mirrors the challenge's stated status cycle exactly, reuses BullMQ's retry/backoff/failed model from TD-01 (mark `failed` with a `failure_reason` after attempts are exhausted), and follows the project's existing Postgres-enum convention (`verification_tokens_type_enum`).
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Native NestJS integration is decisive: the guard system allows scoping rate limiting via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate. (Decision diverged to JWT to reuse the `@nestjs/jwt` signing infrastructure.)
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs()` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env vars validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 01)_
- Inject config via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`; same factory usable plainly outside DI (TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'`, then imports config factories and calls them as plain functions. _(from phase 01)_
- `TypeOrmModule.forRootAsync` (not `forRoot`) injects `databaseConfig.KEY`, with `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Docker networking: services address each other by Compose service name (`db`, `mailpit`), never `localhost`. _(from phase 01)_
- Each domain feature is its own module registered in `AppModule`; the entity is registered via `TypeOrmModule.forFeature([Entity])` in the owning module. `auth/` is the reference for a full controller-bearing module. _(from phase 02)_
- Services throw `DomainException` subclasses (never NestJS `HttpException`); two global filters map them to `{ statusCode, error, message }` (shared `ApiErrorEnvelope`). Controllers stay thin. _(from phase 02)_
- Entities: `@Entity('plural_snake')`, `@PrimaryGeneratedColumn('uuid')`, snake_case columns, `@CreateDateColumn/@UpdateDateColumn`; both sides of relations declared, owning side holds the `*_id` uuid column + `@JoinColumn`. _(from phase 02)_
- Global JWT guard (`APP_GUARD` in `AuthModule`) protects every route by default; `@Public()` opts out; read the user via `@CurrentUser(): JwtPayload` (`sub` = userId). _(from phase 02)_
- Migrations are TypeORM-CLI-generated (immutable once run); request DTOs use class-validator + JSDoc (swagger CLI plugin infers `@ApiProperty`). _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|------------|--------|--------------|-----------|
| Telas de frontend | deferred | phase 01 | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase 02 | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

Layer selection follows the `testing-guide-nestjs-project` Skill; per-SI coverage is tracked in `progress.md`.

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false`, relations |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter (MinIO) |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Queue consumer / processor (business logic) | Unit (mock deps) + Integration (real DB/storage) |
| Queue consumer / processor (only external-system calls) | Integration (real systems) |

_Test suffix contract: `*.spec.ts` unit (no DB), `*.integration-spec.ts` integration (real DB/Redis/MinIO, `--runInBand`), `*.e2e-spec.ts` e2e (full HTTP via supertest). Do not mock infra the Compose stack can run for real._
