import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `vidchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      public_id: `pub_${++counter}`,
      channel_id: channel.id,
      title: 'My Video',
      storage_key: `videos/${counter}/source.mp4`,
      ...overrides,
    });
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel));

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce unique public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel, { public_id: 'dup-id' }));

    await expect(
      videoRepository.save(buildVideo(channel, { public_id: 'dup-id' })),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel_id references no channel (FK)', async () => {
    const orphan = videoRepository.create({
      public_id: 'orphan',
      channel_id: '00000000-0000-0000-0000-000000000000',
      title: 'Orphan',
      storage_key: 'videos/orphan/source.mp4',
    });

    await expect(videoRepository.save(orphan)).rejects.toThrow();
  });

  it('should persist the enum status and leave optional fields null by default', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel, {
        status: VideoStatus.READY,
        duration_seconds: 42,
        thumbnail_key: 'videos/x/thumb.jpg',
        metadata: { width: 1920, height: 1080 },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.READY);
    expect(found.duration_seconds).toBe(42);
    expect(found.metadata).toEqual({ width: 1920, height: 1080 });
    expect(found.description).toBeNull();
    expect(found.failure_reason).toBeNull();
    expect(found.thumbnail_key).toBe('videos/x/thumb.jpg');
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel, { public_id: 'rel-vid' }));

    const found = await videoRepository.findOne({
      where: { public_id: 'rel-vid' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
