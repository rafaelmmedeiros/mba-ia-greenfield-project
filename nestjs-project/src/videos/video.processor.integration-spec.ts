import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let processor: VideoProcessor;
  let counter = 0;

  beforeAll(async () => {
    const options = createTestDataSource(ALL_ENTITIES)
      .options as TypeOrmModuleOptions;
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot({ ...options, autoLoadEntities: true }),
        StorageModule,
      ],
      providers: [VideoProcessingService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    storage = moduleRef.get(StorageService);
    const processing = moduleRef.get(VideoProcessingService);
    await storage.ensureBucket();
    processor = new VideoProcessor(
      dataSource.getRepository(Video),
      storage,
      processing,
    );
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function seedVideoWithSource(): Promise<Video> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `proc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'C',
        nickname: `proc${counter}`,
        user_id: user.id,
      }),
    );
    const publicId = `proc-${counter}`;
    const key = `videos/${publicId}/source.mp4`;

    // Generate a real 2s test clip and upload it as the video source.
    const clipPath = join(tmpdir(), `${publicId}-src.mp4`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      clipPath,
    ]);
    await storage.putObject(key, await readFile(clipPath), 'video/mp4');

    return dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'clip',
        storage_key: key,
        status: VideoStatus.PROCESSING,
      }),
    );
  }

  it('probes duration, generates a thumbnail, and marks the video ready', async () => {
    const video = await seedVideoWithSource();

    await processor.process({ data: { videoId: video.id } } as Job<{
      videoId: string;
    }>);

    const updated = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(updated.thumbnail_key).toBe(
      `videos/${video.public_id}/thumbnail.jpg`,
    );
    expect(updated.metadata).toMatchObject({ width: 320, height: 240 });

    const thumbUrl = await storage.presignGet(updated.thumbnail_key as string);
    const res = await fetch(thumbUrl);
    expect(res.ok).toBe(true);
  }, 30000);

  async function seedVideoWithBadSource(): Promise<Video> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `procbad_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'C',
        nickname: `procbad${counter}`,
        user_id: user.id,
      }),
    );
    const publicId = `procbad-${counter}`;
    const key = `videos/${publicId}/source.mp4`;
    // Upload bytes that are not a decodable video so ffprobe fails.
    await storage.putObject(
      key,
      Buffer.from('this is definitely not a video file'),
      'video/mp4',
    );
    return dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'bad clip',
        storage_key: key,
        status: VideoStatus.PROCESSING,
      }),
    );
  }

  it('marks the video failed when the source is not processable (retries exhausted)', async () => {
    const video = await seedVideoWithBadSource();
    const job = {
      data: { videoId: video.id },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as Job<{ videoId: string }>;

    // ffprobe rejects the invalid source, so processing throws.
    await expect(processor.process(job)).rejects.toThrow();

    // BullMQ fires 'failed' on the terminal attempt -> persist FAILED + reason.
    await processor.onFailed(job, new Error('ffprobe: invalid data'));

    const updated = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.failure_reason).toBeTruthy();
  }, 30000);
});
