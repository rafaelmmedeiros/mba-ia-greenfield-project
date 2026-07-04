---
libs:
  bullmq:
    version: "^5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-04T15:49:41-03:00"
  "@nestjs/bullmq":
    version: "^11"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-04T15:49:41-03:00"
  "@aws-sdk/client-s3":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-04T15:49:41-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-04T15:49:41-03:00"
  nanoid:
    version: "^3"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-04T15:49:41-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-04T15:48:33-03:00"
---

# phase-03-videos — Library References

Cached Context7 docs for the libraries newly introduced by this phase. Versions
are ranges to install (nothing is installed yet); `implement` runs `npm install`
and the resolved versions become the source of truth. All hosts use Docker
Compose service names (`redis`, `minio`), never `localhost`.

## bullmq

**Version:** `^5` · **Docs:** `/taskforcesh/bullmq` (TD-01)

Redis-backed queue. Core primitives: `Queue` (producer), `Worker`/processor
(consumer), `Job`. Retries + exponential backoff are declared per job; after
`attempts` are exhausted the job moves to the `failed` state (drives the
`processing → failed` transition in TD-08).

```ts
// producer — enqueue a processing job
await queue.add(
  'process-video',
  { videoId },
  { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }, // 1s, 2s, 4s
);
```

- Connection is an **ioredis** options object (ioredis ships transitively with
  bullmq — no separate install needed): `{ host: 'redis', port: 6379 }`.
- A failed job carries the error; capture it in the worker's `failed` event to
  persist a `failure_reason`.

## @nestjs/bullmq

**Version:** `^11` (tracks NestJS 11) · **Docs:** `/taskforcesh/bullmq` (TD-01, TD-04)

NestJS wrapper over bullmq. Register the queue in the owning module; inject the
producer in the API; run the processor in the worker (TD-04 standalone context).

```ts
// module wiring (API side registers the queue; worker side registers processor)
BullModule.registerQueue({
  name: 'videos',
  connection: { host: 'redis', port: 6379 },
});

// producer (API service)
constructor(@InjectQueue('videos') private readonly queue: Queue) {}

// consumer (worker) — register VideoProcessor as a provider in WorkerModule
@Processor('videos')
export class VideoProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {
    // ffprobe metadata + ffmpeg thumbnail (TD-05); write thumbnail to storage;
    // update video row: processing → ready
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    // update video row: processing → failed, store err.message
  }
}
```

- Prefer `BullModule.forRootAsync` / `registerQueueAsync` with `ConfigType<typeof queueConfig>`
  to source the connection from config (inherited `registerAs` convention).

## @aws-sdk/client-s3

**Version:** `^3` (modular v3) · **Docs:** `/aws/aws-sdk-js-v3` (TD-02, TD-03, TD-07)

S3 client + per-operation commands. Point it at MinIO locally; swap to real S3
in prod by changing endpoint/credentials only.

```ts
const s3 = new S3Client({
  endpoint: 'http://minio:9000', // Compose service name
  region: 'us-east-1',
  forcePathStyle: true,          // required for MinIO
  credentials: { accessKeyId, secretAccessKey },
});
```

Multipart (TD-02 — mandatory for 10GB, single PUT caps at 5GB):

- `CreateMultipartUploadCommand({ Bucket, Key })` → `{ UploadId }`.
- `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` — presigned per part
  (client PUTs the bytes directly to storage; each response returns an `ETag`).
- `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })`.
- `AbortMultipartUploadCommand` to clean up an abandoned upload.

Also: `GetObjectCommand` (download/stream), `HeadObjectCommand`, `DeleteObjectCommand`.

## @aws-sdk/s3-request-presigner

**Version:** `^3` · **Docs:** `/aws/aws-sdk-js-v3` (TD-02, TD-07)

`getSignedUrl(client, command, { expiresIn })` — turns any command into a
short-lived presigned URL (default `expiresIn` 900s). File bytes never pass
through the API.

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

// streaming / watch — client streams from storage (Range/206 handled by S3/MinIO)
const streamUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });

// download — force attachment
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="video.mp4"' }),
  { expiresIn: 3600 },
);

// upload — presign each multipart part
const partUrl = await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });
```

- To sign extra `x-amz-*` headers (e.g. checksums) use `{ unhoistableHeaders: new Set([...]) }`.

## nanoid

**Version:** `^3` (CommonJS) · **Docs:** `/ai/nanoid` (TD-06)

> **Pin v3.** nanoid v4+ is **ESM-only** and breaks this CommonJS Nest build.
> The v3 line is the last CommonJS release.

```ts
import { nanoid, customAlphabet } from 'nanoid'; // v3 supports require/CJS interop

const publicId = nanoid();          // 21 chars over A-Za-z0-9_- (≈ UUIDv4 collision)
const shorter = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 11)();
```

- Store in a `unique`, `@Index()`-ed `public_id` column; keep a unique-violation
  retry (mirror `ChannelsService`'s nickname collision loop) as belt-and-suspenders.
- If avoiding the dependency is preferred, the zero-dep `crypto.randomBytes(n).toString('base64url')`
  fallback (TD-06 Option B) is CJS-native and needs no version pin.
