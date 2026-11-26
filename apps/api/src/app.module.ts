import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AudienceController } from './audience/audience.controller.js';
import { AudienceService } from './audience/audience.service.js';
import { QuotasController } from './audience/quotas.controller.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { ProblemFilter } from './common/problem.filter.js';
import { ENV, type Env } from './config.js';
import { DbModule } from './db/db.module.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { SourcePoller } from './ingestion/poller.js';
import { ProjectsController } from './ingestion/projects.controller.js';
import { RedirectController } from './ingestion/redirect.controller.js';
import { SourcesController } from './ingestion/sources.controller.js';
import { WebhookController } from './ingestion/webhook.controller.js';
import { ExecutionController } from './execution/execution.controller.js';
import { ExecutionService } from './execution/execution.service.js';
import { RouterController } from './execution/router.controller.js';
import { DispatchScheduler } from './execution/scheduler.js';
import { FieldworkController } from './fieldwork/fieldwork.controller.js';
import { FieldworkService } from './fieldwork/fieldwork.service.js';
import { RecontactService } from './fieldwork/recontact.service.js';
import { S2sController } from './fieldwork/s2s.controller.js';
import { HealthController } from './health/health.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { OpenApiController } from './openapi.js';
import { MetricsController } from './metrics.js';
import { SettingsController } from './settings/settings.controller.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';

import { SampIntelController, SampIntelService } from './sampintel/sampintel.js';
import { IntelligenceController } from './intelligence/intelligence.controller.js';
import { IntelligenceService } from './intelligence/intelligence.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { CopilotController } from './copilot/copilot.controller.js';
import { CopilotService } from './copilot/copilot.service.js';
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : env.API_RATE_LIMIT },
        ]),
        { module: DbModule, providers: [{ provide: ENV, useValue: env }], exports: [ENV] },
      ],
      providers: [
        SampIntelService,
        IntelligenceService,
        ReportsService,
        CopilotService,
        { provide: ENV, useValue: env },
        AuditService,
        AuthService,
        UsersService,
        IngestionService,
        AudienceService,
        SourcePoller,
        ExecutionService,
        DispatchScheduler,
        FieldworkService,
        RecontactService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [ENV],
      controllers: [
        SampIntelController,
        IntelligenceController,
        ReportsController,
        CopilotController,
        HealthController,
        MetricsController,
        OpenApiController,
        AuthController,
        UsersController,
        AuditController,
        SettingsController,
        NotificationsController,
        SourcesController,
        WebhookController,
        ProjectsController,
        RedirectController,
        AudienceController,
        QuotasController,
        ExecutionController,
        RouterController,
        FieldworkController,
        S2sController,
      ],
    };
  }
}
