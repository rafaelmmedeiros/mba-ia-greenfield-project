import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ChannelsModule } from '../channels/channels.module';
import authConfig from '../config/auth.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Verify-only JWT for the OptionalJwtAuthGuard on public reads. Registered
    // here (instead of importing AuthModule) so VideosModule does not pull in
    // AuthModule's heavier graph (Mail/Users/Throttler/APP_GUARD); it only needs
    // the shared secret to validate an optional bearer token.
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (cfg: ConfigType<typeof authConfig>) => ({
        secret: cfg.jwtSecret,
      }),
    }),
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, OptionalJwtAuthGuard],
  exports: [VideosService],
})
export class VideosModule {}
