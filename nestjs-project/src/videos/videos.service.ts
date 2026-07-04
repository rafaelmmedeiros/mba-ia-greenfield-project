import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { extname } from 'path';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidFileSizeException,
  InvalidUploadStateException,
  NotVideoOwnerException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VIDEO_QUEUE } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_PUBLIC_ID_RETRIES,
  PLAYBACK_URL_TTL_SECONDS,
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

function isPublicIdConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as { code?: unknown; detail?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('public_id')
  );
}

export interface UploadPart {
  partNumber: number;
  url: string;
}

export interface InitiateUploadResult {
  videoId: string;
  publicId: string;
  uploadId: string;
  key: string;
  partSize: number;
  parts: UploadPart[];
}

export interface CompleteUploadResult {
  publicId: string;
  status: VideoStatus;
}

export interface VideoMetadataResult {
  publicId: string;
  title: string;
  description: string | null;
  status: VideoStatus;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  channel: { nickname: string; name: string };
  createdAt: string;
}

export interface PlaybackUrlResult {
  url: string;
  expiresIn: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_QUEUE)
    private readonly videoQueue: Queue,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.fileSize <= 0 || dto.fileSize > MAX_FILE_SIZE_BYTES) {
      throw new InvalidFileSizeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every confirmed user owns a channel (created at registration); this
      // guards the impossible state rather than persisting an orphan video.
      throw new Error(`Authenticated user ${userId} has no channel`);
    }

    const ext = extname(dto.filename);

    for (let attempt = 0; attempt < MAX_PUBLIC_ID_RETRIES; attempt++) {
      const publicId = nanoid();
      const key = `videos/${publicId}/source${ext}`;
      const uploadId = await this.storageService.createMultipartUpload(
        key,
        dto.contentType,
      );

      try {
        const video = await this.videoRepository.save(
          this.videoRepository.create({
            public_id: publicId,
            channel_id: channel.id,
            title: dto.title,
            original_filename: dto.filename,
            content_type: dto.contentType,
            storage_key: key,
            multipart_upload_id: uploadId,
            size_bytes: String(dto.fileSize),
            status: VideoStatus.DRAFT,
          }),
        );

        const parts = await this.presignParts(key, uploadId, dto.fileSize);
        return {
          videoId: video.id,
          publicId,
          uploadId,
          key,
          partSize: UPLOAD_PART_SIZE_BYTES,
          parts,
        };
      } catch (err) {
        // Roll back the orphaned multipart before retrying or rethrowing.
        await this.storageService.abortMultipartUpload(key, uploadId);
        if (isPublicIdConflict(err) && attempt < MAX_PUBLIC_ID_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('Could not generate a unique public_id after retries');
  }

  private async presignParts(
    key: string,
    uploadId: string,
    fileSize: number,
  ): Promise<UploadPart[]> {
    const partCount = Math.max(1, Math.ceil(fileSize / UPLOAD_PART_SIZE_BYTES));
    return Promise.all(
      Array.from({ length: partCount }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageService.presignUploadPart(
            key,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.getOwnedVideo(userId, publicId);
    if (
      video.status !== VideoStatus.DRAFT ||
      video.multipart_upload_id !== dto.uploadId
    ) {
      throw new InvalidUploadStateException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      dto.uploadId,
      dto.parts,
    );

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    const jobData: ProcessVideoJobData = { videoId: video.id };
    await this.videoQueue.add(PROCESS_VIDEO_JOB, jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });

    return { publicId: video.public_id, status: video.status };
  }

  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.getOwnedVideo(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.multipart_upload_id) {
      throw new InvalidUploadStateException();
    }

    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.multipart_upload_id,
    );
    await this.videoRepository.remove(video);
  }

  async getByPublicId(
    publicId: string,
    requesterId?: string,
  ): Promise<VideoMetadataResult> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    // A non-`ready` video is only visible to its owner; to everyone else it is
    // indistinguishable from a missing one (per the Error Catalog).
    if (video.status !== VideoStatus.READY) {
      const isOwner =
        requesterId !== undefined && video.channel.user_id === requesterId;
      if (!isOwner) {
        throw new VideoNotFoundException();
      }
    }

    const thumbnailUrl =
      video.status === VideoStatus.READY && video.thumbnail_key
        ? await this.storageService.presignGet(video.thumbnail_key)
        : null;

    return {
      publicId: video.public_id,
      title: video.title,
      description: video.description,
      status: video.status,
      durationSeconds: video.duration_seconds,
      thumbnailUrl,
      channel: { nickname: video.channel.nickname, name: video.channel.name },
      createdAt: video.created_at.toISOString(),
    };
  }

  async getStreamUrl(publicId: string): Promise<PlaybackUrlResult> {
    const video = await this.getReadyVideo(publicId);
    const url = await this.storageService.presignGet(video.storage_key, {
      expiresIn: PLAYBACK_URL_TTL_SECONDS,
    });
    return { url, expiresIn: PLAYBACK_URL_TTL_SECONDS };
  }

  async getDownloadUrl(publicId: string): Promise<PlaybackUrlResult> {
    const video = await this.getReadyVideo(publicId);
    const url = await this.storageService.presignGet(video.storage_key, {
      expiresIn: PLAYBACK_URL_TTL_SECONDS,
      downloadFilename:
        video.original_filename ??
        `${video.public_id}${extname(video.storage_key)}`,
    });
    return { url, expiresIn: PLAYBACK_URL_TTL_SECONDS };
  }

  private async getReadyVideo(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || video.channel_id !== channel.id) {
      throw new NotVideoOwnerException();
    }
    return video;
  }
}
