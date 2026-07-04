import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import authConfig from '../config/auth.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_QUEUE } from '../queue/queue.module';
import { ProcessVideoJobData } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue;

  beforeAll(async () => {
    const options = createTestDataSource(ALL_ENTITIES)
      .options as TypeOrmModuleOptions;
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, authConfig],
        }),
        TypeOrmModule.forRoot({ ...options, autoLoadEntities: true }),
        VideosModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
    await storage.ensureBucket();
    // Pause so the running video-worker container does not consume the job we
    // enqueue here (keeps the "job enqueued" assertion race-free in the full suite).
    await queue.pause();
  });

  afterAll(async () => {
    await queue.drain();
    await queue.resume();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();
  });

  let counter = 0;
  async function seedChannel(): Promise<{ userId: string; channelId: string }> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `vid_int_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Chan',
        nickname: `vidint${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  const validDto = {
    title: 'Integration clip',
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    fileSize: 10 * 1024 * 1024,
  };

  it('persists a draft video and starts a real multipart upload', async () => {
    const { userId, channelId } = await seedChannel();

    const result = await service.initiateUpload(userId, validDto);

    expect(result.uploadId).toBeTruthy();
    expect(result.parts.length).toBeGreaterThanOrEqual(1);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.publicId });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.channel_id).toBe(channelId);
    expect(video.multipart_upload_id).toBe(result.uploadId);

    await storage.abortMultipartUpload(result.key, result.uploadId);
  });

  it('completes the upload: marks processing and enqueues a real job', async () => {
    const { userId } = await seedChannel();
    const init = await service.initiateUpload(userId, validDto);

    const putRes = await fetch(init.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('fake video bytes'),
    });
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    const result = await service.completeUpload(userId, init.publicId, {
      uploadId: init.uploadId,
      parts: [{ partNumber: 1, etag: etag as string }],
    });
    expect(result.status).toBe(VideoStatus.PROCESSING);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: init.publicId });
    expect(video.status).toBe(VideoStatus.PROCESSING);

    const waiting = await queue.getJobs(['waiting', 'delayed']);
    expect(
      waiting.some(
        (job) => (job.data as ProcessVideoJobData).videoId === video.id,
      ),
    ).toBe(true);
  });

  it('aborts the upload and deletes the draft', async () => {
    const { userId } = await seedChannel();
    const init = await service.initiateUpload(userId, validDto);

    await service.abortUpload(userId, init.publicId);

    const found = await dataSource
      .getRepository(Video)
      .findOne({ where: { public_id: init.publicId } });
    expect(found).toBeNull();
  });
});
