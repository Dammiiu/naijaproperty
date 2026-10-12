import { Injectable, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service.js';
import { PiiService } from '../../common/pii.service.js';
import { PasswordService, OtpService } from '../../common/crypto.service.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { GoogleAuthService } from './google-auth.service.js';
import { JwtAuthGuard, RolesGuard } from './jwt-auth.guard.js';

@Module({
  imports: [
    JwtModule.register({
      // Signing secret is supplied per-call in AuthService so rotation does not
      // require rebuilding the module graph.
      signOptions: { issuer: 'naijaproperty-api' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    PrismaService,
    PiiService,
    PasswordService,
    OtpService,
    AuthService,
    GoogleAuthService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [AuthService, PrismaService, PiiService, JwtAuthGuard, OtpService],
})
export class AuthModule {}
