---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-04T15:52:31-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-04T15:51:48-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-04T15:48:33-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend for video upload and processing: 10GB direct-to-storage multipart upload with automatic draft pre-registration, asynchronous FFmpeg processing (duration/metadata extraction + thumbnail generation) via a BullMQ/Redis queue and a standalone worker, unique public URLs, and presigned range-based streaming/download from S3-compatible object storage (MinIO) — with new object storage, queue, and worker services running in Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: object storage, fila e worker no Compose + config/env

**Description:** Sobe a infraestrutura nova (MinIO, Redis e o container do worker) no Docker Compose e propaga a configuração de storage/fila pelas camadas de config do projeto.

**Technical actions:**

1. Adicionar os serviços `minio` (portas 9000/9001, healthcheck) e `redis` (`redis:7-alpine`, healthcheck `redis-cli ping`) ao `compose.yaml`, com volumes nomeados (`minio-data`; e `pgdata` para o Postgres) e `depends_on` no `nestjs-api` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
2. Criar `Dockerfile.worker` (node + `apt install -y ffmpeg`) e o serviço `video-worker` no `compose.yaml`, com `depends_on` em db/redis/minio saudáveis (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
3. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` (`registerAs`) e registrá-los no `ConfigModule.forRoot({ load: [...] })` do `AppModule` (convenção herdada de config)
4. Estender `src/config/env.validation.ts` (Joi) e `.env.example` com `S3_ENDPOINT=minio`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST=redis`, `REDIS_PORT` — hosts pelo nome do serviço do Compose (convenção herdada de Docker/env)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `minio`, `redis` e `video-worker`, todos saudáveis.
- A API só inicia com as variáveis `S3_*` e `REDIS_*` presentes — o schema Joi rejeita o boot se faltar alguma.
- Nenhum host aponta para `localhost`: storage, fila e worker se conectam pelos nomes de serviço do Compose.

---

### SI-03.2 — Entidade Video + migration CreateVideos

**Description:** Cria a entidade `Video` (com o enum `video_status`), a relação inversa no `Channel`, a migration da tabela `videos` e atualiza os testes de migration/limpeza.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')`, uuid PK, colunas snake_case por `### Data Model`, enum `video_status`, FK `channel_id` (`@ManyToOne` + `@JoinColumn`) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`)
2. Adicionar `@OneToMany(() => Video, v => v.channel) videos` em `Channel` (regra dos dois lados da relação) (convenção herdada de entidades)
3. Gerar e rodar a migration via CLI: `migration:generate` → `CreateVideos`; conferir o SQL bruto (enum + tabela + índices) (convenção herdada de migrations)
4. Atualizar `src/database/migrations.integration-spec.ts` (adicionar `Video` + `CreateVideos` + `'videos'` a `MANAGED_TABLES` e dropar o novo enum no `beforeAll`) e `cleanAllTables` em `src/test/create-test-data-source.ts` (`DELETE FROM "videos"` antes de `channels`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: colunas, enum, `public_id` único, FK → `channels`, defaults | `src/videos/entities/video.entity.integration-spec.ts` |
| migrations | Integration: tabela `videos` criada e revertida | `src/database/migrations.integration-spec.ts` (atualizado) |

**Dependencies:** none

**Acceptance criteria:**

- A migration `CreateVideos` cria a tabela `videos` com o enum `video_status` e `public_id` único; `migration:revert` remove tudo (tabela + tipo enum) sem resíduo.
- Inserir um vídeo com `public_id` duplicado é rejeitado pela constraint `unique`.
- Um vídeo exige `channel_id` válido referenciando `channels(id)` (violação de FK caso contrário).
- A suíte de migrations (com a nova entrada `videos`) passa inteira.

---

### SI-03.3 — StorageModule (S3/MinIO: multipart + presigned)

**Description:** Serviço de object storage sobre o AWS SDK v3 apontando para o MinIO — bootstrap de bucket, multipart (init/complete/abort) e geração de URLs presigned.

**Technical actions:**

1. `docker compose exec nestjs-api npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-03`; ver `library-refs.md`)
2. Criar `src/storage/storage.service.ts` — `S3Client` (`endpoint` do `storage.config`, `forcePathStyle: true`), métodos `ensureBucket`, `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `presignGet` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-07`)
3. Criar `src/storage/storage.module.ts` (provider + `exports: [StorageService]`) e registrar no `AppModule` (convenção herdada de módulos)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real — ensure bucket, round-trip de multipart, presigned GET baixável | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (config de storage + serviço MinIO)

**Acceptance criteria:**

- `StorageService` conecta ao MinIO pelo nome do serviço do Compose e garante a existência do bucket configurado.
- É possível iniciar um multipart, subir uma parte via URL presigned e completar, resultando num objeto recuperável.
- `presignGet` devolve uma URL que serve o objeto com suporte a `Range` (206).

---

### SI-03.4 — QueueModule (BullMQ + Redis)

**Description:** Registra a fila BullMQ `videos` e sua conexão Redis para o produtor (API).

**Technical actions:**

1. `docker compose exec nestjs-api npm install bullmq @nestjs/bullmq` (per `phase-03-videos/TD-01`; ver `library-refs.md`)
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` (connection do `queue.config`) + `registerQueue({ name: 'videos' })`; `exports` e registrar no `AppModule` (per `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Integration: Redis real — enfileira um job e o lê de volta | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.1 (config de fila + serviço Redis)

**Acceptance criteria:**

- A API conecta ao Redis pelo nome do serviço do Compose e registra a fila `videos`.
- Um job adicionado à fila `videos` é persistido no Redis e recuperável.

---

### SI-03.5 — Upload init: pré-cadastro do rascunho + multipart presigned

**Description:** `VideosModule` + `POST /videos/uploads` — cria o vídeo como rascunho (`public_id` nanoid), inicia o multipart e devolve as URLs presigned das partes.

**Technical actions:**

1. `docker compose exec nestjs-api npm install nanoid@^3` (CJS — v4+ é ESM-only) (per `phase-03-videos/TD-06`; ver `library-refs.md`)
2. Criar `src/videos/dto/initiate-upload.dto.ts` (`title`, `filename`, `contentType`, `fileSize`) com class-validator per `### API Contracts → Validation Rules` (convenção herdada de validação)
3. Criar `src/videos/videos.service.ts` (`initiateUpload`): resolver o canal do `@CurrentUser`, gerar `public_id` com nanoid (retry em violação de unique, como `ChannelsService`), montar `storage_key`, `StorageService.createMultipartUpload` + `presignUploadPart` por parte, persistir rascunho (`status='draft'`, `multipart_upload_id`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`, `phase-03-videos/TD-08`)
4. Criar `src/videos/videos.controller.ts` + `videos.module.ts` (`forFeature([Video])`, registrar no `AppModule`) — `POST /videos/uploads` (`@ApiBearerAuth`); adicionar `InvalidFileSizeException` (`INVALID_FILE_SIZE`) em `src/common/exceptions/domain.exception.ts` (per `### API Contracts`, `### Error Catalog`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: geração de `public_id`, guarda de `fileSize` (repo + storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: rascunho persistido + multipart iniciado (DB + MinIO reais) | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/uploads` | E2E: 201 com `parts` / 400 `INVALID_FILE_SIZE` / 401 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2 (entidade), SI-03.3 (storage)

**Acceptance criteria:**

- `POST /videos/uploads` com corpo válido retorna `201` com `videoId`, `publicId`, `uploadId`, `key` e `parts` presigned.
- O vídeo é persistido como `draft` com `public_id` único e `multipart_upload_id` preenchido.
- `POST /videos/uploads` com `fileSize` > 10 GiB retorna `400 INVALID_FILE_SIZE`.
- `POST /videos/uploads` sem token válido retorna `401`.

---

### SI-03.6 — Upload complete + abort: enfileira o processamento

**Description:** `POST /videos/:publicId/uploads/complete` (fecha o multipart, `draft → processing`, enfileira `process-video`) e `DELETE /videos/:publicId/uploads` (aborta).

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`uploadId`, `parts: { partNumber, etag }[]`) com class-validator per `### API Contracts → Validation Rules`
2. `VideosService.completeUpload`: verificar dono + estado, `StorageService.completeMultipartUpload`, `status='processing'`, enfileirar `process-video` `{ videoId }` na fila `videos` (`attempts: 3`, `backoff` exponencial) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-08`)
3. `VideosService.abortUpload`: verificar dono + estado, `StorageService.abortMultipartUpload`, remover o rascunho
4. Adicionar as rotas no controller e as exceções `VideoNotFoundException` (404), `NotVideoOwnerException` (403), `InvalidUploadStateException` (409) em `domain.exception.ts` (per `### Error Catalog`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: guardas de dono/estado + chamada de enqueue (queue + storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService` (complete/abort) | Integration: `status → processing` + job enfileirado (DB + Redis + MinIO reais) | `src/videos/videos.service.integration-spec.ts` |
| `POST .../complete`, `DELETE .../uploads` | E2E: 200 `processing` / 403 / 404 / 409 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.4 (fila), SI-03.5 (upload init + módulo)

**Acceptance criteria:**

- `POST /videos/:publicId/uploads/complete` pelo dono retorna `200` com `status: "processing"` e enfileira um job `process-video`.
- Completar o vídeo de outro usuário retorna `403 NOT_VIDEO_OWNER`; um `publicId` inexistente retorna `404 VIDEO_NOT_FOUND`.
- Completar um vídeo que não está aguardando conclusão retorna `409 INVALID_UPLOAD_STATE`.
- `DELETE /videos/:publicId/uploads` pelo dono aborta o multipart e remove o rascunho.

---

### SI-03.7 — Video worker: standalone context + processor (ffprobe + thumbnail)

**Description:** Worker Nest standalone (`src/worker`) com um `VideoProcessor` BullMQ que roda ffprobe + ffmpeg (thumbnail) e atualiza o vídeo; tratamento de falha.

**Technical actions:**

1. Criar `src/worker/main.ts` (`NestFactory.createApplicationContext(WorkerModule)`) + `src/worker/worker.module.ts` (Config, TypeORM, `forFeature([Video])`, `StorageModule`, `BullModule.registerQueue({ name: 'videos' })`) (per `phase-03-videos/TD-04`)
2. Criar `src/videos/video.processor.ts` (`@Processor('videos')` extends `WorkerHost`) — `process(job)`: carregar vídeo, `status='processing'`, baixar a origem do storage, `ffprobe` (via `child_process`) para duração/metadados, `ffmpeg` extrai 1 frame como thumbnail, subir a thumbnail, atualizar a linha → `ready` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
3. `@OnWorkerEvent('failed')`: após esgotar `attempts`, `status='failed'` + `failure_reason` (per `phase-03-videos/TD-08`)
4. Adicionar o script npm `start:worker` (`node dist/worker/main`) e apontar o `command` do serviço `video-worker` no `compose.yaml` para ele

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: parsing do ffprobe + transições de status (storage/ffmpeg mockados) | `src/videos/video.processor.spec.ts` |
| `VideoProcessor` | Integration: MinIO + DB reais — processa um clipe pequeno → duração + thumbnail + `ready` | `src/videos/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.3 (storage), SI-03.4 (fila), SI-03.6 (produtor do job)

**Acceptance criteria:**

- Processar um upload concluído extrai `duration_seconds` + `metadata`, gera um `thumbnail_key` e leva o status a `ready`.
- Uma falha de processamento (ex.: origem ilegível) leva o status a `failed` com `failure_reason` após esgotar as tentativas.
- O worker roda como container/processo separado consumindo a fila `videos`.

---

### SI-03.8 — Watch / streaming / download (presigned GET)

**Description:** `GET /videos/:publicId` (metadados/status, público se `ready`) e `GET .../stream` + `.../download` (URLs presigned de GET).

**Technical actions:**

1. `VideosService.getByPublicId`: carregar o vídeo, aplicar o gate `ready`-ou-dono, montar a resposta com `thumbnailUrl` presigned (per `phase-03-videos/TD-07`, `### Error Catalog`)
2. `VideosService.getStreamUrl` / `getDownloadUrl`: exigir `ready`, `StorageService.presignGet` (download com `ResponseContentDisposition: attachment` a partir de `original_filename`) (per `phase-03-videos/TD-07`)
3. Adicionar as rotas no controller: `GET /videos/:publicId`, `/stream`, `/download`, todas `@Public()`; adicionar `VideoNotReadyException` (409) (per `### Authorization Matrix`, `### Error Catalog`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (get/stream/download) | Unit: gate `ready` + chamadas de presign (storage mockado) | `src/videos/videos.service.spec.ts` |
| `GET video/stream/download` | E2E: 200 com `url` / 404 / 409 `VIDEO_NOT_READY`; anônimo lê `ready` | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 (módulo/entidade), SI-03.3 (storage)

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` retorna `200` com metadados, status e `thumbnailUrl` presigned, acessível anonimamente.
- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `200` com URL presigned que serve a origem com `Range`/206.
- `GET /videos/:publicId/download` retorna URL presigned com disposição `attachment` usando o nome de arquivo original.
- Stream/download de vídeo não-`ready` retorna `409 VIDEO_NOT_READY`; um não-dono lendo um vídeo não-`ready` recebe `404 VIDEO_NOT_FOUND`.

---

### SI-03.9 — E2E do pipeline completo + coerência do Error Catalog

**Description:** Um teste e2e que exercita upload → processamento → `ready` → streaming contra a stack completa do Compose (worker real), e a verificação de que as exceções de vídeo mapeiam no Error Catalog.

**Technical actions:**

1. Escrever `test/videos-pipeline.e2e-spec.ts`: fluxo completo com um clipe pequeno — init → `PUT` das partes nas URLs presigned → complete → poll de `GET /videos/:publicId` até `ready` (processado pelo container `video-worker` em execução) → assert de `duration`/`thumbnailUrl` → `GET .../stream` e assert de `Range`/206 a partir do MinIO (per todas as TDs)
2. Verificar que cada `DomainException` de vídeo mapeia para o `errorCode` do `### Error Catalog` via o filtro global (checagem de consolidação)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline completo | E2E: upload → process → `ready` → stream contra a stack do Compose (worker real) | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.7 (worker), SI-03.8 (streaming)

**Acceptance criteria:**

- Um ciclo completo upload → complete → processamento leva o vídeo a `ready` com thumbnail e duração, conduzido pelo container do worker em execução.
- A URL de stream resultante serve os bytes enviados com `Range`/206 a partir do storage.
- Todo caminho de erro de vídeo retorna o `errorCode` documentado no envelope `{ statusCode, error, message }`.

---

### SI-03.10 — Documentação de IA (CLAUDE.md) + Definition of Done

**Description:** Atualiza os dois `CLAUDE.md` para refletir o módulo de vídeos, o worker, a fila e o storage entregues, e roda a Definition of Done completa.

**Technical actions:**

1. Atualizar o `CLAUDE.md` raiz: resolver "Message Queue (TBD)" → BullMQ/Redis; manter os bullets de Video Worker / Object Storage coerentes com o código entregue
2. Atualizar `nestjs-project/CLAUDE.md`: adicionar o módulo de vídeos + endpoints + fila/worker + storage em Architecture, Development Environment (serviços + portas) e Environment Startup Verification (probes de prontidão para `minio`/`redis`)
3. Rodar a DoD completa dentro do container: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint`

**Tests:** _(empty — documentação + verificação)_

**Dependencies:** SI-03.9 (feature completa)

**Acceptance criteria:**

- Ambos os `CLAUDE.md` descrevem apenas endpoints, módulos, nomes de fila e buckets de storage que existem de fato no código entregue.
- A Definition of Done passa inteira: suíte unit+integration, suíte e2e, `npx tsc --noEmit` (código 0) e `npm run lint`.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`) |
| public_id | varchar(21) | unique, not null — nanoid public URL id (per phase-03-videos/TD-06) |
| channel_id | uuid | not null, FK → `channels(id)` |
| title | varchar(255) | not null |
| description | text | nullable (edited in Fase 04) |
| status | enum `video_status` | not null, default `draft` — one of `draft`, `processing`, `ready`, `failed` (per phase-03-videos/TD-08) |
| original_filename | varchar(255) | nullable — client filename, used for download `Content-Disposition` |
| content_type | varchar(127) | nullable — source MIME type |
| storage_key | varchar(512) | not null — object key of the source file in storage (per phase-03-videos/TD-03) |
| thumbnail_key | varchar(512) | nullable — object key of the generated thumbnail |
| multipart_upload_id | varchar(255) | nullable — S3 multipart `UploadId`, tracked between init and complete (per phase-03-videos/TD-02) |
| duration_seconds | integer | nullable — extracted by the worker via ffprobe |
| size_bytes | bigint | nullable — source file size |
| metadata | jsonb | nullable — raw ffprobe streams/format (width, height, codec, bitrate) |
| failure_reason | text | nullable — populated when `status = failed` |
| created_at | timestamptz | default `now()` |
| updated_at | timestamptz | default `now()` |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to one `Channel` (many-to-one — owning side holds `channel_id` + `@JoinColumn`, per the inherited entity convention). Ownership resolves through `channels.user_id` (the authenticated user's 1:1 channel).
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status`.

`video_status` is a PostgreSQL enum type, following the inherited enum convention (`verification_tokens_type_enum`).

### API Contracts

Error response shape is inherited from phase-02-auth/TD-07: `{ statusCode, error, message }` (see `## Inherited Conventions`). Mutating endpoints are protected by the global `JwtAuthGuard`; public reads use `@Public()`. The uploader's channel is derived from `@CurrentUser()` (user → their 1:1 channel) — no `channelId` in the path. Bytes never pass through the API on either the upload or the playback path (per phase-03-videos/TD-02 and TD-07).

#### POST /videos/uploads (SI-03.5)

Initiate a large-file upload: pre-register the video as a draft and start an S3 multipart upload, returning presigned part URLs (the file uploads directly to storage — per phase-03-videos/TD-02).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- title: string, required — 1..255 chars
- filename: string, required — original file name (used later for download)
- contentType: string, required — source MIME type (e.g., `video/mp4`)
- fileSize: number, required — total bytes; 1..10737418240 (10 GiB)

**Response 201:**
- videoId: string (uuid) — internal id
- publicId: string — nanoid public URL id
- uploadId: string — S3 multipart `UploadId`
- key: string — storage object key for the source
- partSize: number — bytes per part
- parts: array of `{ partNumber: number, url: string }` — presigned PUT URLs (client uploads each part directly to storage)

**Error responses:**
- 400 INVALID_FILE_SIZE: when `fileSize` <= 0 or > 10 GiB
- 400 validation error: when the request body fails schema validation
- 401 (missing/invalid token): when unauthenticated

---

#### POST /videos/:publicId/uploads/complete (SI-03.6)

Finalize the multipart upload and enqueue processing. Transitions the video `draft` → `processing`.

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- uploadId: string, required — the `UploadId` returned by init
- parts: array of `{ partNumber: number, etag: string }`, required — the ETags returned by storage for each uploaded part

**Response 200:**
- publicId: string
- status: string — `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 403 NOT_VIDEO_OWNER: when the video's channel is not the caller's channel
- 409 INVALID_UPLOAD_STATE: when the video is not awaiting completion, or `uploadId`/parts mismatch
- 400 validation error: when the request body fails schema validation
- 401 (missing/invalid token): when unauthenticated

---

#### DELETE /videos/:publicId/uploads (SI-03.6)

Abort an in-progress upload: abort the S3 multipart upload and delete the draft.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 403 NOT_VIDEO_OWNER: when the caller is not the owner
- 409 INVALID_UPLOAD_STATE: when the video is not in an abortable state
- 401 (missing/invalid token): when unauthenticated

---

#### GET /videos/:publicId (SI-03.8)

Fetch a video's metadata and status. Public for `ready` videos; the owner may read their own video in any status (to poll processing/failed).

**Request headers:**
- Authorization: Bearer {access_token} — optional; required only to read a non-`ready` video the caller owns

**Response 200:**
- publicId: string
- title: string
- description: string | null
- status: string — `draft` | `processing` | `ready` | `failed`
- durationSeconds: number | null
- thumbnailUrl: string | null — presigned GET URL for the thumbnail (when `ready`)
- channel: `{ nickname: string, name: string }`
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`, or it is not `ready` and the caller is not its owner
- 401 (invalid token): when a token is supplied but invalid

---

#### GET /videos/:publicId/stream (SI-03.8)

Return a short-lived presigned GET URL to stream the source directly from storage (storage serves HTTP `Range` / `206` natively — per phase-03-videos/TD-07). Public for `ready` videos.

**Response 200:**
- url: string — presigned GET URL (client streams from storage with `Range` requests)
- expiresIn: number — seconds until the URL expires

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_NOT_READY: when the video status is not `ready`

---

#### GET /videos/:publicId/download (SI-03.8)

Return a presigned GET URL with `response-content-disposition=attachment` so the browser downloads the file (filename from `original_filename`). Public for `ready` videos.

**Response 200:**
- url: string — presigned GET URL with attachment disposition
- expiresIn: number

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId`
- 409 VIDEO_NOT_READY: when the video status is not `ready`

---

#### Validation Rules — Video Upload

- `title`: required, string, 1..255 chars
- `filename`: required, string, 1..255 chars
- `contentType`: required, string (a `video/*` MIME type)
- `fileSize`: required, integer, 1..10737418240 (10 GiB)
- `uploadId`: required, string
- `parts`: required, non-empty array of `{ partNumber: integer ≥ 1, etag: string }`

Stream and download return a URL rather than proxying bytes, keeping the API out of the byte path (both upload and playback). The optional API range-proxy endpoint (phase-03-videos/TD-07 Option B) is out of scope for this phase.

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos/uploads | ✗ | ✓ | ✓ |
| POST /videos/:publicId/uploads/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId/uploads | ✗ | ✗ | ✓ |
| GET /videos/:publicId (ready) | ✓ | ✓ | ✓ |
| GET /videos/:publicId (not ready) | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream (ready) | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download (ready) | ✓ | ✓ | ✓ |

**Owner** = the authenticated user whose 1:1 channel owns the video (`videos.channel_id == channels.id` where `channels.user_id == user.sub`). The global `JwtAuthGuard` protects by default; public reads are marked `@Public()` and the service enforces the `ready` gate (a non-`ready` video is `VIDEO_NOT_FOUND` to anyone but its owner). `POST /videos/uploads` requires only that the caller has a channel; the other mutations additionally require ownership of the target video.

### Error Catalog

Error response shape (inherited from phase-02-auth/TD-07): `{ statusCode: number, error: string, message: string }`, emitted by the global `DomainExceptionFilter`. Validation failures use the global `ValidationExceptionFilter` (`error: "VALIDATION_ERROR"`). New domain error codes for this phase (added as `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`):

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | No video matches `publicId`, or it is not `ready` and the caller is not its owner |
| NOT_VIDEO_OWNER | 403 | Authenticated caller is not the owner of the video's channel |
| VIDEO_NOT_READY | 409 | Stream/download requested but the video status is not `ready` |
| INVALID_UPLOAD_STATE | 409 | Complete/abort called when the video is not awaiting completion, or `uploadId`/parts mismatch |
| INVALID_FILE_SIZE | 400 | `fileSize` <= 0 or > 10 GiB at upload initiation |

### Events/Messages

#### process-video (BullMQ job on queue `videos`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (API) — after `CompleteMultipartUpload`, enqueues the job and sets status → `processing` (per phase-03-videos/TD-01, TD-02).
**Consumer:** `VideoProcessor` extending `WorkerHost`, running in the standalone worker container (per phase-03-videos/TD-04).
**Trigger:** fires once per successful upload completion (`POST /videos/:publicId/uploads/complete`).
**Processing steps (Consumer):** read the source object from storage → `ffprobe` for duration + metadata (width/height/codec/bitrate) → `ffmpeg` extract one frame as the thumbnail → upload the thumbnail to storage (`thumbnail_key`) → update the row (`duration_seconds`, `size_bytes`, `metadata`, `thumbnail_key`, status → `ready`) (per phase-03-videos/TD-05, TD-08). FFmpeg is invoked via `child_process` (no wrapper lib); the binary is installed in the worker image.
**Retry / failure:** `attempts: 3` with exponential `backoff` (per phase-03-videos/TD-01); on final failure the worker's `@OnWorkerEvent('failed')` handler sets status → `failed` and records `failure_reason` (per phase-03-videos/TD-08).
**Delivery semantics:** at-least-once (BullMQ) — the processor must be idempotent (re-running overwrites thumbnail/metadata; guard on the current status).

---

## Dependency Map

```
SI-03.1 (root — infra: MinIO + Redis + worker container + storage/queue config)
├── SI-03.3 — depends on SI-03.1 (StorageService needs storage config + MinIO)
└── SI-03.4 — depends on SI-03.1 (QueueModule needs queue config + Redis)

SI-03.2 (root — Video entity + CreateVideos migration)

SI-03.5 — depends on SI-03.2, SI-03.3 (upload init needs entity + storage)
SI-03.6 — depends on SI-03.4, SI-03.5 (complete/abort needs queue + upload init)
SI-03.7 — depends on SI-03.3, SI-03.4, SI-03.6 (worker needs storage + queue + job producer)
SI-03.8 — depends on SI-03.3, SI-03.5 (watch/stream/download needs storage + module)
SI-03.9 — depends on SI-03.7, SI-03.8 (full-pipeline e2e needs worker + streaming)
SI-03.10 — depends on SI-03.9 (AI docs + Definition of Done after the feature is complete)
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10.

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage, fila e worker no Compose + config/env
- [ ] SI-03.2 — Entidade Video + migration CreateVideos
- [ ] SI-03.3 — StorageModule (S3/MinIO: multipart + presigned)
- [ ] SI-03.4 — QueueModule (BullMQ + Redis)
- [ ] SI-03.5 — Upload init: pré-cadastro do rascunho + multipart presigned
- [ ] SI-03.6 — Upload complete + abort: enfileira o processamento
- [ ] SI-03.7 — Video worker: standalone context + processor (ffprobe + thumbnail)
- [ ] SI-03.8 — Watch / streaming / download (presigned GET)
- [ ] SI-03.9 — E2E do pipeline completo + coerência do Error Catalog
- [ ] SI-03.10 — Documentação de IA (CLAUDE.md) + Definition of Done

**Full test suites & Definition of Done** (rodadas dentro do container, per `nestjs-project/CLAUDE.md`):

- [ ] Infra sobe no Compose (`cd nestjs-project && docker compose up -d` — `db`, `mailpit`, `minio`, `redis`, `video-worker` saudáveis)
- [ ] Testes unit+integration passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes e2e passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
- [ ] Build compila (`docker compose exec nestjs-api npm run build`)
- [ ] Entregáveis do enunciado: upload de até 10GB funcional, processamento automático, streaming funcionando e URLs únicas geradas
- [ ] `CLAUDE.md` (raiz + `nestjs-project/`) coerentes com o código entregue
