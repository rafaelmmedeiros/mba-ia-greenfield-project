import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule, VIDEO_QUEUE } from './queue.module';

describe('QueueModule (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
    await queue.drain();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  it('should register the videos queue and enqueue a retrievable job', async () => {
    const job = await queue.add('process-video', { videoId: 'test-id' });

    const fetched = await queue.getJob(job.id as string);
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe('process-video');
    expect(fetched?.data).toEqual({ videoId: 'test-id' });
  });
});
