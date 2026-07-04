import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { VIDEO_QUEUE } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { ProcessVideoJobData } from './videos.constants';

const THUMBNAIL_AT_SECONDS = 1;

@Processor(VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly processingService: VideoProcessingService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneByOrFail({
      id: job.data.videoId,
    });

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    const sourceUrl = await this.storageService.presignGet(video.storage_key);
    const probe = await this.processingService.probe(sourceUrl);

    const thumbnailKey = `videos/${video.public_id}/thumbnail.jpg`;
    const tmpPath = join(tmpdir(), `${video.public_id}-thumb.jpg`);
    const atSeconds = Math.min(
      THUMBNAIL_AT_SECONDS,
      Math.max(0, probe.durationSeconds - 1),
    );
    try {
      await this.processingService.extractThumbnail(
        sourceUrl,
        atSeconds,
        tmpPath,
      );
      const thumbnail = await readFile(tmpPath);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnail,
        'image/jpeg',
      );
    } finally {
      await rm(tmpPath, { force: true });
    }

    video.duration_seconds = probe.durationSeconds;
    video.metadata = { ...probe.metadata };
    video.thumbnail_key = thumbnailKey;
    video.status = VideoStatus.READY;
    await this.videoRepository.save(video);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, err: Error): Promise<void> {
    // BullMQ emits 'failed' on every attempt; only persist the terminal failure
    // once all retries are exhausted (per phase-03-videos/TD-08).
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }
    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: VideoStatus.FAILED, failure_reason: err.message.slice(0, 500) },
    );
  }
}
