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

    it('deleting removes the audio too', async () => {
      const recording = await readyRecording(admin, 'gone.mp3');
      await admin.ok(`mutation ($id: String!) { deleteRecording(id: $id) }`, { id: recording.id });
      expect(h.media.deleted).toContain(recording.mediaId);
      expect(await admin.fails(GET_RECORDING, { id: recording.id })).toBe('not_found');
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
});
