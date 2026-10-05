/**
 * Live updates as server-sent events. The gateway keeps /events/ connections open and unbuffered.
 *
 *   GET /events/jobs/:id         the lines of one job as they are transcribed, then its end
 *   GET /events/recordings       every change to the workspace's recordings and jobs
 *   GET /events/recordings/:id   every change to one recording: its jobs, its status, its insights
 */
import { Controller, Param, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { RecordingsService } from '../recordings/recordings.service.js';
import { LiveService, LiveUpdate } from './live.service.js';

interface Sent {
  type: string;
  data: Record<string, unknown>;
}

const sent = (update: LiveUpdate): Sent => ({
  type: update.kind,
  data: { jobId: update.jobId, recordingId: update.recordingId, ...update.data },
});

@Controller('events')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly recordings: RecordingsService,
  ) {}

  @Sse('jobs/:id')
  async job(@CurrentUser() me: Principal, @Param('id') id: string): Promise<Observable<Sent>> {
    const job = await this.recordings.getJob(me.workspaceId, id);

    // Listen first, then read what was transcribed before the page opened: a line that arrives
    // in between is kept, and a line found in both places is sent once.
    const buffered: LiveUpdate[] = [];
    let deliver: (update: LiveUpdate) => void = (update) => buffered.push(update);
    const subscription = this.live
      .watch(
        (update) =>
          update.jobId === id ||
          ((update.kind === 'recording' || update.kind === 'insights') &&
            update.recordingId === job.recordingId),
      )
      .subscribe((update) => deliver(update));
    const earlier = await this.live.tail(id);

    return new Observable<Sent>((observer) => {
      const sentLines = new Set<number>();
      const emit = (update: LiveUpdate) => {
        if (update.kind === 'segment') {
          const index = Number(update.data.index);
          if (sentLines.has(index)) return;
          sentLines.add(index);
        }
        observer.next(sent(update));
      };
      observer.next({ type: 'job', data: { jobId: id, recordingId: job.recordingId, status: job.status } });
      earlier.forEach(emit);
      buffered.forEach(emit);
      deliver = emit;
      return () => subscription.unsubscribe();
    });
  }

  @Sse('recordings/:id')
  async recording(@CurrentUser() me: Principal, @Param('id') id: string): Promise<Observable<Sent>> {
    await this.recordings.get(me.workspaceId, id); // not found when it is another workspace's
    return new Observable<Sent>((observer) => {
      const subscription = this.live
        .watch((update) => update.recordingId === id && update.kind !== 'segment')
        .subscribe((update) => observer.next(sent(update)));
      return () => subscription.unsubscribe();
    });
  }

  @Sse('recordings')
  async workspace(@CurrentUser() me: Principal): Promise<Observable<Sent>> {
    const ids = new Set<string>();
    // A recording is the workspace's when it is in the table; a quick membership test per update.
    const belongs = async (recordingId: string): Promise<boolean> => {
      if (ids.has(recordingId)) return true;
      try {
        await this.recordings.get(me.workspaceId, recordingId);
        ids.add(recordingId);
        return true;
      } catch {
        return false;
      }
    };
    return new Observable<Sent>((observer) => {
      const subscription = this.live
        .watch(() => true)
        .subscribe((update) => {
          if (update.kind === 'import') {
            if (update.workspaceId === me.workspaceId) observer.next(sent(update));
            return;
          }
          void belongs(update.recordingId).then((ok) => ok && observer.next(sent(update)));
        });
      return () => subscription.unsubscribe();
    });
  }
}
