import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// Standalone Nest application context (no HTTP server) that boots the BullMQ
// VideoProcessor (per phase-03-videos/TD-04). The processor starts consuming the
// `videos` queue on init; the Redis connection keeps the process alive.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap();
