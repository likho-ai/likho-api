/**
 * The whole service: GraphQL for browsers, REST for scripts, events from the other services,
 * live updates. Runs against the local stack; see harness.ts.
 */
import { Browser, Harness, readEvents, requireStack, start, until } from './harness.js';

const RECORDING = `
  id originalName mediaId sizeBytes sha256 durationSeconds channels sampleRate source externalId
  status failureReason latestTranscriptId detectedLanguage languageProbability playbackUrl peaksUrl
  jobs { id status progressSeconds totalSeconds errorCode errorMessage transcriptId }
`;
const REQUEST_UPLOAD = `mutation ($input: RequestUploadInput!) {
  requestUpload(input: $input) { uploadUrl expiresAt recording { ${RECORDING} } duplicateOf { id } }
}`;
const GET_RECORDING = `query ($id: String!) { recording(id: $id) { ${RECORDING} latestTranscript { id version segments { index textScript textRoman } language { detected probability } } } }`;

const stackUp = await requireStack();

describe.skipIf(!stackUp)('likho-api', () => {
  let h: Harness;
  let admin: Browser;

  beforeAll(async () => {
    h = await start();
    admin = new Browser(h.url);
    await admin.login('admin@example.test', 'admin-password-1');
  });
  afterAll(async () => {
    await h?.stop();
  });

  /** An upload that likho-media has accepted and found to be audio, once it reached `expected`. */
  async function readyRecording(
    browser: Browser,
    name = 'call.mp3',
    expected: 'queued' | 'ready' = 'queued',
    extra: Record<string, unknown> = {},
  ) {
    const { requestUpload } = await browser.ok(REQUEST_UPLOAD, {
      input: { originalName: name, sizeBytes: 1234, ...extra },
    });
    const recording = requestUpload.recording;
    await h.publish('likho.media.ready', 'likho.media.ready.v1', {
      recording_id: recording.id,
      media_id: recording.mediaId,
      workspace_id: h.media.uploads.at(-1)!.workspaceId,
      duration_seconds: 61.5,
      channels: 1,
      sample_rate: 8000,
    });
    return until(async () => {
      const { recording: r } = await browser.ok(GET_RECORDING, { id: recording.id });
      return r.status === expected ? r : null;
    }, `recording ${recording.id} to become ${expected}`);
  }

  describe('signing in', () => {
    it('the first admin comes from the environment and can sign in', async () => {
      const me = await new Browser(h.url).login('admin@example.test', 'admin-password-1');
      expect(me.login).toMatchObject({
        email: 'admin@example.test',
        name: 'Admin',
        role: 'admin',
        workspace: { name: 'Test workspace' },
      });
      expect(me.login.id).toMatch(/^usr_/);
      expect(me.login.workspace.id).toMatch(/^wsp_/);
    });

    it('a wrong password and an unknown email get the same answer', async () => {
      const browser = new Browser(h.url);
      const mutation = `mutation { login(email: "admin@example.test", password: "nope-nope-nope") { id } }`;
      const unknown = `mutation { login(email: "nobody@example.test", password: "admin-password-1") { id } }`;
      const first = await browser.graphql(mutation);
      const second = await browser.graphql(unknown);
      expect(first.errors![0]).toEqual(second.errors![0]);
      expect(first.errors![0]!.extensions!.code).toBe('unauthenticated');
      expect(browser.cookie).toBe('');
    });

    it('without a session nothing but login and health is open', async () => {
      const browser = new Browser(h.url);
      expect(await browser.fails(`{ me { email } }`)).toBe('unauthenticated');
      expect(await browser.fails(`{ recordings { items { id } } }`)).toBe('unauthenticated');
      expect((await fetch(`${h.url}/healthz`)).status).toBe(200);
      expect(await (await fetch(`${h.url}/readyz`)).text()).toBe('ready\n');
      const rest = await fetch(`${h.url}/api/v1/recordings`);
      expect(rest.status).toBe(401);
      expect(await rest.json()).toEqual({ error: { code: 'unauthenticated', message: 'Sign in first.' } });
    });

    it('logging out ends the session', async () => {
      const browser = new Browser(h.url);
      await browser.login('admin@example.test', 'admin-password-1');
      expect((await browser.ok(`{ me { email } }`)).me.email).toBe('admin@example.test');
      const cookie = browser.cookie;
      await browser.ok(`mutation { logout }`);
      browser.cookie = cookie; // a stolen cookie is no good after logout
      expect(await browser.fails(`{ me { email } }`)).toBe('unauthenticated');
    });
  });

  describe('a recording from upload to transcript', () => {
    it('requestUpload makes the recording and hands over the media link', async () => {
      const { requestUpload } = await admin.ok(REQUEST_UPLOAD, {
        input: {
          originalName: 'Call 1.mp3',
          sizeBytes: 105000,
          contentType: 'audio/mpeg',
          externalId: 'crt-1',
        },
      });
      expect(requestUpload.uploadUrl).toMatch(/^http:\/\/media\.test\/media\/uploads\/med_/);
      expect(requestUpload.duplicateOf).toBeNull();
      expect(requestUpload.recording).toMatchObject({
        originalName: 'Call 1.mp3',
        sizeBytes: 105000,
        status: 'uploading',
        source: 'upload',
        externalId: 'crt-1',
        playbackUrl: null,
        jobs: [],
      });
      const asked = h.media.uploads.at(-1)!;
      expect(asked).toMatchObject({ recordingId: requestUpload.recording.id, originalName: 'Call 1.mp3' });
      expect(asked.workspaceId).toMatch(/^wsp_/);
      expect(requestUpload.recording.mediaId).toBe(asked.mediaId);
    });

    it('media.ready makes it ready and queues a job; segments and completion finish it', async () => {
      const recording = await readyRecording(admin, 'call 2.mp3');
      expect(recording).toMatchObject({
        status: 'queued',
        durationSeconds: 61.5,
        channels: 1,
        sampleRate: 8000,
      });
      expect(recording.playbackUrl).toContain('/audio');
      expect(recording.peaksUrl).toContain('/peaks');
      expect(recording.jobs).toHaveLength(1);
      const job = recording.jobs[0];
      expect(job).toMatchObject({ status: 'queued', totalSeconds: 61.5 });

      // The job was asked for on the bus, in the shape of the contract.
      const requested = await until(
        async () => h.published('likho.transcription.requested').find((e) => e.data.job_id === job.id),
        'the transcription request',
      );
      expect(requested).toMatchObject({
        source: 'likho-api',
        type: 'likho.transcription.requested.v1',
        subject: recording.id,
        data: {
          recording_id: recording.id,
          media_id: recording.mediaId,
          language_policy: 'auto',
          force: false,
        },
      });

      // A browser is watching the job while the worker sends lines.
      // Lines and the end travel through different consumers, so the end may be relayed before
      // the last line; a page fetches the stored transcript once it sees 'done' anyway.
      const watching = readEvents(
        h.url,
        `/events/jobs/${job.id}`,
        admin.cookie,
        (events) =>
          events.filter((e) => e.type === 'segment').length >= 2 &&
          events.some((e) => e.type === 'job' && e.data.status === 'done'),
      );
      for (const [index, text] of [
        ['नमस्ते', 'namaste'],
        ['धन्यवाद', 'dhanyavaad'],
      ].entries()) {
        await h.publish('likho.live.segment', 'likho.transcription.segment.v1', {
          job_id: job.id,
          recording_id: recording.id,
          total_seconds: 61.5,
          segment: {
            index,
            start_seconds: index * 2,
            end_seconds: index * 2 + 1.5,
            text_script: text[0],
            text_roman: text[1],
          },
        });
      }
      const transcript = h.transcription.add('trn_01JB7Z5K3M9Q2W4X6Y8A0C1E3G', recording.id, job.id);
      await h.publish('likho.transcription.completed', 'likho.transcription.completed.v1', {
        job_id: job.id,
        recording_id: recording.id,
        transcript_id: transcript.id,
        workspace_id: h.media.uploads.at(-1)!.workspaceId,
        version: 1,
        language: { detected: 'hi', probability: 0.9, candidates: [], decoded_as: 'hi', policy: 'auto' },
        stats: {
          audio_seconds: 61.5,
          elapsed_seconds: 40,
          segments: 2,
          chunks: 6,
          silence_skipped_seconds: 3,
        },
      });

      const events = await watching;
      expect(events[0]).toEqual({
        type: 'job',
        data: { jobId: job.id, recordingId: recording.id, status: 'queued' },
      });
      const lines = events.filter((e) => e.type === 'segment').map((e) => e.data.textRoman);
      expect(lines).toEqual(['namaste', 'dhanyavaad']);
      expect(events.find((e) => e.type === 'job' && e.data.status === 'done')!.data).toMatchObject({
        transcriptId: transcript.id,
      });

      const { recording: done } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(done).toMatchObject({
        status: 'done',
        latestTranscriptId: transcript.id,
        detectedLanguage: 'hi',
        languageProbability: 0.9,
        jobs: [{ status: 'done', transcriptId: transcript.id, progressSeconds: 61.5 }],
      });
      expect(done.latestTranscript.segments.map((s: any) => s.textRoman)).toEqual(['namaste', 'dhanyavaad']);

      // The lines are still there for a page that opens after the job.
      const later = await readEvents(h.url, `/events/jobs/${job.id}`, admin.cookie, (e) => e.length >= 3);
      expect(later.filter((e) => e.type === 'segment')).toHaveLength(2);
    });

    it('a failed job puts the recording back where it was', async () => {
      const recording = await readyRecording(admin, 'call 3.mp3');
      const job = recording.jobs[0];
      await h.publish('likho.transcription.failed', 'likho.transcription.failed.v1', {
        job_id: job.id,
        recording_id: recording.id,
        workspace_id: h.media.uploads.at(-1)!.workspaceId,
        code: 'audio_unreadable',
        message: 'The audio file could not be read',
        attempt: 1,
      });
      const after = await until(async () => {
        const { job: j } = await admin.ok(
          `query ($id: String!) { job(id: $id) { status errorCode errorMessage recordingId } }`,
          { id: job.id },
        );
        return j.status === 'failed' ? j : null;
      }, 'the job to fail');
      expect(after).toMatchObject({
        errorCode: 'audio_unreadable',
        errorMessage: 'The audio file could not be read',
      });
      const { recording: r } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(r.status).toBe('ready');
    });

    it('a file that is not audio fails with the reason', async () => {
      const { requestUpload } = await admin.ok(REQUEST_UPLOAD, {
        input: { originalName: 'notes.txt', sizeBytes: 10 },
      });
      const recording = requestUpload.recording;
      await h.publish('likho.media.failed', 'likho.media.failed.v1', {
        recording_id: recording.id,
        media_id: recording.mediaId,
        workspace_id: h.media.uploads.at(-1)!.workspaceId,
        code: 'audio_unreadable',
        message: 'The file is not audio that can be read',
      });
      const failed = await until(async () => {
        const { recording: r } = await admin.ok(GET_RECORDING, { id: recording.id });
        return r.status === 'failed' ? r : null;
      }, 'the recording to fail');
      expect(failed.failureReason).toBe('The file is not audio that can be read');
      expect(failed.jobs).toHaveLength(0);
      expect(
        await admin.fails(`mutation ($id: String!) { createJob(input: { recordingId: $id }) { id } }`, {
          id: recording.id,
        }),
      ).toBe('invalid');
    });

    it('the same content again points at the recording that has it', async () => {
      const sha = 'a'.repeat(64);
      const first = await admin.ok(REQUEST_UPLOAD, {
        input: { originalName: 'same.mp3', sizeBytes: 5, sha256: sha },
      });
      h.media.known.set(sha, first.requestUpload.recording.mediaId);
      const again = await admin.ok(REQUEST_UPLOAD, {
        input: { originalName: 'same copy.mp3', sizeBytes: 5, sha256: sha },
      });
      expect(again.requestUpload.uploadUrl).toBe('');
      expect(again.requestUpload.duplicateOf.id).toBe(first.requestUpload.recording.id);
      expect(again.requestUpload.recording.id).toBe(first.requestUpload.recording.id);
    });

    it('jobs can be started by hand and cancelled', async () => {
      await admin.ok(`mutation { updateSettings(autoTranscribe: false) { autoTranscribe } }`);
      try {
        const recording = await readyRecording(admin, 'manual.mp3', 'ready');
        expect(recording.status).toBe('ready');
        expect(recording.jobs).toHaveLength(0);

        const { createJob } = await admin.ok(
          `mutation ($id: String!) { createJob(input: { recordingId: $id, languagePolicy: "hi", force: true }) { id status languagePolicy force } }`,
          { id: recording.id },
        );
        expect(createJob).toMatchObject({ status: 'queued', languagePolicy: 'hi', force: true });
        expect(
          await admin.fails(`mutation ($id: String!) { createJob(input: { recordingId: $id }) { id } }`, {
            id: recording.id,
          }),
        ).toBe('invalid');

        const { cancelJob } = await admin.ok(`mutation ($id: String!) { cancelJob(id: $id) { status } }`, {
          id: createJob.id,
        });
        expect(cancelJob.status).toBe('cancelled');
        expect(h.transcription.cancelled).toContain(createJob.id);
        const { recording: r } = await admin.ok(GET_RECORDING, { id: recording.id });
        expect(r.status).toBe('ready');
      } finally {
        await admin.ok(`mutation { updateSettings(autoTranscribe: true) { autoTranscribe } }`);
      }
    });

    it('lists, counts and searches', async () => {
      const { recordings } = await admin.ok(
        `query { recordings(first: 2) { items { id originalName } hasMore endCursor } }`,
      );
      expect(recordings.items).toHaveLength(2);
      expect(recordings.hasMore).toBe(true);
      const next = await admin.ok(
        `query ($after: String!) { recordings(first: 2, after: $after) { items { id } } }`,
        { after: recordings.endCursor },
      );
      expect(next.recordings.items[0].id).not.toBe(recordings.items[0].id);

      const found = await admin.ok(
        `query { recordings(filter: { search: "crt-1" }) { items { originalName externalId } } }`,
      );
      expect(found.recordings.items).toEqual([{ originalName: 'Call 1.mp3', externalId: 'crt-1' }]);
      const failed = await admin.ok(
        `query { recordings(filter: { status: [failed] }) { items { originalName } } }`,
      );
      expect(failed.recordings.items).toEqual([{ originalName: 'notes.txt' }]);

      const { recordingCounts } = await admin.ok(`query { recordingCounts { uploading ready failed done } }`);
      expect(recordingCounts.failed).toBe(1);
      expect(recordingCounts.done).toBe(1);
    });

    it('transcript versions and re-transliteration', async () => {
      const { recordings } = await admin.ok(
        `query { recordings(filter: { status: [done] }) { items { id latestTranscriptId } } }`,
      );
      const [done] = recordings.items;
      const { transcriptVersions } = await admin.ok(
        `query ($id: String!) { transcriptVersions(recordingId: $id) { id version } }`,
        { id: done.id },
      );
      expect(transcriptVersions).toEqual([{ id: done.latestTranscriptId, version: 1 }]);

      const { retransliterate } = await admin.ok(
        `mutation ($id: String!) { retransliterate(transcriptId: $id) { id version } }`,
        { id: done.latestTranscriptId },
      );
      expect(retransliterate.version).toBe(2);
      const { recording } = await admin.ok(GET_RECORDING, { id: done.id });
      expect(recording.latestTranscriptId).toBe(retransliterate.id);
      const { engines } = await admin.ok(`{ engines { registryId isDefault } }`);
      expect(engines.find((e: any) => e.isDefault).registryId).toBe('faster-whisper/turbo');
    });

    it('a corrected line makes the next version and is listed', async () => {
      const { recordings } = await admin.ok(
        `query { recordings(filter: { status: [done] }) { items { id latestTranscriptId } } }`,
      );
      const [done] = recordings.items;
      const { correctSegment } = await admin.ok(
        `mutation ($input: CorrectSegmentInput!) { correctSegment(input: $input) { id version segments { index textRoman textScript } } }`,
        {
          input: { transcriptId: done.latestTranscriptId, segmentIndex: 1, layer: 'roman', text: 'shukriya' },
        },
      );
      expect(correctSegment.segments[1]).toMatchObject({ textRoman: 'shukriya', textScript: 'धन्यवाद' });
      const { recording } = await admin.ok(GET_RECORDING, { id: done.id });
      expect(recording.latestTranscriptId).toBe(correctSegment.id);
      const { corrections } = await admin.ok(
        `query ($id: String!) { corrections(recordingId: $id) { segmentIndex layer before after userId correctedTranscriptId } }`,
        { id: done.id },
      );
      expect(corrections[0]).toMatchObject({
        segmentIndex: 1,
        layer: 'roman',
        before: 'dhanyavaad',
        after: 'shukriya',
        correctedTranscriptId: correctSegment.id,
      });
      expect(corrections[0].userId).toMatch(/^usr_/);
      expect(
        await admin.fails(
          `mutation ($input: CorrectSegmentInput!) { correctSegment(input: $input) { id } }`,
          {
            input: { transcriptId: correctSegment.id, segmentIndex: 0, layer: 'roman', text: '   ' },
          },
        ),
      ).toBe('invalid');
    });

    it('deleting removes the audio too, and tells the others', async () => {
      const recording = await readyRecording(admin, 'gone.mp3');
      await admin.ok(`mutation ($id: String!) { deleteRecording(id: $id) }`, { id: recording.id });
      expect(h.media.deleted).toContain(recording.mediaId);
      expect(await admin.fails(GET_RECORDING, { id: recording.id })).toBe('not_found');
      const told = await until(
        async () => h.published('likho.recording.deleted').find((e) => e.data.recording_id === recording.id),
        'the deleted event',
      );
      expect(told).toMatchObject({
        type: 'likho.recording.deleted.v1',
        data: { recording_id: recording.id, media_id: recording.mediaId },
      });
    });

    it('search asks likho-search and decorates each line with its recording', async () => {
      const recording = await readyRecording(admin, 'searchable.mp3');
      h.search.hits = [
        {
          recordingId: recording.id,
          transcriptId: 'trn_1',
          segmentIndex: 3,
          startSeconds: 12.5,
          endSeconds: 15,
          textRoman: 'order confirm hai',
          textScript: 'ऑर्डर कन्फर्म है',
          highlightRoman: '<mark>order</mark> confirm hai',
          highlightScript: '<mark>ऑर्डर</mark> कन्फर्म है',
          language: 'hi',
        },
        { recordingId: 'rec_01NOTHERE000000000000000000', transcriptId: 'trn_x', segmentIndex: 0 },
      ];
      const { search } = await admin.ok(
        `query ($q: String!) { search(query: $q, filter: { language: "hi" }, pageSize: 10) {
          total page pageSize hits { recording { id originalName } transcriptId segmentIndex startSeconds highlightRoman highlightScript }
        } }`,
        { q: 'order' },
      );
      expect(search.total).toBe(2);
      // The line of a recording that is not here (deleted, or another workspace's) is left out.
      expect(search.hits).toHaveLength(1);
      expect(search.hits[0]).toMatchObject({
        recording: { id: recording.id, originalName: 'searchable.mp3' },
        transcriptId: 'trn_1',
        segmentIndex: 3,
        startSeconds: 12.5,
        highlightRoman: '<mark>order</mark> confirm hai',
      });
      expect(h.search.asked.at(-1)).toMatchObject({ query: 'order', language: 'hi', pageSize: 10 });
      expect(h.search.asked.at(-1)!.workspaceId).toBe(h.media.uploads.at(-1)!.workspaceId);
      expect(await admin.fails(`query { search(query: "   ") { total } }`)).toBe('invalid');
    });
  });

  describe('calls fetched from the dialer', () => {
    it('an import is asked for on the bus and finished by the connector’s answer', async () => {
      const { requestImport } = await admin.ok(
        `mutation { requestImport(input: { externalId: "d000-0a1b2c3d-vce-0001" }) { id source externalId status transcribe } }`,
      );
      expect(requestImport).toMatchObject({
        source: 'ameyo',
        externalId: 'd000-0a1b2c3d-vce-0001',
        status: 'requested',
        transcribe: true,
      });
      const asked = await until(
        async () =>
          h.published('likho.import.requested').find((e) => e.data.request_id === requestImport.id)!,
        'the import request',
      );
      expect(asked).toMatchObject({
        type: 'likho.import.requested.v1',
        data: { source: 'ameyo', external_id: 'd000-0a1b2c3d-vce-0001', transcribe: true },
      });
      expect(asked.data.workspace_id).toBe(h.media.uploads.at(-1)!.workspaceId);

      // Asking again while it is pending does not ask twice.
      const { requestImport: again } = await admin.ok(
        `mutation { requestImport(input: { externalId: "d000-0a1b2c3d-vce-0001" }) { id } }`,
      );
      expect(again.id).toBe(requestImport.id);

      // The connector stored the call.
      await h.publish('likho.import.completed', 'likho.import.completed.v1', {
        request_id: requestImport.id,
        workspace_id: asked.data.workspace_id,
        source: 'ameyo',
        external_id: 'd000-0a1b2c3d-vce-0001',
        recording_id: 'rec_01IMPORTED00000000000000000',
      });
      const done = await until(async () => {
        const { import: row } = await admin.ok(
          `query ($id: String!) { import(id: $id) { status recordingId } }`,
          {
            id: requestImport.id,
          },
        );
        return row.status === 'completed' ? row : null;
      }, 'the import to complete');
      expect(done.recordingId).toBe('rec_01IMPORTED00000000000000000');

      // Another one the dialer does not have.
      const { requestImport: missing } = await admin.ok(
        `mutation { requestImport(input: { externalId: "d000-0a1b2c3d-vce-0002", transcribe: false }) { id } }`,
      );
      await h.publish('likho.import.failed', 'likho.import.failed.v1', {
        request_id: missing.id,
        workspace_id: asked.data.workspace_id,
        source: 'ameyo',
        external_id: 'd000-0a1b2c3d-vce-0002',
        reason: 'The dialer has no recording for this call.',
        code: 'no_recording',
      });
      const failed = await until(async () => {
        const { import: row } = await admin.ok(
          `query ($id: String!) { import(id: $id) { status code reason } }`,
          {
            id: missing.id,
          },
        );
        return row.status === 'failed' ? row : null;
      }, 'the import to fail');
      expect(failed).toMatchObject({
        code: 'no_recording',
        reason: 'The dialer has no recording for this call.',
      });

      const { imports } = await admin.ok(`query { imports(first: 10) { items { id status } hasMore } }`);
      expect(imports.items.map((i: any) => i.id)).toEqual([missing.id, requestImport.id]);
      const { imports: failedOnly } = await admin.ok(`query { imports(status: [failed]) { items { id } } }`);
      expect(failedOnly.items.map((i: any) => i.id)).toEqual([missing.id]);
      expect(await admin.fails(`mutation { requestImport(input: { externalId: "bad id!" }) { id } }`)).toBe(
        'invalid',
      );
    });
  });

  describe('workspaces keep people apart', () => {
    it('a user of another workspace sees none of it', async () => {
      const auth = h.app.get((await import('../src/auth/auth.service.js')).AuthService);
      const other = await auth.createUser({
        email: 'other@example.test',
        name: 'Other',
        password: 'other-password-1',
      });
      await auth.createWorkspace('Other workspace', other.id);
      const browser = new Browser(h.url);
      await browser.login('other@example.test', 'other-password-1');

      const { recordings } = await browser.ok(`{ recordings { items { id } } }`);
      expect(recordings.items).toEqual([]);
      const { recordings: mine } = await admin.ok(
        `{ recordings(first: 1) { items { id latestTranscriptId } } }`,
      );
      expect(await browser.fails(GET_RECORDING, { id: mine.items[0].id })).toBe('not_found');
      expect(await browser.fails(`query { apiKeys { id } }`)).toBe('forbidden'); // a member, not an admin
    });
  });

  describe('jobs that get stuck', () => {
    const JOB = `query ($id: String!) { job(id: $id) { id status attempt errorCode errorMessage lastProgressAt } }`;
    const long_ago = new Date(Date.now() - 3_600_000);

    async function age(jobId: string, status?: 'queued' | 'running') {
      const { jobs } = await import('../src/db/schema.js');
      const { eq } = await import('drizzle-orm');
      const db = h.app.get((await import('../src/db/db.module.js')).DbService).db;
      await db
        .update(jobs)
        .set({ lastProgressAt: long_ago, ...(status ? { status, startedAt: long_ago } : {}) })
        .where(eq(jobs.id, jobId));
    }
    async function sweep() {
      const service = h.app.get((await import('../src/recordings/recordings.service.js')).RecordingsService);
      return service.sweepJobs();
    }

    beforeAll(async () => {
      await admin.ok(`mutation { updateSettings(autoTranscribe: false) { autoTranscribe } }`);
    });
    afterAll(async () => {
      await admin.ok(`mutation { updateSettings(autoTranscribe: true) { autoTranscribe } }`);
    });

    it('a job nobody took is asked for again, then failed', async () => {
      const recording = await readyRecording(admin, 'stuck.mp3', 'ready');
      const { createJob } = await admin.ok(
        `mutation ($id: String!) { createJob(input: { recordingId: $id }) { id attempt lastProgressAt } }`,
        { id: recording.id },
      );
      expect(createJob.attempt).toBe(1);
      expect(createJob.lastProgressAt).not.toBeNull();
      // Young: nothing to do.
      expect(await sweep()).toEqual({ requeued: 0, failed: 0 });

      await age(createJob.id);
      expect(await sweep()).toEqual({ requeued: 1, failed: 0 });
      const asked = h
        .published('likho.transcription.requested')
        .filter((e) => e.data.job_id === createJob.id);
      expect(asked.map((e) => e.data.attempt)).toEqual([1, 2]);
      const { job } = await admin.ok(JOB, { id: createJob.id });
      expect(job).toMatchObject({ status: 'queued', attempt: 2 });

      // Still nobody: the second try was the last.
      await age(createJob.id);
      expect(await sweep()).toEqual({ requeued: 0, failed: 1 });
      const { job: failed } = await admin.ok(JOB, { id: createJob.id });
      expect(failed).toMatchObject({ status: 'failed', errorCode: 'no_worker' });
      expect(failed.errorMessage).toContain('No worker took the job');
      const { recording: after } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(after.status).toBe('ready');
    });

    it('a job whose worker went quiet is stopped, failed and tried once more', async () => {
      const recording = await readyRecording(admin, 'stall.mp3', 'ready');
      const { createJob } = await admin.ok(
        `mutation ($id: String!) { createJob(input: { recordingId: $id, languagePolicy: "hi" }) { id } }`,
        { id: recording.id },
      );
      await age(createJob.id, 'running');
      expect(await sweep()).toEqual({ requeued: 1, failed: 1 });
      expect(h.transcription.cancelled).toContain(createJob.id);
      const { jobs: list } = await admin.ok(
        `query ($id: String!) { jobs(recordingId: $id) { id status attempt errorCode languagePolicy } }`,
        { id: recording.id },
      );
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ status: 'queued', attempt: 2, languagePolicy: 'hi' });
      expect(list[1]).toMatchObject({ id: createJob.id, status: 'failed', attempt: 1, errorCode: 'stalled' });
      const { recording: mid } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(mid.status).toBe('queued');

      // The second try stalls as well: that was the last one.
      await age(list[0].id, 'running');
      expect(await sweep()).toEqual({ requeued: 0, failed: 1 });
      const { recording: after } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(after.status).toBe('ready');
      expect(after.jobs.map((j: any) => j.status)).toEqual(['failed', 'failed']);
    });

    it('/metrics says how many jobs are in each state', async () => {
      const response = await fetch(`${h.url}/metrics`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toMatch(/likho_jobs\{[^}]*status="failed"[^}]*\} [1-9]/);
      expect(text).toMatch(/likho_jobs_finished_total\{[^}]*status="failed"[^}]*\} [1-9]/);
      expect(text).toMatch(/likho_job_sweeps_total\{[^}]*outcome="requeued"[^}]*\} 2/);
      expect(text).toContain('likho_jobs_queue_oldest_seconds');
      expect(text).toMatch(/likho_events_handled_total\{[^}]*outcome="ok"/);
    });
  });

  describe('people and roles', () => {
    let inviteLink = '';
    let viewerId = '';

    it('an admin invites a viewer; the link goes by mail and comes back to the admin', async () => {
      const { inviteUser } = await admin.ok(
        `mutation { inviteUser(input: { email: "Viewer@example.test", name: "Vee", role: viewer }) { invitation { id email name role acceptedAt } link sent } }`,
      );
      expect(inviteUser.invitation).toMatchObject({
        email: 'viewer@example.test',
        name: 'Vee',
        role: 'viewer',
        acceptedAt: null,
      });
      expect(inviteUser.sent).toBe(true);
      expect(inviteUser.link).toMatch(/^http:\/\/localhost:8080\/invite\/[A-Za-z0-9_-]{40,}$/);
      const mail = h.mail.outbox.at(-1)!;
      expect(mail.to).toBe('viewer@example.test');
      expect(mail.subject).toContain('Test workspace');
      expect(mail.text).toContain(inviteUser.link);
      inviteLink = inviteUser.link;

      const { invitations } = await admin.ok(`{ invitations { email role acceptedAt revokedAt } }`);
      expect(invitations).toContainEqual({
        email: 'viewer@example.test',
        role: 'viewer',
        acceptedAt: null,
        revokedAt: null,
      });
      expect(
        await admin.fails(`mutation { inviteUser(input: { email: "not-an-email", role: member }) { sent } }`),
      ).toBe('invalid');
      expect(
        await admin.fails(
          `mutation { inviteUser(input: { email: "admin@example.test", role: member }) { sent } }`,
        ),
      ).toBe('conflict');
    });

    it('the invited person signs in through the link, and a viewer can only read', async () => {
      const token = inviteLink.split('/').pop()!;
      const browser = new Browser(h.url);
      const { invitation } = await browser.ok(
        `query ($token: String!) { invitation(token: $token) { email name role workspace } }`,
        { token },
      );
      expect(invitation).toEqual({
        email: 'viewer@example.test',
        name: 'Vee',
        role: 'viewer',
        workspace: 'Test workspace',
      });
      const { acceptInvitation } = await browser.ok(
        `mutation ($token: String!) { acceptInvitation(token: $token, name: "Vee Viewer", password: "viewer-password-1") { id email name role workspace { name } } }`,
        { token },
      );
      expect(acceptInvitation).toMatchObject({
        email: 'viewer@example.test',
        name: 'Vee Viewer',
        role: 'viewer',
        workspace: { name: 'Test workspace' },
      });
      expect(browser.cookie).toContain('likho_session=');
      viewerId = acceptInvitation.id;
      // The link is used up.
      expect(
        await new Browser(h.url).fails(`query ($token: String!) { invitation(token: $token) { email } }`, {
          token,
        }),
      ).toBe('not_found');

      const { recordings } = await browser.ok(`{ recordings(first: 1) { items { id } } }`);
      expect(recordings.items).toHaveLength(1);
      const id = recordings.items[0].id;
      expect(await browser.fails(`mutation ($id: String!) { deleteRecording(id: $id) }`, { id })).toBe(
        'forbidden',
      );
      expect(
        await browser.fails(
          `mutation { requestUpload(input: { originalName: "x.mp3", sizeBytes: 1 }) { uploadUrl } }`,
        ),
      ).toBe('forbidden');
      expect(
        await browser.fails(`mutation ($id: String!) { createJob(input: { recordingId: $id }) { id } }`, {
          id,
        }),
      ).toBe('forbidden');
      expect(
        await browser.fails(`mutation { upsertSpelling(input: { source: "a", target: "b" }) { id } }`),
      ).toBe('forbidden');
      expect(await browser.fails(`mutation { requestImport(input: { externalId: "d000-1" }) { id } }`)).toBe(
        'forbidden',
      );
      expect(await browser.fails(`{ users { id } }`)).toBe('forbidden');
      expect(await browser.fails(`{ auditLog { items { id } } }`)).toBe('forbidden');
      const { users } = await admin.ok(`{ users { email role disabledAt } }`);
      expect(users).toContainEqual({ email: 'viewer@example.test', role: 'viewer', disabledAt: null });
    });

    it('a role change takes effect at once; an admin keeps their own role', async () => {
      const browser = new Browser(h.url);
      await browser.login('viewer@example.test', 'viewer-password-1');
      const { setUserRole } = await admin.ok(
        `mutation ($id: String!) { setUserRole(userId: $id, role: member) { role } }`,
        { id: viewerId },
      );
      expect(setUserRole.role).toBe('member');
      const { requestUpload } = await browser.ok(
        `mutation { requestUpload(input: { originalName: "by-member.mp3", sizeBytes: 1 }) { recording { id } } }`,
      );
      expect(requestUpload.recording.id).toMatch(/^rec_/);
      expect(await browser.fails(`{ users { id } }`)).toBe('forbidden');

      const { me } = await admin.ok(`{ me { id } }`);
      expect(
        await admin.fails(`mutation ($id: String!) { setUserRole(userId: $id, role: member) { role } }`, {
          id: me.id,
        }),
      ).toBe('invalid');
      expect(
        await admin.fails(`mutation ($id: String!) { disableUser(userId: $id) { id } }`, { id: me.id }),
      ).toBe('invalid');
    });

    it('a disabled person is signed out and cannot sign in until enabled again', async () => {
      const browser = new Browser(h.url);
      await browser.login('viewer@example.test', 'viewer-password-1');
      const { disableUser } = await admin.ok(
        `mutation ($id: String!) { disableUser(userId: $id) { disabledAt } }`,
        { id: viewerId },
      );
      expect(disableUser.disabledAt).not.toBeNull();
      expect(await browser.fails(`{ me { email } }`)).toBe('unauthenticated');
      expect(
        await new Browser(h.url).fails(
          `mutation { login(email: "viewer@example.test", password: "viewer-password-1") { id } }`,
        ),
      ).toBe('unauthenticated');
      await admin.ok(`mutation ($id: String!) { enableUser(userId: $id) { disabledAt } }`, { id: viewerId });
      await new Browser(h.url).login('viewer@example.test', 'viewer-password-1');
    });

    it('a password change needs the current one; a reset link comes by mail and works once', async () => {
      const browser = new Browser(h.url);
      await browser.login('viewer@example.test', 'viewer-password-1');
      expect(
        await browser.fails(
          `mutation { changePassword(currentPassword: "wrong-wrong-1", newPassword: "viewer-password-2") }`,
        ),
      ).toBe('invalid');
      await browser.ok(
        `mutation { changePassword(currentPassword: "viewer-password-1", newPassword: "viewer-password-2") }`,
      );
      await new Browser(h.url).login('viewer@example.test', 'viewer-password-2');

      const before = h.mail.outbox.length;
      const anonymous = new Browser(h.url);
      const unknown = await anonymous.ok(`mutation { requestPasswordReset(email: "nobody@example.test") }`);
      expect(unknown.requestPasswordReset).toBe(true);
      expect(h.mail.outbox.length).toBe(before); // an unknown address: the same answer, no mail
      await anonymous.ok(`mutation { requestPasswordReset(email: "viewer@example.test") }`);
      const mail = h.mail.outbox.at(-1)!;
      expect(mail.to).toBe('viewer@example.test');
      const token = /\/reset\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
      const { resetPassword } = await anonymous.ok(
        `mutation ($token: String!) { resetPassword(token: $token, password: "viewer-password-3") { email } }`,
        { token },
      );
      expect(resetPassword.email).toBe('viewer@example.test');
      expect(await browser.fails(`{ me { email } }`)).toBe('unauthenticated'); // every other session ended
      expect(
        await new Browser(h.url).fails(
          `mutation ($token: String!) { resetPassword(token: $token, password: "viewer-password-4") { email } }`,
          { token },
        ),
      ).toBe('not_found');
      await new Browser(h.url).login('viewer@example.test', 'viewer-password-3');
    });

    it('a revoked invitation is no good', async () => {
      const { inviteUser } = await admin.ok(
        `mutation { inviteUser(input: { email: "later@example.test", role: member }) { invitation { id } link } }`,
      );
      await admin.ok(`mutation ($id: String!) { revokeInvitation(id: $id) }`, {
        id: inviteUser.invitation.id,
      });
      const token = inviteUser.link.split('/').pop()!;
      expect(
        await new Browser(h.url).fails(
          `mutation ($token: String!) { acceptInvitation(token: $token, name: "L", password: "later-password-1") { id } }`,
          { token },
        ),
      ).toBe('not_found');
      const { invitations } = await admin.ok(`{ invitations { email revokedAt } }`);
      expect(invitations.find((i: any) => i.email === 'later@example.test').revokedAt).not.toBeNull();
    });
  });

  describe('scripts with an API key', () => {
    let key: string;

    it('an admin makes a key; it works on the REST API', async () => {
      const { createApiKey } = await admin.ok(
        `mutation { createApiKey(name: "dialer connector") { id key } }`,
      );
      expect(createApiKey.key).toMatch(/^lk_/);
      key = createApiKey.key;

      const created = await fetch(`${h.url}/api/v1/recordings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ originalName: 'from-script.mp3', sizeBytes: 999, externalId: 'ext-9' }),
      });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.uploadUrl).toMatch(/^http:\/\/media\.test\//);
      expect(body.recording).toMatchObject({
        originalName: 'from-script.mp3',
        source: 'api',
        externalId: 'ext-9',
        status: 'uploading',
      });

      // A connector says where the call comes from and what it knows about it.
      const fromDialer = await (
        await fetch(`${h.url}/api/v1/recordings`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            originalName: 'd000-0a1b2c3d-vce-0007.mp3',
            sizeBytes: 999,
            externalId: 'd000-0a1b2c3d-vce-0007',
            source: 'ameyo',
            attributes: {
              campaign: 'inbound',
              agent: 'agent-12',
              disposition: 'sale',
              callTime: '2026-10-03 09:12:00',
            },
          }),
        })
      ).json();
      expect(fromDialer.recording).toMatchObject({
        source: 'ameyo',
        attributes: { campaign: 'inbound', agent: 'agent-12', disposition: 'sale' },
      });
      const { recording: shown } = await admin.ok(
        `query ($id: String!) { recording(id: $id) { source attributes { key value } } }`,
        { id: fromDialer.recording.id },
      );
      expect(shown.source).toBe('ameyo');
      expect(shown.attributes).toContainEqual({ key: 'campaign', value: 'inbound' });
      const search = await (
        await fetch(`${h.url}/api/v1/search?q=order&pageSize=5`, {
          headers: { authorization: `Bearer ${key}` },
        })
      ).json();
      expect(search).toMatchObject({ page: 1, pageSize: 5 });

      const list = await (
        await fetch(`${h.url}/api/v1/recordings?search=ext-9`, {
          headers: { authorization: `Bearer ${key}` },
        })
      ).json();
      expect(list.items.map((r: any) => r.id)).toEqual([body.recording.id]);
      const one = await (
        await fetch(`${h.url}/api/v1/recordings/${body.recording.id}/transcript`, {
          headers: { authorization: `Bearer ${key}` },
        })
      ).json();
      expect(one).toEqual({ transcript: null, status: 'uploading' });
    });

    it('bad input is refused in the common error shape', async () => {
      const response = await fetch(`${h.url}/api/v1/recordings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ originalName: '', sizeBytes: -1 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('invalid');
      expect(body.error.message).toContain('sizeBytes');
    });

    it('a revoked key stops working', async () => {
      const { apiKeys } = await admin.ok(`query { apiKeys { id name revokedAt } }`);
      expect(apiKeys).toMatchObject([{ name: 'dialer connector', revokedAt: null }]);
      await admin.ok(`mutation ($id: String!) { revokeApiKey(id: $id) }`, { id: apiKeys[0].id });
      const response = await fetch(`${h.url}/api/v1/recordings`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(response.status).toBe(401);
      const { apiKeys: after } = await admin.ok(`query { apiKeys { id revokedAt } }`);
      expect(after[0].revokedAt).not.toBeNull();
    });

    it('the OpenAPI description and the docs page are served', async () => {
      const spec = await (await fetch(`${h.url}/api/openapi.json`)).json();
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/recordings',
          '/api/v1/recordings/{id}/transcript',
          '/api/v1/jobs/{id}/cancel',
        ]),
      );
      expect((await fetch(`${h.url}/api/docs`)).status).toBe(200);
    });
  });

  describe('vocabulary', () => {
    it('glossary terms and spellings go to likho-language', async () => {
      const { upsertGlossaryTerm } = await admin.ok(
        `mutation { upsertGlossaryTerm(input: { term: "त्रिफला" }) { id term language enabled } }`,
      );
      expect(upsertGlossaryTerm).toMatchObject({ term: 'त्रिफला', language: 'hi', enabled: true });
      const { upsertSpelling } = await admin.ok(
        `mutation { upsertSpelling(input: { source: "त्रिफला", target: "Triphala" }) { id source target isPhrase } }`,
      );
      expect(upsertSpelling).toMatchObject({ source: 'त्रिफला', target: 'Triphala', isPhrase: false });
      expect(await admin.ok(`{ glossary { term } spellings { target } }`)).toEqual({
        glossary: [{ term: 'त्रिफला' }],
        spellings: [{ target: 'Triphala' }],
      });
      await admin.ok(`mutation ($id: String!) { deleteSpelling(id: $id) }`, { id: upsertSpelling.id });
      expect(
        await admin.fails(`mutation ($id: String!) { deleteSpelling(id: $id) }`, { id: upsertSpelling.id }),
      ).toBe('not_found');
      expect(await admin.fails(`mutation { upsertGlossaryTerm(input: { term: "  " }) { id } }`)).toBe(
        'invalid',
      );
    });
  });

  describe('the audit log', () => {
    it('has every change, with who did it and to what', async () => {
      const { auditLog } = await admin.ok(
        `{ auditLog(first: 200) { items { id action actorKind actorId actorName targetKind targetId details ip createdAt } hasMore } }`,
      );
      expect(auditLog.hasMore).toBe(false);
      const actions: string[] = auditLog.items.map((e: any) => e.action);
      for (const action of [
        'recording.created',
        'recording.deleted',
        'job.created',
        'job.cancelled',
        'transcript.retransliterated',
        'transcript.corrected',
        'import.requested',
        'settings.updated',
        'api_key.created',
        'api_key.revoked',
        'user.invited',
        'invitation.accepted',
        'invitation.revoked',
        'user.role_changed',
        'user.disabled',
        'user.enabled',
        'user.password_changed',
        'user.password_reset',
        'glossary.added',
        'spelling.added',
        'spelling.deleted',
      ]) {
        expect(actions, action).toContain(action);
      }
      // Newest first, and ids sort by time.
      expect([...auditLog.items].sort((a: any, b: any) => (a.id < b.id ? 1 : -1))).toEqual(auditLog.items);

      const invited = auditLog.items.find(
        (e: any) => e.action === 'user.invited' && JSON.parse(e.details).email === 'viewer@example.test',
      );
      expect(invited).toMatchObject({ actorKind: 'user', actorName: 'Admin', targetKind: 'invitation' });
      expect(invited.targetId).toMatch(/^inv_/);
      expect(invited.ip).not.toBe('');
      const roleChange = auditLog.items.find((e: any) => e.action === 'user.role_changed');
      expect(JSON.parse(roleChange.details)).toEqual({
        email: 'viewer@example.test',
        from: 'viewer',
        to: 'member',
      });
      const byScript = auditLog.items.filter(
        (e: any) => e.action === 'recording.created' && e.actorKind === 'api_key',
      );
      expect(byScript.map((e: any) => e.actorName)).toEqual([
        'API key "dialer connector"',
        'API key "dialer connector"',
      ]);
      expect(byScript.map((e: any) => JSON.parse(e.details))).toEqual([
        { originalName: 'd000-0a1b2c3d-vce-0007.mp3', source: 'ameyo' },
        { originalName: 'from-script.mp3', source: 'api' },
      ]);
      const accepted = auditLog.items.find((e: any) => e.action === 'invitation.accepted');
      expect(accepted.actorName).toBe('Vee Viewer'); // the new person, acting for themselves
      expect(accepted.targetId).toBe(accepted.actorId);

      // Filters and pages.
      const { auditLog: disabled } = await admin.ok(
        `{ auditLog(filter: { action: "user.disabled" }) { items { targetId } } }`,
      );
      expect(disabled.items).toEqual([{ targetId: accepted.actorId }]);
      const { auditLog: ofPerson } = await admin.ok(
        `query ($id: String!) { auditLog(filter: { targetKind: "user", targetId: $id }) { items { action } } }`,
        { id: accepted.actorId },
      );
      expect(ofPerson.items.map((e: any) => e.action)).toEqual([
        'user.password_reset',
        'user.password_changed',
        'user.enabled',
        'user.disabled',
        'user.role_changed',
        'invitation.accepted',
      ]);
      const { auditLog: firstPage } = await admin.ok(
        `{ auditLog(first: 2) { items { id } hasMore endCursor } }`,
      );
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      const { auditLog: secondPage } = await admin.ok(
        `query ($after: String!) { auditLog(first: 2, after: $after) { items { id } } }`,
        { after: firstPage.endCursor },
      );
      expect(secondPage.items.map((e: any) => e.id)).toEqual(
        auditLog.items.slice(2, 4).map((e: any) => e.id),
      );
    });
  });
});
