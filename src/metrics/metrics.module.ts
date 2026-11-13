import { Module } from '@nestjs/common';
import { ClosureMetrics } from './closure-metrics';
import { MetricsService } from './metrics.service';

@Module({
  providers: [MetricsService, ClosureMetrics],
  exports: [MetricsService, ClosureMetrics],
})
export class MetricsModule {}
