import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';

export interface VideoMetadata {
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  formatName: string | null;
  sizeBytes: number | null;
}

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; size?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
}

/**
 * Thin wrapper over the system `ffprobe` / `ffmpeg` binaries (per
 * phase-03-videos/TD-05 — invoked via `child_process`, no wrapper library).
 */
@Injectable()
export class VideoProcessingService {
  async probe(input: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ]);
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
    return {
      durationSeconds: Math.round(Number(parsed.format?.duration ?? 0)),
      metadata: {
        width: videoStream?.width ?? null,
        height: videoStream?.height ?? null,
        videoCodec: videoStream?.codec_name ?? null,
        formatName: parsed.format?.format_name ?? null,
        sizeBytes: parsed.format?.size ? Number(parsed.format.size) : null,
      },
    };
  }

  async extractThumbnail(
    input: string,
    atSeconds: number,
    outputPath: string,
  ): Promise<void> {
    await this.run('ffmpeg', [
      '-y',
      '-ss',
      String(atSeconds),
      '-i',
      input,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPath,
    ]);
  }

  private run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(`${command} exited with code ${code}: ${stderr.trim()}`),
          );
        }
      });
    });
  }
}
