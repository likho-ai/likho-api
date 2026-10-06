/** The workspace's settings over REST: what a connector reads with its API key. */
import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { SettingsService } from './settings.service.js';

@ApiTags('settings')
@ApiBearerAuth()
@Controller('api/v1/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Every setting of the workspace',
    description:
      'The defaults filled in. The dialer connector reads its schedule, campaigns, budget and write-back here, and again whenever likho.settings.changed says they changed.',
  })
  read(@CurrentUser() me: Principal) {
    return this.settings.read(me.workspaceId);
  }
}
