export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
export const UPLOAD_PART_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_PUBLIC_ID_RETRIES = 3;

// TTL of the short-lived presigned GET URLs handed out for stream/download.
export const PLAYBACK_URL_TTL_SECONDS = 3600; // 1 hour

export const PROCESS_VIDEO_JOB = 'process-video';

export interface ProcessVideoJobData {
  videoId: string;
}
