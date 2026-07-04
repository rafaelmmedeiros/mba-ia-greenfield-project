import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;

  const uniqueKey = (prefix: string): string =>
    `test/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
    await service.ensureBucket();
  });

  it('should ensure the bucket exists (idempotent)', async () => {
    await expect(service.ensureBucket()).resolves.not.toThrow();
  });

  it('should round-trip a multipart upload and serve it via presigned GET', async () => {
    const key = uniqueKey('multipart');
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    const partUrl = await service.presignUploadPart(key, uploadId, 1);
    const body = Buffer.from('hello multipart world');
    const putRes = await fetch(partUrl, { method: 'PUT', body });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    const getUrl = await service.presignGet(key);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe('hello multipart world');
  });

  it('should honor the attachment disposition on a presigned download URL', async () => {
    const url = await service.presignGet('some/key.mp4', {
      downloadFilename: 'video.mp4',
    });
    expect(url).toContain('response-content-disposition');
  });

  it('should abort a multipart upload without throwing', async () => {
    const key = uniqueKey('abort');
    const uploadId = await service.createMultipartUpload(key);
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.not.toThrow();
  });
});
