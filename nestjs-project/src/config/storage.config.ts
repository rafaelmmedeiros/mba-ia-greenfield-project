import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY || 'streamtube',
  secretKey: process.env.S3_SECRET_KEY || 'streamtube',
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
  forcePathStyle: true,
}));
