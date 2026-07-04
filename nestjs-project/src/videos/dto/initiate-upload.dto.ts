import { IsInt, IsString, MaxLength, MinLength } from 'class-validator';

export class InitiateUploadDto {
  /** Video title. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  /** Original file name — used later for the download filename. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /** Source MIME type, e.g. `video/mp4`. */
  @IsString()
  @MinLength(1)
  contentType: string;

  /** Total file size in bytes (1..10 GiB). */
  @IsInt()
  fileSize: number;
}
