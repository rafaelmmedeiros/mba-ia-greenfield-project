import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  /** 1-based part number, as returned by the upload-init endpoint. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by the storage service for the uploaded part. */
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  /** The multipart UploadId returned by the upload-init endpoint. */
  @IsString()
  @MinLength(1)
  uploadId: string;

  /** One entry per uploaded part, with its part number and ETag. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
