import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('/health')
  health(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }
}
