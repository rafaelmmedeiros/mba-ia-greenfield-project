import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidFileSizeException,
  InvalidUploadStateException,
  NotVideoOwnerException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_QUEUE } from '../queue/queue.module';
import {
  MAX_FILE_SIZE_BYTES,
  PLAYBACK_URL_TTL_SECONDS,
} from './videos.constants';
import { VideosService } from './videos.service';

function draftVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'vid-1',
    public_id: 'pub-1',
    channel_id: 'ch-1',
    title: 'clip',
    status: VideoStatus.DRAFT,
    storage_key: 'videos/pub-1/source.mp4',
    multipart_upload_id: 'upload-1',
    ...overrides,
  } as Video;
}

function readyVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'vid-1',
    public_id: 'pub-1',
    channel_id: 'ch-1',
    title: 'clip',
    description: 'a clip',
    status: VideoStatus.READY,
    storage_key: 'videos/pub-1/source.mp4',
    thumbnail_key: 'videos/pub-1/thumbnail.jpg',
    original_filename: 'clip.mp4',
    duration_seconds: 42,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    channel: { user_id: 'user-1', nickname: 'chan', name: 'My Channel' },
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    remove: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignGet: jest.Mock;
  };
  let videoQueue: { add: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((v: Partial<Video>) => v),
      save: jest.fn((v: Partial<Video>) =>
        Promise.resolve({ id: 'vid-1', ...v }),
      ),
      findOne: jest.fn(),
      remove: jest.fn(() => Promise.resolve()),
    };
    channelsService = {
      findByUserId: jest.fn(() => Promise.resolve({ id: 'ch-1' })),
    };
    storageService = {
      createMultipartUpload: jest.fn(() => Promise.resolve('upload-1')),
      presignUploadPart: jest.fn((_k: string, _u: string, n: number) =>
        Promise.resolve(`https://minio/part-${n}`),
      ),
      completeMultipartUpload: jest.fn(() => Promise.resolve()),
      abortMultipartUpload: jest.fn(() => Promise.resolve()),
      presignGet: jest.fn(() => Promise.resolve('https://minio/signed')),
    };
    videoQueue = { add: jest.fn(() => Promise.resolve()) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_QUEUE), useValue: videoQueue },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('creates a draft video and returns presigned parts', async () => {
      const result = await service.initiateUpload('user-1', {
        title: 'My clip',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        fileSize: 150 * 1024 * 1024, // 150 MiB → 2 parts at 100 MiB
      });

      expect(result.videoId).toBe('vid-1');
      expect(result.publicId).toHaveLength(21);
      expect(result.uploadId).toBe('upload-1');
      expect(result.key).toBe(`videos/${result.publicId}/source.mp4`);
      expect(result.parts).toHaveLength(2);

      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe('ch-1');
      expect(saved.size_bytes).toBe(String(150 * 1024 * 1024));
    });

    it('rejects a file larger than 10 GiB with INVALID_FILE_SIZE', async () => {
      await expect(
        service.initiateUpload('user-1', {
          title: 'Huge',
          filename: 'huge.mp4',
          contentType: 'video/mp4',
          fileSize: MAX_FILE_SIZE_BYTES + 1,
        }),
      ).rejects.toBeInstanceOf(InvalidFileSizeException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a non-positive file size with INVALID_FILE_SIZE', async () => {
      await expect(
        service.initiateUpload('user-1', {
          title: 'Empty',
          filename: 'empty.mp4',
          contentType: 'video/mp4',
          fileSize: 0,
        }),
      ).rejects.toBeInstanceOf(InvalidFileSizeException);
    });
  });

  describe('completeUpload', () => {
    it('completes the upload, marks processing and enqueues the job', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      const result = await service.completeUpload('user-1', 'pub-1', {
        uploadId: 'upload-1',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/pub-1/source.mp4',
        'upload-1',
        [{ partNumber: 1, etag: 'etag-1' }],
      );
      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(videoQueue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'vid-1' },
        expect.objectContaining({ attempts: 3 }),
      );
      expect(result).toEqual({
        publicId: 'pub-1',
        status: VideoStatus.PROCESSING,
      });
    });

    it('throws VIDEO_NOT_FOUND when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(
        service.completeUpload('user-1', 'nope', {
          uploadId: 'upload-1',
          parts: [{ partNumber: 1, etag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws NOT_VIDEO_OWNER when the caller is not the owner', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ channel_id: 'other-channel' }),
      );
      await expect(
        service.completeUpload('user-1', 'pub-1', {
          uploadId: 'upload-1',
          parts: [{ partNumber: 1, etag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(NotVideoOwnerException);
    });

    it('throws INVALID_UPLOAD_STATE when the video is not a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.READY }),
      );
      await expect(
        service.completeUpload('user-1', 'pub-1', {
          uploadId: 'upload-1',
          parts: [{ partNumber: 1, etag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);
      expect(videoQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart and removes the draft', async () => {
      const video = draftVideo();
      videoRepository.findOne.mockResolvedValue(video);

      await service.abortUpload('user-1', 'pub-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/pub-1/source.mp4',
        'upload-1',
      );
      expect(videoRepository.remove).toHaveBeenCalledWith(video);
    });
  });

  describe('getByPublicId', () => {
    it('returns metadata with a presigned thumbnail URL for a ready video', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());

      const result = await service.getByPublicId('pub-1');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/pub-1/thumbnail.jpg',
      );
      expect(result).toEqual({
        publicId: 'pub-1',
        title: 'clip',
        description: 'a clip',
        status: VideoStatus.READY,
        durationSeconds: 42,
        thumbnailUrl: 'https://minio/signed',
        channel: { nickname: 'chan', name: 'My Channel' },
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('returns a null thumbnailUrl when the ready video has no thumbnail', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ thumbnail_key: null }),
      );

      const result = await service.getByPublicId('pub-1');

      expect(result.thumbnailUrl).toBeNull();
      expect(storageService.presignGet).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_FOUND when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(service.getByPublicId('nope')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('hides a non-ready video from an anonymous caller (VIDEO_NOT_FOUND)', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(service.getByPublicId('pub-1')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('hides a non-ready video from a non-owner (VIDEO_NOT_FOUND)', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(
        service.getByPublicId('pub-1', 'someone-else'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('lets the owner read their own non-ready video', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ status: VideoStatus.PROCESSING, thumbnail_key: null }),
      );

      const result = await service.getByPublicId('pub-1', 'user-1');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.thumbnailUrl).toBeNull();
    });
  });

  describe('getStreamUrl', () => {
    it('returns a presigned stream URL for a ready video', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());

      const result = await service.getStreamUrl('pub-1');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/pub-1/source.mp4',
        { expiresIn: PLAYBACK_URL_TTL_SECONDS },
      );
      expect(result).toEqual({
        url: 'https://minio/signed',
        expiresIn: PLAYBACK_URL_TTL_SECONDS,
      });
    });

    it('throws VIDEO_NOT_FOUND when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(service.getStreamUrl('nope')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('throws VIDEO_NOT_READY when the video is not ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(service.getStreamUrl('pub-1')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('returns a presigned attachment URL using the original filename', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());

      const result = await service.getDownloadUrl('pub-1');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/pub-1/source.mp4',
        { expiresIn: PLAYBACK_URL_TTL_SECONDS, downloadFilename: 'clip.mp4' },
      );
      expect(result).toEqual({
        url: 'https://minio/signed',
        expiresIn: PLAYBACK_URL_TTL_SECONDS,
      });
    });

    it('throws VIDEO_NOT_READY when the video is not ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ status: VideoStatus.FAILED }),
      );
      await expect(service.getDownloadUrl('pub-1')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
    });
  });
});
