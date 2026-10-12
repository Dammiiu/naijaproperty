import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaController } from './media.controller.js';
import { StreamWebhookController } from './stream-webhook.controller.js';
import { MediaService } from './media.service.js';
import { MediaProcessingService } from './media-processing.service.js';

@Module({
  imports: [AuthModule],
  controllers: [MediaController, StreamWebhookController],
  providers: [MediaService, MediaProcessingService],
  exports: [MediaService, MediaProcessingService],
})
export class MediaModule {}
