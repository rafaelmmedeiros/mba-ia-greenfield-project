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
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('Videos — upload init (e2e)', () => {
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

  it('returns 201 with presigned parts for a valid upload', async () => {
    const accessToken = await registerConfirmLogin('uploader@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'My clip',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: 10 * 1024 * 1024,
      })
      .expect(201);

    expect(res.body.videoId).toBeDefined();
    expect(res.body.publicId).toBeDefined();
    expect(res.body.uploadId).toBeDefined();
    expect(Array.isArray(res.body.parts)).toBe(true);
    expect(res.body.parts[0].url).toContain('http');
  });

  it('returns 400 INVALID_FILE_SIZE for a file over 10 GiB', async () => {
    const accessToken = await registerConfirmLogin('big@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Huge',
        filename: 'huge.mp4',
        contentType: 'video/mp4',
        fileSize: 11 * 1024 * 1024 * 1024,
      })
      .expect(400);

    expect(res.body.error).toBe('INVALID_FILE_SIZE');
  });

  it('returns 401 without an access token', async () => {
    await request(app.getHttpServer())
      .post('/videos/uploads')
      .send({
        title: 'x',
        filename: 'x.mp4',
        contentType: 'video/mp4',
        fileSize: 1000,
      })
      .expect(401);
  });

  interface InitiatedUpload {
    publicId: string;
    uploadId: string;
    parts: { partNumber: number; url: string }[];
  }

  async function initiate(accessToken: string): Promise<InitiatedUpload> {
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Clip',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: 5 * 1024 * 1024,
      })
      .expect(201);
    return res.body as InitiatedUpload;
  }

  async function putPart(url: string): Promise<string> {
    const putRes = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('fake video bytes'),
    });
    return putRes.headers.get('etag') as string;
  }

  it('completes an upload and returns 200 processing', async () => {
    const token = await registerConfirmLogin('completer@example.com');
    const init = await initiate(token);
    const etag = await putPart(init.parts[0].url);

    const res = await request(app.getHttpServer())
      .post(`/videos/${init.publicId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ uploadId: init.uploadId, parts: [{ partNumber: 1, etag }] })
      .expect(200);

    expect(res.body.status).toBe('processing');
  });

  it('returns 404 VIDEO_NOT_FOUND completing an unknown video', async () => {
    const token = await registerConfirmLogin('nf@example.com');
    const res = await request(app.getHttpServer())
      .post('/videos/does-not-exist/uploads/complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ uploadId: 'x', parts: [{ partNumber: 1, etag: 'e' }] })
      .expect(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('returns 403 NOT_VIDEO_OWNER when another user completes', async () => {
    const owner = await registerConfirmLogin('owner@example.com');
    const init = await initiate(owner);
    const intruder = await registerConfirmLogin('intruder@example.com');

    const res = await request(app.getHttpServer())
      .post(`/videos/${init.publicId}/uploads/complete`)
      .set('Authorization', `Bearer ${intruder}`)
      .send({ uploadId: init.uploadId, parts: [{ partNumber: 1, etag: 'e' }] })
      .expect(403);
    expect(res.body.error).toBe('NOT_VIDEO_OWNER');
  });

  it('returns 409 INVALID_UPLOAD_STATE completing a non-draft video', async () => {
    const token = await registerConfirmLogin('twice@example.com');
    const init = await initiate(token);
    const etag = await putPart(init.parts[0].url);
    await request(app.getHttpServer())
      .post(`/videos/${init.publicId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ uploadId: init.uploadId, parts: [{ partNumber: 1, etag }] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/videos/${init.publicId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ uploadId: init.uploadId, parts: [{ partNumber: 1, etag }] })
      .expect(409);
    expect(res.body.error).toBe('INVALID_UPLOAD_STATE');
  });

  it('aborts an upload and returns 204', async () => {
    const token = await registerConfirmLogin('aborter@example.com');
    const init = await initiate(token);

    await request(app.getHttpServer())
      .delete(`/videos/${init.publicId}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(app.getHttpServer())
      .post(`/videos/${init.publicId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ uploadId: init.uploadId, parts: [{ partNumber: 1, etag: 'e' }] })
      .expect(404);
  });

  // The e2e app does not run the worker, so promote the draft to `ready`
  // directly to exercise the watch/stream/download reads.
  async function markReady(publicId: string): Promise<void> {
    await dataSource.getRepository(Video).update(
      { public_id: publicId },
      {
        status: VideoStatus.READY,
        thumbnail_key: `videos/${publicId}/thumbnail.jpg`,
        duration_seconds: 5,
      },
    );
  }

  it('lets an anonymous caller read a ready video and its presigned URLs', async () => {
    const token = await registerConfirmLogin('watcher@example.com');
    const init = await initiate(token);
    await markReady(init.publicId);
    const server = app.getHttpServer();

    const meta = await request(server)
      .get(`/videos/${init.publicId}`)
      .expect(200);
    expect(meta.body.publicId).toBe(init.publicId);
    expect(meta.body.status).toBe('ready');
    expect(meta.body.thumbnailUrl).toContain('http');
    expect(meta.body.channel.nickname).toBeDefined();

    const stream = await request(server)
      .get(`/videos/${init.publicId}/stream`)
      .expect(200);
    expect(stream.body.url).toContain('http');
    expect(stream.body.expiresIn).toBeGreaterThan(0);

    const download = await request(server)
      .get(`/videos/${init.publicId}/download`)
      .expect(200);
    expect(download.body.url).toContain('http');
    expect(download.body.url).toContain('attachment');
  });

  it('returns 404 VIDEO_NOT_FOUND reading an unknown video', async () => {
    const res = await request(app.getHttpServer())
      .get('/videos/does-not-exist')
      .expect(404);
    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });

  it('hides a non-ready video from anonymous but lets the owner read it', async () => {
    const token = await registerConfirmLogin('poller@example.com');
    const init = await initiate(token);
    const server = app.getHttpServer();

    // Anonymous sees a not-ready video as missing.
    await request(server).get(`/videos/${init.publicId}`).expect(404);

    // A supplied-but-invalid token is rejected.
    await request(server)
      .get(`/videos/${init.publicId}`)
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);

    // The owner can poll their own draft.
    const owned = await request(server)
      .get(`/videos/${init.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(owned.body.status).toBe('draft');
  });

  it('returns 409 VIDEO_NOT_READY streaming a non-ready video', async () => {
    const token = await registerConfirmLogin('early@example.com');
    const init = await initiate(token);

    const res = await request(app.getHttpServer())
      .get(`/videos/${init.publicId}/stream`)
      .expect(409);
    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });
});
