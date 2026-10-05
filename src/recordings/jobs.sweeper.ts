/**
 * Looks at the jobs now and then: one still queued after JOB_QUEUED_MAX_MINUTES is asked for
 * again (once), one running with no line for JOB_STALL_MAX_MINUTES is failed and tried once
 * more. Runs with the consumers, so an instance that only serves the API does not sweep.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { RecordingsService } from './recordings.service.js';

@Injectable()
export class JobsSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('jobs');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly recordings: RecordingsService,
  ) {}

  onModuleInit(): void {
    if (!this.config.CONSUMERS_ENABLED || this.config.JOB_SWEEP_SECONDS === 0) return;
    this.timer = setInterval(() => void this.tick(), this.config.JOB_SWEEP_SECONDS * 1000);
    this.timer.unref();
    this.log.log(
      `sweeping jobs every ${this.config.JOB_SWEEP_SECONDS} s: queued > ${this.config.JOB_QUEUED_MAX_MINUTES} min or quiet > ${this.config.JOB_STALL_MAX_MINUTES} min, ${this.config.JOB_MAX_ATTEMPTS} tries`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const done = await this.recordings.sweepJobs();
      if (done.requeued || done.failed)
        this.log.warn(`sweep: ${done.requeued} job(s) asked for again, ${done.failed} failed`);
    } catch (error) {
      this.log.error(`sweep failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
