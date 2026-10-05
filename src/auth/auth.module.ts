import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthGuard } from './auth.guard.js';
import { AuthResolver } from './auth.resolver.js';
import { AuthService } from './auth.service.js';

/** Who people are and what they may do; the audit log and mail live here too, as every module needs them. */
@Global()
@Module({
  providers: [
    AuthService,
    UsersService,
    MailService,
    AuditService,
    AuthResolver,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, UsersService, MailService, AuditService],
})
export class AuthModule {}
