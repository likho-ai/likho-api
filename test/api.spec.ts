/**
 * The whole service: GraphQL for browsers, REST for scripts, events from the other services,
 * live updates. Runs against the local stack; see harness.ts.
 */
import { Bucket, Dimension, Metric } from '@likho-ai/contracts/analytics/v1/analytics_pb';
import { newId } from '../src/common/ids.js';
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
      await admin.ok(`mutation { updateSettings(input: { autoTranscribe: false }) { autoTranscribe } }`);
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
        await admin.ok(`mutation { updateSettings(input: { autoTranscribe: true }) { autoTranscribe } }`);
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

      // "Every sale call of agent-x since last week with the word refund": the facts go along.
      await admin.ok(
        `query { search(query: "refund", filter: { campaign: "sale", agent: "agent-x", source: "ameyo", callSince: "2026-09-28T00:00:00.000Z" }) { total } }`,
      );
      expect(h.search.asked.at(-1)).toMatchObject({
        query: 'refund',
        campaign: 'sale',
        agent: 'agent-x',
        source: 'ameyo',
        callSince: new Date('2026-09-28T00:00:00.000Z'),
      });
    });

    it('the facts of a call narrow the library, have counts, and go on the bus', async () => {
      const facts = (campaign: string, agent: string, callTime: string) => ({
        attributes: [
          { key: 'campaign', value: campaign },
          { key: 'agent', value: agent },
          { key: 'disposition', value: 'sold' },
          { key: 'callTime', value: callTime },
        ],
      });
      const first = await readyRecording(
        admin,
        'sale-1.mp3',
        'queued',
        facts('sale', 'agent-x', '2026-10-01 09:00:00'),
      );
      const second = await readyRecording(
        admin,
        'sale-2.mp3',
        'queued',
        facts('sale', 'agent-y', '2026-09-20 09:00:00'),
      );
      const third = await readyRecording(
        admin,
        'support-1.mp3',
        'queued',
        facts('support', 'agent-x', '2026-10-02 09:00:00'),
      );

      // The call time comes from the attribute, read in this process's time zone.
      const { recording } = await admin.ok(
        `query ($id: String!) { recording(id: $id) { callTime createdAt } }`,
        {
          id: first.id,
        },
      );
      expect(new Date(recording.callTime).getTime()).toBe(new Date('2026-10-01T09:00:00').getTime());

      const ids = (page: { items: { id: string }[] }) => page.items.map((r) => r.id).sort();
      const { recordings: sale } = await admin.ok(
        `query { recordings(filter: { campaign: "sale" }, first: 50) { items { id } } }`,
      );
      expect(ids(sale)).toEqual([first.id, second.id].sort());
      const { recordings: agentX } = await admin.ok(
        `query { recordings(filter: { agent: "agent-x", since: "2026-10-01T00:00:00.000Z" }, first: 50) { items { id } } }`,
      );
      expect(ids(agentX)).toEqual([first.id, third.id].sort());
      const { recordings: lastWeek } = await admin.ok(
        `query { recordings(filter: { campaign: "sale", until: "2026-09-30T00:00:00.000Z" }, first: 50) { items { id } } }`,
      );
      expect(ids(lastWeek)).toEqual([second.id]);
      const { recordings: uploads } = await admin.ok(
        `query { recordings(filter: { source: "upload", disposition: "sold" }, first: 50) { items { id } } }`,
      );
      expect(ids(uploads)).toEqual([first.id, second.id, third.id].sort());

      const { recordingFacets: campaigns } = await admin.ok(
        `query { recordingFacets(key: "campaign", filter: { disposition: "sold" }) { value count } }`,
      );
      expect(campaigns).toEqual([
        { value: 'sale', count: 2 },
        { value: 'support', count: 1 },
      ]);
      const { recordingFacets: agents } = await admin.ok(
        `query { recordingFacets(key: "agent", filter: { campaign: "sale" }) { value count } }`,
      );
      expect(agents).toEqual([
        { value: 'agent-x', count: 1 },
        { value: 'agent-y', count: 1 },
      ]);
      expect(await admin.fails(`query { recordingFacets(key: "phone") { value } }`)).toBe('invalid');

      // likho-search was told the facts the moment the recording was made.
      const told = h.published('likho.recording.updated').find((e) => e.data.recording_id === first.id);
      expect(told).toMatchObject({
        type: 'likho.recording.updated.v1',
        data: {
          recording_id: first.id,
          source: 'upload',
          name: 'sale-1.mp3',
          attributes: { campaign: 'sale', agent: 'agent-x', disposition: 'sold' },
        },
      });
      expect(new Date(told!.data.call_time as string).getTime()).toBe(
        new Date('2026-10-01T09:00:00').getTime(),
      );
    });

    it('a search can be kept for later, and removed by who kept it or an admin', async () => {
      const { saveSearch } = await admin.ok(
        `mutation { saveSearch(input: { name: "refunds in sales", query: "refund", filter: { campaign: "sale", agent: "agent-x", callSince: "2026-09-28T00:00:00.000Z" } }) {
          id name query filter { campaign agent disposition callSince callUntil } createdBy createdAt
        } }`,
      );
      expect(saveSearch).toMatchObject({
        name: 'refunds in sales',
        query: 'refund',
        filter: {
          campaign: 'sale',
          agent: 'agent-x',
          disposition: null,
          callSince: '2026-09-28T00:00:00.000Z',
          callUntil: null,
        },
      });
      expect(saveSearch.createdBy).toMatch(/^usr_/);
      const { savedSearches } = await admin.ok(`{ savedSearches { id name query filter { campaign } } }`);
      expect(savedSearches).toContainEqual({
        id: saveSearch.id,
        name: 'refunds in sales',
        query: 'refund',
        filter: { campaign: 'sale' },
      });
      expect(await admin.fails(`mutation { saveSearch(input: { name: " ", query: "refund" }) { id } }`)).toBe(
        'invalid',
      );
      expect(
        await admin.ok(`mutation ($id: String!) { deleteSavedSearch(id: $id) }`, { id: saveSearch.id }),
      ).toEqual({
        deleteSavedSearch: true,
      });
      expect(
        await admin.fails(`mutation ($id: String!) { deleteSavedSearch(id: $id) }`, { id: saveSearch.id }),
      ).toBe('not_found');
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
      await admin.ok(`mutation { updateSettings(input: { autoTranscribe: false }) { autoTranscribe } }`);
    });
    afterAll(async () => {
      await admin.ok(`mutation { updateSettings(input: { autoTranscribe: true }) { autoTranscribe } }`);
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
      expect(asked.map((e) => e.data.attempt)).toEqual([1, 1]); // asked twice; not tried once
      const { job } = await admin.ok(JOB, { id: createJob.id });
      expect(job).toMatchObject({ status: 'queued', attempt: 1 });

      // Still nobody: the second try was the last.
      await age(createJob.id);
      expect(await sweep()).toEqual({ requeued: 0, failed: 1 });
      const { job: failed } = await admin.ok(JOB, { id: createJob.id });
      expect(failed).toMatchObject({ status: 'failed', errorCode: 'no_worker' });
      expect(failed.errorMessage).toContain('No worker took the job');
      const { recording: after } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(after.status).toBe('ready');
    });

    it('a job a worker has taken is running, and is left alone while the model loads', async () => {
      const recording = await readyRecording(admin, 'taken.mp3', 'ready');
      const { createJob } = await admin.ok(
        `mutation ($id: String!) { createJob(input: { recordingId: $id }) { id } }`,
        { id: recording.id },
      );
      await age(createJob.id); // queued long ago...
      await h.publish('likho.transcription.started', 'likho.transcription.started.v1', {
        job_id: createJob.id,
        recording_id: recording.id,
        workspace_id: h.media.uploads.at(-1)!.workspaceId,
        attempt: 1,
      });
      await until(async () => {
        const { job } = await admin.ok(JOB, { id: createJob.id });
        return job.status === 'running' ? job : null;
      }, 'the job to be running');
      // ...but a worker has it now: nothing for the sweeper to do.
      expect(await sweep()).toEqual({ requeued: 0, failed: 0 });
      // The recording follows the job a moment later (a write of its own).
      const mid = await until(async () => {
        const { recording: r } = await admin.ok(GET_RECORDING, { id: recording.id });
        return r.status === 'transcribing' ? r : null;
      }, 'the recording to be transcribing');
      expect(mid.jobs[0]).toMatchObject({ status: 'running', totalSeconds: 61.5 }); // the length stays known
      await admin.ok(`mutation ($id: String!) { cancelJob(id: $id) { status } }`, { id: createJob.id });
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

      // The fresh try is a job of its own: it too is asked for again before it is given up on.
      await age(list[0].id);
      expect(await sweep()).toEqual({ requeued: 1, failed: 0 });
      expect(
        h.published('likho.transcription.requested').filter((e) => e.data.job_id === list[0].id),
      ).toHaveLength(2);

      // The second try stalls as well: that was the last one.
      await age(list[0].id, 'running');
      expect(await sweep()).toEqual({ requeued: 0, failed: 1 });
      const { recording: after } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(after.status).toBe('ready');
      expect(after.jobs.map((j: any) => j.status)).toEqual(['failed', 'failed']);
    });

    it('a worker that starts a job given up on is told to drop it; a transcript that comes anyway counts', async () => {
      const recording = await readyRecording(admin, 'late.mp3', 'ready');
      const { createJob } = await admin.ok(
        `mutation ($id: String!) { createJob(input: { recordingId: $id }) { id } }`,
        { id: recording.id },
      );
      const workspaceId = h.media.uploads.at(-1)!.workspaceId;
      const stops = () => h.transcription.cancelled.filter((id) => id === createJob.id).length;
      await age(createJob.id, 'running');
      expect(await sweep()).toEqual({ requeued: 1, failed: 1 });
      expect(stops()).toBe(1);

      // The request of the stalled job reaches the worker that comes back: it is told to drop it.
      await h.publish('likho.transcription.started', 'likho.transcription.started.v1', {
        job_id: createJob.id,
        recording_id: recording.id,
        workspace_id: workspaceId,
        attempt: 2,
      });
      await until(async () => (stops() === 2 ? true : null), 'the worker to be asked to drop the job');
      const { job: still } = await admin.ok(JOB, { id: createJob.id });
      expect(still).toMatchObject({ status: 'failed', errorCode: 'stalled' });

      // A worker that finished it all the same: the transcript is kept, the job is done after all.
      const transcript = h.transcription.add('trn_01JB7Z5K3M9Q2W4X6Y8A0LATE', recording.id, createJob.id);
      await h.publish('likho.transcription.completed', 'likho.transcription.completed.v1', {
        job_id: createJob.id,
        recording_id: recording.id,
        transcript_id: transcript.id,
        workspace_id: workspaceId,
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
      const done = await until(async () => {
        const { job } = await admin.ok(JOB, { id: createJob.id });
        return job.status === 'done' ? job : null;
      }, 'the job to be done after all');
      expect(done).toMatchObject({ status: 'done', errorCode: '', errorMessage: '' });
      const { recording: after } = await admin.ok(GET_RECORDING, { id: recording.id });
      expect(after).toMatchObject({ status: 'done', latestTranscriptId: transcript.id });
    });

    it('/metrics says how many jobs are in each state', async () => {
      const response = await fetch(`${h.url}/metrics`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toMatch(/likho_jobs\{[^}]*status="failed"[^}]*\} [1-9]/);
      expect(text).toMatch(/likho_jobs_finished_total\{[^}]*status="failed"[^}]*\} [1-9]/);
      expect(text).toMatch(/likho_job_sweeps_total\{[^}]*outcome="requeued"[^}]*\} 4/);
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
      // The admin sees when the key was last used.
      const used = await until(async () => {
        const { apiKeys } = await admin.ok(`{ apiKeys { id lastUsedAt } }`);
        return apiKeys.find(
          (k: { id: string; lastUsedAt: string | null }) => k.id === createApiKey.id && k.lastUsedAt,
        );
      }, 'the key’s last use to be noted');
      expect(Date.now() - new Date(used.lastUsedAt).getTime()).toBeLessThan(60_000);
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

    it('counts and examples come back from likho-language, and CSV goes in and out', async () => {
      const { upsertGlossaryTerm: phrase } = await admin.ok(
        `mutation { upsertGlossaryTerm(input: { term: "Triphala Churna", language: "en" }) { id isPhrase heard lastHeardAt } }`,
      );
      expect(phrase).toMatchObject({ isPhrase: true, heard: 0, lastHeardAt: null });
      const { upsertSpelling: spelt } = await admin.ok(
        `mutation { upsertSpelling(input: { source: "नीम", target: "Neem" }) { id applied examples { before } } }`,
      );
      expect(spelt).toMatchObject({ applied: 0, examples: [] });

      // likho-language heard them.
      const term = h.language.terms.get(phrase.id)!;
      term.heard = 3n;
      term.lastHeardAt = { seconds: 1791183600n, nanos: 0 }; // 2026-10-05T07:00:00Z
      const spelling = h.language.spellings.get(spelt.id)!;
      spelling.applied = 2n;
      spelling.examples = [
        {
          recordingId: 'rec_01JB7Z5K3M9Q2W4X6Y8A0C1E3G',
          segmentIndex: 4,
          before: 'नीम लीजिए',
          after: 'Neem lijiye',
          heardAt: { seconds: 1791183840n, nanos: 0 },
        },
      ];
      const { glossary, spellings } = await admin.ok(
        `{ glossary { term heard lastHeardAt isPhrase } spellings { source applied lastAppliedAt examples { recordingId segmentIndex before after heardAt } } }`,
      );
      expect(glossary.find((t: any) => t.term === 'Triphala Churna')).toEqual({
        term: 'Triphala Churna',
        heard: 3,
        lastHeardAt: '2026-10-05T07:00:00.000Z',
        isPhrase: true,
      });
      expect(spellings.find((s: any) => s.source === 'नीम')).toEqual({
        source: 'नीम',
        applied: 2,
        lastAppliedAt: null,
        examples: [
          {
            recordingId: 'rec_01JB7Z5K3M9Q2W4X6Y8A0C1E3G',
            segmentIndex: 4,
            before: 'नीम लीजिए',
            after: 'Neem lijiye',
            heardAt: '2026-10-05T07:04:00.000Z',
          },
        ],
      });

      // CSV in: the first line names the columns; an entry already there is updated.
      const { importGlossaryCsv } = await admin.ok(
        `mutation ($csv: String!) { importGlossaryCsv(csv: $csv) { added updated } }`,
        {
          csv: 'term,language,enabled,note\r\nअश्वगंधा,hi,true,a herb\r\n"Triphala Churna",en,yes,"powder, mixed"\r\n',
        },
      );
      expect(importGlossaryCsv).toEqual({ added: 1, updated: 1 });
      const { importSpellingsCsv } = await admin.ok(
        `mutation ($csv: String!) { importSpellingsCsv(csv: $csv) { added updated } }`,
        { csv: 'source,target\nनीम,Neem leaf\nकल तक,by tomorrow\n' },
      );
      expect(importSpellingsCsv).toEqual({ added: 1, updated: 1 });
      expect(
        await admin.fails(`mutation ($csv: String!) { importGlossaryCsv(csv: $csv) { added } }`, {
          csv: 'language,note\nhi,x',
        }),
      ).toBe('invalid');

      // CSV out, with the counts.
      const { glossaryCsv, spellingsCsv } = await admin.ok(`{ glossaryCsv spellingsCsv }`);
      expect(glossaryCsv.split('\r\n')[0]).toBe('term,language,enabled,note,heard,last_heard_at');
      expect(glossaryCsv).toContain('Triphala Churna,en,true,"powder, mixed",3,2026-10-05T07:00:00.000Z');
      expect(glossaryCsv).toContain('अश्वगंधा,hi,true,a herb,0,');
      expect(spellingsCsv.split('\r\n')[0]).toBe('source,target,enabled,applied,last_applied_at');
      expect(spellingsCsv).toContain('नीम,Neem leaf,true,2,');
      expect(spellingsCsv).toContain('कल तक,by tomorrow,true,0,');
    });

    it('the CSV also goes through the REST API with a key', async () => {
      const { createApiKey } = await admin.ok(`mutation { createApiKey(name: "vocabulary script") { key } }`);
      const headers = { authorization: `Bearer ${createApiKey.key}` };
      const loaded = await fetch(`${h.url}/api/v1/vocabulary/spellings.csv`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/csv; charset=utf-8' },
        body: 'source,target,enabled\nतुलसी,Tulsi,true\n',
      });
      expect(loaded.status).toBe(200);
      expect(await loaded.json()).toEqual({ added: 1, updated: 0 });
      const out = await fetch(`${h.url}/api/v1/vocabulary/spellings.csv`, { headers });
      expect(out.status).toBe(200);
      expect(out.headers.get('content-type')).toContain('text/csv');
      expect(await out.text()).toContain('तुलसी,Tulsi,true,0,');
      const glossary = await fetch(`${h.url}/api/v1/vocabulary/glossary.csv`, { headers });
      expect((await glossary.text()).split('\r\n')[0]).toBe('term,language,enabled,note,heard,last_heard_at');
      const bad = await fetch(`${h.url}/api/v1/vocabulary/glossary.csv`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/csv' },
        body: 'note\nx',
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe('invalid');
    });
  });

  describe('insights', () => {
    const INSIGHTS = `query ($id: String!) { insights(recordingId: $id) {
      id transcriptId recordingId transcriptVersion summary intent products sentiment
      checks { key label answer evidence } scores { key label score max reason } scoreTotal scoreMax
      model inputTokens outputTokens formVersion createdAt
    } }`;
    const ANALYSE = `mutation ($id: String!, $force: Boolean) { analyseRecording(id: $id, force: $force) { id transcriptId } }`;

    /** A recording whose transcript is done. */
    async function transcribed(name: string) {
      const recording = await readyRecording(admin, name);
      const workspaceId = h.media.uploads.at(-1)!.workspaceId;
      const transcript = h.transcription.add(newId('trn'), recording.id, recording.jobs[0].id);
      await h.publish('likho.transcription.completed', 'likho.transcription.completed.v1', {
        job_id: recording.jobs[0].id,
        recording_id: recording.id,
        transcript_id: transcript.id,
        workspace_id: workspaceId,
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
      await until(async () => {
        const { recording: r } = await admin.ok(GET_RECORDING, { id: recording.id });
        return r.status === 'done' ? r : null;
      }, `the transcript of ${name}`);
      return { recording, transcript, workspaceId };
    }

    it('a transcribed call gets its insights, and the page watching the call hears so', async () => {
      const { recording, transcript, workspaceId } = await transcribed('insights.mp3');
      expect((await admin.ok(INSIGHTS, { id: recording.id })).insights).toBeNull();
      const { recording: bare } = await admin.ok(
        `query ($id: String!) { recording(id: $id) { insights { id } } }`,
        { id: recording.id },
      );
      expect(bare.insights).toBeNull();

      // likho-insights analysed the transcript and said so; the open page hears it and fetches.
      // The stream opens with an `open` event; the answer is published only once it has arrived,
      // so it cannot be relayed before the page listens.
      const made = h.insights.add(transcript.id, recording.id, workspaceId);
      let published = false;
      const watching = readEvents(h.url, `/events/recordings/${recording.id}`, admin.cookie, (events) => {
        if (!published) {
          published = true;
          void h.publish('likho.insights.completed', 'likho.insights.completed.v1', {
            insights_id: made.id,
            transcript_id: transcript.id,
            recording_id: recording.id,
            workspace_id: workspaceId,
            model: 'fake/one',
            sentiment: 'positive',
            score_total: 13,
            score_max: 15,
            input_tokens: 100,
            output_tokens: 50,
          });
        }
        return events.some((e) => e.type === 'insights');
      });
      const events = await watching;
      expect(events[0]).toEqual({ type: 'open', data: { recordingId: recording.id, status: 'done' } });
      expect(events.find((e) => e.type === 'insights')!.data).toEqual({
        recordingId: recording.id,
        status: 'done',
        transcriptId: transcript.id,
        insightsId: made.id,
        sentiment: 'positive',
        scoreTotal: 13,
        scoreMax: 15,
        model: 'fake/one',
      });

      const { insights } = await admin.ok(INSIGHTS, { id: recording.id });
      expect(insights).toMatchObject({
        id: made.id,
        transcriptId: transcript.id,
        recordingId: recording.id,
        transcriptVersion: 1,
        intent: 'order a product',
        products: ['Ashwagandha'],
        sentiment: 'positive',
        scoreTotal: 13,
        scoreMax: 15,
        model: 'fake/one',
        inputTokens: 100,
        outputTokens: 50,
        formVersion: 'example-1',
      });
      expect(insights.summary).toContain('the order was placed');
      expect(insights.checks).toEqual([
        { key: 'greeting', label: 'The agent greeted the customer', answer: 'yes', evidence: 'namaste' },
        { key: 'closing', label: 'The agent closed the call properly', answer: 'na', evidence: '' },
      ]);
      expect(insights.scores[1]).toEqual({
        key: 'resolution',
        label: 'The need was handled',
        score: 9,
        max: 10,
        reason: 'The order was placed.',
      });
      expect(insights.createdAt).toBeTruthy();
      const { recording: shown } = await admin.ok(
        `query ($id: String!) { recording(id: $id) { insights { id summary } } }`,
        { id: recording.id },
      );
      expect(shown.insights).toMatchObject({ id: made.id });

      // Asked again, by force: likho-insights is asked about this transcript, and it is audited.
      const { analyseRecording } = await admin.ok(ANALYSE, { id: recording.id, force: true });
      expect(analyseRecording).toEqual({ id: made.id, transcriptId: transcript.id });
      expect(h.insights.asked.at(-1)).toEqual({ transcriptId: transcript.id, workspaceId, force: true });

      // A failure is heard too.
      let failurePublished = false;
      const failing = readEvents(h.url, `/events/recordings/${recording.id}`, admin.cookie, (events) => {
        if (!failurePublished) {
          failurePublished = true;
          void h.publish('likho.insights.failed', 'likho.insights.failed.v1', {
            transcript_id: transcript.id,
            recording_id: recording.id,
            workspace_id: workspaceId,
            code: 'model_error',
            message: 'The model is rate limited',
            attempt: 1,
          });
        }
        return events.some((e) => e.type === 'insights' && e.data.status === 'failed');
      });
      expect((await failing).find((e) => e.type === 'insights')!.data).toEqual({
        recordingId: recording.id,
        status: 'failed',
        transcriptId: transcript.id,
        code: 'model_error',
        message: 'The model is rate limited',
      });

      // Over REST too, with the session or an API key.
      const headers = { cookie: admin.cookie };
      const rest = await (
        await fetch(`${h.url}/api/v1/recordings/${recording.id}/insights`, { headers })
      ).json();
      expect(rest).toMatchObject({ id: made.id, sentiment: 'positive', scoreTotal: 13 });
      expect(typeof rest.createdAt).toBe('string');
      const again = await (
        await fetch(`${h.url}/api/v1/recordings/${recording.id}/insights`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ force: false }),
        })
      ).json();
      expect(again).toMatchObject({ id: made.id });
      expect(h.insights.asked.at(-1)).toEqual({ transcriptId: transcript.id, workspaceId, force: false });
      const status = await (await fetch(`${h.url}/api/v1/insights/status`, { headers })).json();
      expect(status).toEqual({ enabled: true, model: 'fake/one', formVersion: 'example-1' });
    });

    it('a recording without a transcript, or of another workspace, has nothing to show', async () => {
      const { requestUpload } = await admin.ok(REQUEST_UPLOAD, {
        input: { originalName: 'insights-2.mp3', sizeBytes: 10 },
      });
      const id = requestUpload.recording.id;
      expect((await admin.ok(INSIGHTS, { id })).insights).toBeNull();
      expect(await admin.fails(ANALYSE, { id })).toBe('invalid');
      const missing = await fetch(`${h.url}/api/v1/recordings/${id}/insights`, {
        headers: { cookie: admin.cookie },
      });
      expect(missing.status).toBe(404);

      const auth = h.app.get((await import('../src/auth/auth.service.js')).AuthService);
      const stranger = await auth.createUser({
        email: 'insights-other@example.test',
        name: 'Other',
        password: 'other-password-1',
      });
      await auth.createWorkspace('Another workspace', stranger.id);
      const other = new Browser(h.url);
      await other.login('insights-other@example.test', 'other-password-1');
      expect(await other.fails(INSIGHTS, { id })).toBe('not_found');
      expect(await other.fails(ANALYSE, { id })).toBe('not_found');
      const stream = await fetch(`${h.url}/events/recordings/${id}`, {
        headers: { cookie: other.cookie, accept: 'text/event-stream' },
      });
      expect(stream.status).toBe(404);
    });

    it('without a model, insights are off and asking for them says so', async () => {
      const { recording } = await transcribed('insights-3.mp3');
      h.insights.enabled = false;
      try {
        const { insightsStatus } = await admin.ok(`{ insightsStatus { enabled model formVersion } }`);
        expect(insightsStatus).toEqual({ enabled: false, model: '', formVersion: 'example-1' });
        const { errors } = await admin.graphql(ANALYSE, { id: recording.id });
        expect(errors?.[0]).toMatchObject({ extensions: { code: 'invalid' } });
        expect(errors?.[0]?.message).toContain('No model is configured');
      } finally {
        h.insights.enabled = true;
      }
    });
  });

  /** A member of the workspace, signed in through an invitation (made once). */
  let memberSession: Browser | null = null;
  const signInMember = async (): Promise<Browser> => {
    if (memberSession) return memberSession;
    const email = `member-${Date.now()}@example.test`;
    const { inviteUser } = await admin.ok(
      `mutation ($email: String!) { inviteUser(input: { email: $email, name: "Mem", role: member }) { link } }`,
      { email },
    );
    const browser = new Browser(h.url);
    await browser.ok(
      `mutation ($token: String!) { acceptInvitation(token: $token, name: "Mem Ber", password: "member-password-1") { id } }`,
      { token: inviteUser.link.split('/').pop() },
    );
    memberSession = browser;
    return browser;
  };

  describe('the workspace’s settings', () => {
    it('reads every setting with the defaults, changes a few, checks them, tells the bus and the audit log', async () => {
      const member = await signInMember();
      const { settings } = await member.ok(
        `{ settings { autoTranscribe dialer { scheduleEnabled campaigns minTalkSeconds dailyLimit batchLimit pollIntervalSeconds phoneDigits writebackEnabled } } }`,
      );
      expect(settings.dialer).toMatchObject({
        scheduleEnabled: false,
        campaigns: [],
        minTalkSeconds: 20,
        dailyLimit: 200,
        phoneDigits: 4,
      });

      const { updateSettings } = await admin.ok(
        `mutation ($input: SettingsInput!) { updateSettings(input: $input) { autoTranscribe dialer { scheduleEnabled campaigns dailyLimit minTalkSeconds } } }`,
        {
          input: {
            dialer: { scheduleEnabled: true, campaigns: [' Sales ', 'Support', 'Sales'], dailyLimit: 500 },
          },
        },
      );
      expect(updateSettings.dialer).toEqual({
        scheduleEnabled: true,
        campaigns: ['Sales', 'Support'],
        dailyLimit: 500,
        minTalkSeconds: 20,
      });
      const told = await until(
        async () =>
          h.published('likho.settings.changed').find((e) => e.data.keys.includes('dialer.daily_limit'))!,
        'the settings to be told on the bus',
      );
      expect(told.data.keys.sort()).toEqual([
        'dialer.campaigns',
        'dialer.daily_limit',
        'dialer.schedule_enabled',
      ]);

      // A connector reads them with its key.
      const { createApiKey } = await admin.ok(
        `mutation { createApiKey(name: "dialer connector 2") { key } }`,
      );
      const rest = await (
        await fetch(`${h.url}/api/v1/settings`, { headers: { authorization: `Bearer ${createApiKey.key}` } })
      ).json();
      expect(rest.dialer).toMatchObject({
        scheduleEnabled: true,
        campaigns: ['Sales', 'Support'],
        dailyLimit: 500,
      });

      // Out of bounds, or not an admin: refused.
      expect(
        await admin.fails(
          `mutation { updateSettings(input: { dialer: { dailyLimit: 0 } }) { autoTranscribe } }`,
        ),
      ).toBe('invalid');
      expect(
        await member.fails(
          `mutation { updateSettings(input: { autoTranscribe: false }) { autoTranscribe } }`,
        ),
      ).toBe('forbidden');

      // Nothing changed: no event, no audit entry.
      const before = h.published('likho.settings.changed').length;
      await admin.ok(
        `mutation { updateSettings(input: { dialer: { dailyLimit: 500 } }) { autoTranscribe } }`,
      );
      expect(h.published('likho.settings.changed').length).toBe(before);

      await admin.ok(
        `mutation { updateSettings(input: { dialer: { scheduleEnabled: false, campaigns: [], dailyLimit: 200 } }) { autoTranscribe } }`,
      );
    });
  });

  describe('the dialer’s calls', () => {
    const since = '2026-10-02T00:00:00.000Z';
    const until2 = '2026-10-03T00:00:00.000Z';

    it('lists the campaigns, the agents and the calls of a window, and marks the calls Likho has', async () => {
      const member = await signInMember();
      const crt = `crt-${Date.now()}`;
      h.dialer.calls = [
        {
          crtObjectId: crt,
          callId: 'c1',
          callTime: '2026-10-02T05:00:00.000Z',
          campaign: 'Sales',
          agent: 'asha',
          agentId: 'u1',
          connected: true,
          talkSeconds: 120,
        },
        {
          crtObjectId: `${crt}-2`,
          callId: 'c2',
          callTime: '2026-10-02T06:00:00.000Z',
          campaign: 'Sales',
          agent: 'ravi',
          agentId: 'u2',
          connected: true,
          talkSeconds: 40,
        },
        {
          crtObjectId: `${crt}-3`,
          callId: 'c3',
          callTime: '2026-10-02T07:00:00.000Z',
          campaign: 'Support',
          agent: 'asha',
          agentId: 'u1',
          connected: false,
          talkSeconds: 0,
        },
      ];
      await admin.ok(REQUEST_UPLOAD, { input: { originalName: 'had.mp3', sizeBytes: 10, externalId: crt } });

      const { dialerCampaigns } = await member.ok(
        `query ($s: DateTime!, $u: DateTime!) { dialerCampaigns(since: $s, until: $u) { name calls connected interactions talkSeconds } }`,
        { s: since, u: until2 },
      );
      expect(dialerCampaigns).toEqual([
        { name: 'Sales', calls: 2, connected: 2, interactions: 2, talkSeconds: 160 },
        { name: 'Support', calls: 1, connected: 0, interactions: 1, talkSeconds: 0 },
      ]);
      const { dialerAgents } = await member.ok(
        `query ($s: DateTime!, $u: DateTime!) { dialerAgents(since: $s, until: $u, campaign: "Sales") { id name calls } }`,
        { s: since, u: until2 },
      );
      expect(dialerAgents.map((a: { name: string }) => a.name).sort()).toEqual(['asha', 'ravi']);

      const { dialerCalls } = await member.ok(
        `query ($f: DialerCallsFilter!) { dialerCalls(filter: $f, first: 1) { items { crtObjectId agent talkSeconds recordingId recordingStatus } nextCursor } }`,
        { f: { since, until: until2, campaign: 'Sales' } },
      );
      expect(dialerCalls.items).toEqual([
        { crtObjectId: `${crt}-2`, agent: 'ravi', talkSeconds: 40, recordingId: null, recordingStatus: null },
      ]);
      expect(dialerCalls.nextCursor).toBe('1');
      const next = await member.ok(
        `query ($f: DialerCallsFilter!, $a: String) { dialerCalls(filter: $f, first: 1, after: $a) { items { crtObjectId recordingId recordingStatus } nextCursor } }`,
        { f: { since, until: until2, campaign: 'Sales' }, a: '1' },
      );
      expect(next.dialerCalls.items[0].crtObjectId).toBe(crt);
      expect(next.dialerCalls.items[0].recordingId).toMatch(/^rec_/);
      expect(next.dialerCalls.nextCursor).toBeNull();

      // Over REST, with connectedOnly=false the call that did not connect is there too.
      const rest = await (
        await fetch(`${h.url}/api/v1/dialer/calls?since=${since}&until=${until2}&connectedOnly=false`, {
          headers: { cookie: member.cookie },
        })
      ).json();
      expect(rest.items).toHaveLength(3);
      const status = await member.ok(
        `{ dialerStatus { databaseConfigured importedToday dailyLimit version archiveEnabled } }`,
      );
      expect(status.dialerStatus).toEqual({
        databaseConfigured: true,
        importedToday: 3,
        dailyLimit: 200,
        version: '0.4.0',
        archiveEnabled: true,
      });

      // Several calls fetched at once.
      const { requestImports } = await member.ok(
        `mutation ($ids: [String!]!) { requestImports(externalIds: $ids) { id externalId status } }`,
        { ids: [`${crt}-2`, `${crt}-3`, `${crt}-2`] },
      );
      expect(requestImports.map((i: { externalId: string }) => i.externalId)).toEqual([
        `${crt}-2`,
        `${crt}-3`,
      ]);

      // A window the wrong way round is refused here; a connector that does not answer says so.
      expect(
        await member.fails(
          `{ dialerCampaigns(since: "2026-10-03T00:00:00Z", until: "2026-10-02T00:00:00Z") { name } }`,
        ),
      ).toBe('invalid');
      h.dialer.down = true;
      expect(await member.fails(`{ dialerStatus { version } }`)).toBe('service_unavailable');
      h.dialer.down = false;
    });

    it('an admin sees whether every service answers', async () => {
      const member = await signInMember();
      const { systemStatus } = await admin.ok(`{ systemStatus { version services { name ok detail } } }`);
      const byName = Object.fromEntries(systemStatus.services.map((s: { name: string }) => [s.name, s]));
      expect(Object.keys(byName).sort()).toEqual([
        'likho-analytics',
        'likho-connector-ameyo',
        'likho-insights',
        'likho-language',
        'likho-media',
        'likho-search',
        'likho-transcription',
      ]);
      expect(byName['likho-connector-ameyo'].ok).toBe(true);
      expect(byName['likho-connector-ameyo'].detail).toContain('0.4.0');
      h.dialer.down = true;
      const again = await admin.ok(`{ systemStatus { services { name ok } } }`);
      expect(
        again.systemStatus.services.find((s: { name: string }) => s.name === 'likho-connector-ameyo').ok,
      ).toBe(false);
      h.dialer.down = false;
      expect(await member.fails(`{ systemStatus { version } }`)).toBe('forbidden');
    });
  });

  describe('a token for another system’s browser', () => {
    it('an API key exchanges itself for a short-lived viewer token; a portal reads the transcript with it', async () => {
      const { createApiKey } = await admin.ok(`mutation { createApiKey(name: "reports portal") { id key } }`);
      const key: string = createApiKey.key;
      const crt = `crt-${Date.now()}`;
      const { requestUpload } = await admin.ok(REQUEST_UPLOAD, {
        input: { originalName: 'portal.mp3', sizeBytes: 10, externalId: crt },
      });
      const id: string = requestUpload.recording.id;
      const exchange = `${h.url}/api/v1/tokens/exchange`;
      const post = (auth: Record<string, string>, body: unknown) =>
        fetch(exchange, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const exchanged = await post(
        { authorization: `Bearer ${key}` },
        { subject: 'auditor 12', ttlSeconds: 600 },
      );
      expect(exchanged.status).toBe(200);
      const { token, expiresAt } = await exchanged.json();
      expect(token).toMatch(/^lt_/);
      expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(500_000);

      // The token reads the workspace's recordings, by the dialer's id too.
      const asToken = async (query: string, variables: Record<string, unknown> = {}) =>
        (
          await fetch(`${h.url}/graphql`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ query, variables }),
          })
        ).json();
      const found = await asToken(
        `query ($externalId: String!) { recordings(filter: { externalId: $externalId }) { items { id externalId originalName } } }`,
        { externalId: crt },
      );
      expect(found.data.recordings.items).toEqual([{ id, externalId: crt, originalName: 'portal.mp3' }]);
      const one = await asToken(`query ($id: String!) { recording(id: $id) { id status } }`, { id });
      expect(one.data.recording.id).toBe(id);
      const me = await asToken(`{ me { name role } }`);
      expect(me.data.me).toEqual({ name: 'auditor 12 (reports portal)', role: 'viewer' });

      // It reads and nothing more; neither it nor a session makes tokens; a made-up token is nobody.
      const refused = await asToken(
        `mutation { requestUpload(input: { originalName: "x.mp3", sizeBytes: 1 }) { recording { id } } }`,
      );
      expect(refused.errors[0].extensions.code).toBe('forbidden');
      expect((await post({ authorization: `Bearer ${token}` }, {})).status).toBe(403);
      expect((await post({ cookie: admin.cookie }, {})).status).toBe(403);
      expect((await post({ authorization: `Bearer ${key}` }, { ttlSeconds: 5 })).status).toBe(400);
      const nobody = await fetch(`${h.url}/api/v1/recordings`, {
        headers: { authorization: 'Bearer lt_nonsense' },
      });
      expect(nobody.status).toBe(401);

      // Over REST too, by the dialer's id.
      const rest = await (
        await fetch(`${h.url}/api/v1/recordings?externalId=${crt}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json();
      expect(rest.items.map((r: { id: string }) => r.id)).toEqual([id]);
    });
  });

  describe('the numbers behind the calls', () => {
    const since = '2026-10-01T00:00:00.000Z';
    const until = '2026-10-03T00:00:00.000Z';

    it('answers an overview, a timeseries and a breakdown for the workspace and the window asked', async () => {
      const { me } = await admin.ok(`{ me { workspace { id } } }`);
      const { analyticsOverview } = await admin.ok(
        `query ($since: DateTime!, $until: DateTime!) {
          analyticsOverview(since: $since, until: $until, facts: { campaign: "sale" }) {
            calls transcribed failed minutes realtimeFactor analysed score sentiments { key count } languages { key count }
          }
        }`,
        { since, until },
      );
      expect(analyticsOverview).toEqual({
        calls: 12,
        transcribed: 10,
        failed: 1,
        minutes: 25.5,
        realtimeFactor: 0.9,
        analysed: 4,
        score: 0.75,
        sentiments: [
          { key: 'positive', count: 3 },
          { key: 'negative', count: 1 },
        ],
        languages: [
          { key: 'hi', count: 8 },
          { key: 'ur', count: 2 },
        ],
      });
      expect(h.analytics.asked.at(-1)).toEqual({
        method: 'overview',
        workspaceId: me.workspace.id,
        since: new Date(since),
        until: new Date(until),
        facts: { campaign: 'sale' },
      });

      const { analyticsTimeseries } = await admin.ok(
        `query ($since: DateTime!, $until: DateTime!) {
          analyticsTimeseries(metric: minutes, bucket: hour, since: $since, until: $until) { at value }
        }`,
        { since, until },
      );
      expect(analyticsTimeseries).toEqual([
        { at: since, value: 5 },
        { at: '2026-10-02T00:00:00.000Z', value: 7 },
      ]);
      expect(h.analytics.asked.at(-1)).toMatchObject({
        method: 'timeseries',
        metric: Metric.MINUTES,
        bucket: Bucket.HOUR,
      });

      const { analyticsBreakdown } = await admin.ok(
        `query ($since: DateTime!, $until: DateTime!) {
          analyticsBreakdown(by: agent, since: $since, until: $until, limit: 10) {
            key calls transcribed minutes analysed score negative
          }
        }`,
        { since, until },
      );
      expect(analyticsBreakdown[0]).toEqual({
        key: 'asha',
        calls: 7,
        transcribed: 7,
        minutes: 15,
        analysed: 3,
        score: 0.8,
        negative: 1,
      });
      expect(h.analytics.asked.at(-1)).toMatchObject({ method: 'breakdown', by: Dimension.AGENT, limit: 10 });

      // A window that ends before it starts is refused here, not there.
      expect(
        await admin.fails(
          `query { analyticsOverview(since: "2026-10-03T00:00:00Z", until: "2026-10-01T00:00:00Z") { calls } }`,
        ),
      ).toBe('invalid');

      // Over REST too.
      const headers = { cookie: admin.cookie };
      const rest = await (
        await fetch(`${h.url}/api/v1/analytics/overview?since=${since}&until=${until}&agent=asha`, {
          headers,
        })
      ).json();
      expect(rest).toMatchObject({
        calls: 12,
        languages: [
          { key: 'hi', count: 8 },
          { key: 'ur', count: 2 },
        ],
      });
      expect(h.analytics.asked.at(-1)).toMatchObject({ facts: { agent: 'asha' } });
      const series = await (
        await fetch(`${h.url}/api/v1/analytics/timeseries?since=${since}&until=${until}&metric=calls`, {
          headers,
        })
      ).json();
      expect(series.points).toEqual([
        { at: since, value: 5 },
        { at: '2026-10-02T00:00:00.000Z', value: 7 },
      ]);
      const rows = await (
        await fetch(`${h.url}/api/v1/analytics/breakdown?since=${since}&until=${until}&by=campaign&limit=5`, {
          headers,
        })
      ).json();
      expect(rows.rows).toHaveLength(2);
      expect(h.analytics.asked.at(-1)).toMatchObject({ by: Dimension.CAMPAIGN, limit: 5 });
      const bad = await fetch(`${h.url}/api/v1/analytics/breakdown?since=${since}&until=${until}&by=colour`, {
        headers,
      });
      expect(bad.status).toBe(400);
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
        'glossary.imported',
        'spelling.added',
        'spelling.imported',
        'insights.requested',
        'token.exchanged',
        'spelling.deleted',
        'search.saved',
        'search.deleted',
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
      const accepted = auditLog.items.find(
        (e: any) => e.action === 'invitation.accepted' && e.actorName === 'Vee Viewer',
      );
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
