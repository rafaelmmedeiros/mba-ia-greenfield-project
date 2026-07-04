import {
  DomainException,
  InvalidFileSizeException,
  InvalidUploadStateException,
  NotVideoOwnerException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './domain.exception';

// Consolidation check: every video DomainException must carry the errorCode and
// HTTP status documented in phase-03-videos/### Error Catalog. The global
// DomainExceptionFilter emits these verbatim, so drift here is a contract break.
describe('Video domain exceptions — Error Catalog coherence', () => {
  const cases: ReadonlyArray<{
    exception: DomainException;
    errorCode: string;
    httpStatus: number;
  }> = [
    {
      exception: new InvalidFileSizeException(),
      errorCode: 'INVALID_FILE_SIZE',
      httpStatus: 400,
    },
    {
      exception: new VideoNotFoundException(),
      errorCode: 'VIDEO_NOT_FOUND',
      httpStatus: 404,
    },
    {
      exception: new NotVideoOwnerException(),
      errorCode: 'NOT_VIDEO_OWNER',
      httpStatus: 403,
    },
    {
      exception: new InvalidUploadStateException(),
      errorCode: 'INVALID_UPLOAD_STATE',
      httpStatus: 409,
    },
    {
      exception: new VideoNotReadyException(),
      errorCode: 'VIDEO_NOT_READY',
      httpStatus: 409,
    },
  ];

  it.each(cases)(
    'maps $errorCode to HTTP $httpStatus',
    ({ exception, errorCode, httpStatus }) => {
      expect(exception).toBeInstanceOf(DomainException);
      expect(exception.errorCode).toBe(errorCode);
      expect(exception.httpStatus).toBe(httpStatus);
      expect(exception.message).toBeTruthy();
    },
  );
});
