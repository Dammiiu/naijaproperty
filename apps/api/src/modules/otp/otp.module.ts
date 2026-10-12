import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OtpController } from './otp.controller.js';
import { OtpOrchestrator } from './otp-orchestrator.service.js';
import { TermiiService } from './termii.service.js';

@Module({
  imports: [AuthModule],
  controllers: [OtpController],
  providers: [OtpOrchestrator, TermiiService],
  exports: [OtpOrchestrator, TermiiService],
})
export class OtpModule {}
