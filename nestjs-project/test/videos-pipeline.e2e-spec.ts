import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const execFileAsync = promisify(execFile);

interface VideoMetadata {
  publicId: string;
  status: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

// Exercises the full pipeline against the running Compose stack (real MinIO,
// Redis, and the live `video-worker` container): upload → complete → the worker
// processes the clip → `ready` → stream back with Range/206.
describe('Videos — full pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmationToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return res.body.access_token as string;
  }

  async function pollUntilReady(
    publicId: string,
    token: string,
    timeoutMs = 60000,
  ): Promise<VideoMetadata> {
    const deadline = Date.now() + timeoutMs;
    let last: VideoMetadata | undefined;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      last = res.body as VideoMetadata;
      if (last.status === 'ready') return last;
      if (last.status === 'failed') {
        throw new Error(
          `worker marked the video failed: ${JSON.stringify(last)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `video ${publicId} not ready within ${timeoutMs}ms (last status: ${last?.status})`,
    );
  }

  it('uploads a real clip, the worker processes it to ready, and streams it with Range', async () => {
    // A real, tiny clip so the worker's ffprobe/ffmpeg have valid input.
    const clipPath = join(tmpdir(), `pipeline-${Date.now()}.mp4`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=160x120:rate=15',
      '-pix_fmt',
      'yuv420p',
      clipPath,
    ]);
    const clip = await readFile(clipPath);

    const token = await registerConfirmLogin('pipeline@example.com');
    const server = app.getHttpServer();

    // 1. Initiate — a small clip fits in a single part.
    const initRes = await request(server)
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Pipeline clip',
        filename: 'pipeline.mp4',
        contentType: 'video/mp4',
        fileSize: clip.length,
      })
      .expect(201);
    const init = initRes.body as {
      publicId: string;
      uploadId: string;
      parts: { partNumber: number; url: string }[];
    };
    expect(init.parts).toHaveLength(1);

    // 2. Upload the bytes straight to storage via the presigned URL.
    const putRes = await fetch(init.parts[0].url, {
      method: 'PUT',
      body: clip,
    });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag') as string;
    expect(etag).toBeTruthy();

    // 3. Complete — enqueues the job the live worker consumes.
    await request(server)
      .post(`/videos/${init.publicId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ uploadId: init.uploadId, parts: [{ partNumber: 1, etag }] })
      .expect(200);

    // 4. The worker container processes it to `ready`.
    const ready = await pollUntilReady(init.publicId, token);
    expect(ready.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(ready.thumbnailUrl).toContain('http');

    // 5. Once ready it is publicly readable.
    const anon = await request(server)
      .get(`/videos/${init.publicId}`)
      .expect(200);
    expect(anon.body.status).toBe('ready');

    // 6. The stream URL serves the uploaded bytes with Range/206 from storage.
    const streamRes = await request(server)
      .get(`/videos/${init.publicId}/stream`)
      .expect(200);
    const rangeRes = await fetch(streamRes.body.url as string, {
      headers: { Range: 'bytes=0-15' },
    });
    expect(rangeRes.status).toBe(206);
    const partial = Buffer.from(await rangeRes.arrayBuffer());
    expect(partial.length).toBe(16);
    expect(partial.equals(clip.subarray(0, 16))).toBe(true);
  }, 90000);
});
