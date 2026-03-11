import { Controller, Get } from '@nestjs/common';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('source-health')
  async getSourceHealth() {
    return this.settingsService.getSourceHealth();
  }

  @Get('profile')
  async getProfile() {
    return this.settingsService.getProfile();
  }
}
