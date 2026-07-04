# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Infra: object storage, fila e worker no Compose + config/env
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Stack sobe healthy: `minio` (healthcheck `curl -f /minio/health/live` — curl existe na imagem minio/minio), `redis`, `db`; `video-worker` idle (`tail -f /dev/null`) até SI-03.7 apontar o CMD para `start:worker`.
  - Adicionado volume nomeado `pgdata` — Postgres agora persistente (era efêmero); o container `db` foi recriado e as migrations reaplicadas.
  - `env.validation.integration-spec.ts` teve o fixture `requiredEnv` estendido com os `S3_*` obrigatórios para seguir verde. `tsc --noEmit` = 0.

### SI-03.2 — Entidade Video + migration CreateVideos
- **Status:** completed
- **Tests:** 7 passing (video.entity.integration-spec: 5, migrations.integration-spec: 2)
- **Observations:**
  - Migration `1783194634242-CreateVideos` gerada via CLI (enum `videos_status_enum`, `public_id` unique, índices `channel_id`/`status`, FK → `channels`).
  - `migrations.integration-spec` atualizado: +Video/+CreateVideos, `MANAGED_TABLES` +videos, drop do `videos_status_enum` no `beforeAll` (gotcha de isolamento de enum), asserts 3 migrations / 5 tabelas, test2 reverte a tabela `videos`.
  - `cleanAllTables`: delete de `videos` guardado por `to_regclass` (specs sem a entidade Video não têm a tabela).

### SI-03.3 — StorageModule (S3/MinIO: multipart + presigned)
- **Status:** completed
- **Tests:** 5 passing (storage.service.integration-spec: 4, storage.module.spec: 1)
- **Observations:**
  - `StorageService` (AWS SDK v3, `forcePathStyle` para MinIO): `ensureBucket` (via `onModuleInit`), `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `presignGet` (com `attachment` opcional).
  - Integration exercita o round-trip real: init → `PUT` da parte na URL presigned → complete → `presignGet` baixável (contra o MinIO do Compose).
  - Métodos de `getObject`/`putObject` (usados pelo worker) ficam para o SI-03.7.

### SI-03.4 — QueueModule (BullMQ + Redis)
- **Status:** completed
- **Tests:** 1 passing (queue.module.integration-spec)
- **Observations:**
  - `QueueModule`: `BullModule.forRootAsync` (connection do `queue.config`) + `registerQueue({ name: 'videos' })`, exporta `BullModule`; constante `VIDEO_QUEUE = 'videos'`.
  - Integration enfileira um job no Redis real e o lê de volta; Jest encerra limpo (teardown com `obliterate` + `moduleRef.close()` fecha a conexão — sem open-handle).

### SI-03.5 — Upload init: pré-cadastro do rascunho + multipart presigned
- **Status:** completed
- **Tests:** 7 passing (videos.service.spec: 3 unit, videos.service.integration-spec: 1, videos.e2e-spec: 3)
- **Observations:**
  - `POST /videos/uploads`: resolve o canal do usuário (`ChannelsService.findByUserId`, método novo), gera `public_id` nanoid v3 com retry+abort em colisão, inicia multipart e devolve URLs presigned por parte (partSize 100 MiB). Guarda de `fileSize` (1..10 GiB) → `InvalidFileSizeException` (400 `INVALID_FILE_SIZE`).
  - VideosModule importa Channels+Storage; registrado no AppModule. E2e confirma app completo (Redis+MinIO) subindo e **encerrando limpo** (BullMQ fecha no `app.close()`).
  - `nanoid@3.3.15` (CJS) instalado; `import { nanoid }` compila e roda no build CommonJS.

### SI-03.6 — Upload complete + abort: enfileira o processamento
- **Status:** completed
- **Tests:** 19 passing (videos.service.spec: 8 unit, videos.service.integration-spec: 3, videos.e2e-spec: 8)
- **Observations:**
  - `POST /videos/:publicId/uploads/complete` (fecha o multipart, `draft→processing`, enfileira `process-video` com `attempts:3`+backoff exponencial) e `DELETE /videos/:publicId/uploads` (aborta + remove o rascunho). Helper `getOwnedVideo` (404/403), guarda de estado (409). Exceções `VideoNotFound`/`NotVideoOwner`/`InvalidUploadState`/`VideoNotReady` adicionadas.
  - `VideosModule` agora importa `QueueModule`; `VideosService` injeta a fila. O integration spec **pausa a fila** no `beforeAll` (e resume no `afterAll`) pra evitar corrida com o container `video-worker` no full-suite.

### SI-03.7 — Video worker: standalone context + processor (ffprobe + thumbnail)
- **Status:** completed
- **Tests:** 4 passing (video.processor.spec: 3 unit, video.processor.integration-spec: 1 — ffmpeg + MinIO + DB reais)
- **Observations:**
  - `VideoProcessingService` encapsula `ffprobe` (duração + metadata via JSON) e `ffmpeg` (thumbnail de 1 frame) por `child_process.spawn`; `VideoProcessor` (`@Processor('videos')` + `WorkerHost`) faz `processing→ready`: presignGet do source → probe → thumbnail (`-ss min(1, duração-1)`) → `putObject` da thumb → grava duração/metadata/thumbnail_key. `@OnWorkerEvent('failed')` só marca `failed` quando as tentativas se esgotam (`attemptsMade >= opts.attempts`).
  - `WorkerModule` = contexto standalone (`createApplicationContext`, sem HTTP). **Gotcha:** com `autoLoadEntities` o worker só enxergaria `Video` e a relação `Video→Channel→User→tokens` não resolvia (`Entity metadata for Video#channel was not found`); troquei por `entities: ['src/**/*.entity.ts']` (mesmo glob do runtime `data-source.ts`). Worker sobe conectando DB+Redis+MinIO e consome a fila `videos`.
  - Adicionados: `putObject` no `StorageService`, script npm `start:worker` (ts-node CommonJS), `command: npm run start:worker` no serviço `video-worker` do Compose, e `ffmpeg` no `Dockerfile.dev` (para o integration test rodar ffmpeg real dentro do container `nestjs-api`).
  - Integration gera um clipe real (`ffmpeg -f lavfi -i testsrc=duration=2:size=320x240`), sobe no MinIO e processa de verdade → assere `ready` + duração ≥ 1 + `thumbnail_key` + thumb baixável via presigned GET.

### SI-03.8 — Watch / streaming / download (presigned GET)
- **Status:** completed
- **Tests:** 15 passing (videos.service.spec: +11 → 19 total; videos.e2e-spec: +4 → 12 total). Full suite verified green: 31 suites/181 (unit+int) + 4 suites/64 (e2e).
- **Observations:**
  - `GET /videos/:publicId` (metadados + status, com `thumbnailUrl` presigned quando `ready`), `GET .../stream` e `.../download` (presigned GET; download com `ResponseContentDisposition: attachment` a partir de `original_filename`). Gate `ready`: stream/download não-`ready` → 409 `VIDEO_NOT_READY`; metadados de um vídeo não-`ready` são 404 `VIDEO_NOT_FOUND` para todos menos o dono.
  - **Auth opcional:** o contrato exige que o dono leia o próprio vídeo não-`ready` (e 401 em token inválido), o que `@Public()` puro não expressa. Criei `OptionalJwtAuthGuard` (auth/guards) — anexa `request.user` se o bearer for válido, segue anônimo se ausente, 401 se presente-e-inválido. A rota de metadados leva `@Public()` + `@UseGuards(OptionalJwtAuthGuard)`.
  - **Decisão de módulo:** `VideosModule` **não** importa o `AuthModule` (arrastaria Mail/Users/Throttler/APP_GUARD). Em vez disso registra um `JwtModule` verify-only (só `secret`, via `authConfig`) e provê o `OptionalJwtAuthGuard` localmente. Constante `PLAYBACK_URL_TTL_SECONDS` (1h) devolvida como `expiresIn`.
- **Dívidas latentes da Fase 03 descobertas e corrigidas aqui** (a suíte completa nunca havia rodado junta desde o baseline; nos SIs 03.2–03.7 rodei só o escopo de cada um):
  - **Metadata (dívida do SI-03.2):** `Channel` ganhou `@OneToMany(() => Video)`, então todo DataSource de teste que registrava `Channel` sem `Video` quebrava (`Entity metadata for Channel#videos was not found`). Adicionado `Video` ao `ALL_ENTITIES` de 10 specs (auth/users/channels).
  - **Hang do jest:** a suíte completa pendurava ~16 min. Causa: `VideosModule` importando o `AuthModule` inteiro fazia o `videos.service.integration-spec` (que monta módulo sem `authConfig`) falhar no compile do `beforeAll` → `queue` undefined → `afterAll` quebrava em `queue.drain()` → `moduleRef.close()` pulado → conexão Redis/BullMQ vazada → jest não saía. Resolvido pelo desacoplamento do módulo acima + `authConfig` no `ConfigModule` do spec. Agora a suíte sai limpa sem `--forceExit`.

### SI-03.9 — E2E do pipeline completo + coerência do Error Catalog
- **Status:** completed
- **Tests:** 6 passing (videos-pipeline.e2e-spec: 1 pipeline real; domain.exception.spec: 5 coerência). Suíte e2e completa serial: 5 suites/65.
- **Observations:**
  - `test/videos-pipeline.e2e-spec.ts` exercita a stack inteira do Compose **sem mock**: gera um clipe real (`ffmpeg -f lavfi -i testsrc=duration=2`), sobe via presigned PUT → complete → o **container `video-worker` em execução** consome o job → poll de `GET /videos/:publicId` (como dono) até `ready` (~2,5s) → assere `durationSeconds`≥1 + `thumbnailUrl` → anônimo lê `ready` → `GET .../stream` e `fetch(url, {Range: 'bytes=0-15'})` retorna **206** com os 16 primeiros bytes idênticos aos enviados.
  - `src/common/exceptions/domain.exception.spec.ts`: checagem de consolidação — cada `DomainException` de vídeo mapeia para o `errorCode`+HTTP do `### Error Catalog` (todos os 5 caminhos já são exercitados de ponta a ponta no `videos.e2e-spec`).
  - **Bug de config corrigido:** o script `test:e2e` não passava `--runInBand` (contradizendo o CLAUDE.md, "e2e always with --runInBand"); os specs e2e rodavam em paralelo contra o banco `streamtube` compartilhado. Adicionado `--runInBand` → serial e determinístico (obrigatório para o poll do pipeline não ser apagado pelo `cleanAllTables` de outro spec).

### SI-03.10 — Documentação de IA (CLAUDE.md) + Definition of Done
- **Status:** completed
- **Tests:** no tests (documentação + verificação)
- **Observations:**
  - **Root `CLAUDE.md`:** "Message Queue (TBD)" → "BullMQ on Redis" no diagrama C4.
  - **`nestjs-project/CLAUDE.md`:** adicionados serviços `minio`/`redis`/`video-worker` (Development Environment) + probes de prontidão (`curl /minio/health/live`, `redis-cli ping`) na Environment Startup Verification; nova subseção **Video Pipeline** na Architecture (endpoints `/videos`, `StorageModule`, `QueueModule`, worker standalone) — só descreve o que existe no código entregue.
  - **DoD completa verde** (dentro do container): unit+integration 32 suites/186 (sai limpo sem `--forceExit`), e2e 5 suites/65, `tsc --noEmit`=0, `npm run lint`=0, `npm run build`=0. Stack Compose saudável (db, mailpit, minio, redis, video-worker).
