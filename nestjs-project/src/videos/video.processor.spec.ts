import { Job } from 'bullmq';
import * as fsPromises from 'fs/promises';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

jest.mock('fs/promises');

function makeJob(
  videoId: string,
  attemptsMade = 1,
  attempts = 3,
): Job<{ videoId: string }> {
  return {
    data: { videoId },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<{ videoId: string }>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let repo: { findOneByOrFail: jest.Mock; save: jest.Mock; update: jest.Mock };
  let storage: { presignGet: jest.Mock; putObject: jest.Mock };
  let processing: { probe: jest.Mock; extractThumbnail: jest.Mock };

  beforeEach(() => {
    repo = {
      findOneByOrFail: jest.fn(),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      update: jest.fn(() => Promise.resolve()),
    };
    storage = {
      presignGet: jest.fn(() => Promise.resolve('https://minio/source')),
      putObject: jest.fn(() => Promise.resolve()),
    };
    processing = {
      probe: jest.fn(() =>
        Promise.resolve({
          durationSeconds: 42,
          metadata: {
            width: 1920,
            height: 1080,
            videoCodec: 'h264',
            formatName: 'mov,mp4',
            sizeBytes: 1000,
          },
        }),
      ),
      extractThumbnail: jest.fn(() => Promise.resolve()),
    };
    (fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from('thumb'));
    (fsPromises.rm as jest.Mock).mockResolvedValue(undefined);

    processor = new VideoProcessor(
      repo as unknown as Repository<Video>,
      storage as unknown as StorageService,
      processing as unknown as VideoProcessingService,
    );
  });

  it('probes, thumbnails, and marks the video ready', async () => {
    const video = {
      id: 'vid-1',
      public_id: 'pub-1',
      storage_key: 'videos/pub-1/source.mp4',
      status: VideoStatus.PROCESSING,
    } as Video;
    repo.findOneByOrFail.mockResolvedValue(video);

    await processor.process(makeJob('vid-1'));

    expect(processing.probe).toHaveBeenCalledWith('https://minio/source');
    expect(processing.extractThumbnail).toHaveBeenCalled();
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/pub-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );

    const finalSave = repo.save.mock.calls.at(-1)?.[0] as Video;
    expect(finalSave.status).toBe(VideoStatus.READY);
    expect(finalSave.duration_seconds).toBe(42);
    expect(finalSave.thumbnail_key).toBe('videos/pub-1/thumbnail.jpg');
    expect(finalSave.metadata).toMatchObject({ width: 1920, height: 1080 });
  });

  it('marks the video failed once retries are exhausted', async () => {
    await processor.onFailed(makeJob('vid-1', 3, 3), new Error('boom'));
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'vid-1' },
      { status: VideoStatus.FAILED, failure_reason: 'boom' },
    );
  });

  it('does not mark failed on a non-final attempt', async () => {
    await processor.onFailed(makeJob('vid-1', 1, 3), new Error('retry'));
    expect(repo.update).not.toHaveBeenCalled();
  });
});
