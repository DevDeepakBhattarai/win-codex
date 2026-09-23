import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NightlyPrScheduler, localSchedule, saveJson } from '../dist/nightly-pr.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const config = { enabled: true, repository: 'owner/repo', workspace: process.cwd(), timeZone: 'Asia/Kathmandu', hour: 2, maxActive: 2, startDate: '2026-09-21' };
const due = new Date('2026-09-20T20:15:00Z');
const tomorrow = new Date('2026-09-21T20:15:00Z');
async function setup(overrides = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), 'nightly-pr-test-'));
	const calls = { start: 0, resume: 0, active: 0, stop: 0, dismiss: 0 };
	const prs = [{ number: 1, headRefOid: head, baseRefOid: base }];
	const deps = {
		list: async () => prs,
		checksPass: async () => true,
		start: async () => { calls.start++; return 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc'; },
		resume: async () => { calls.resume++; },
		activate: async () => { calls.active++; },
		stop: async () => { calls.stop++; },
		dismiss: async () => { calls.dismiss++; },
		isActive: async () => true,
		...overrides,
	};
	return { directory, calls, prs, deps, scheduler: await NightlyPrScheduler.open(directory, config, deps) };
}
async function report(context, status = 'complete', changes = {}) {
	const job = context.scheduler.status().jobs[0];
	const evidencePath = path.join(context.directory, 'evidence.md');
	await writeFile(evidencePath, 'Executed test evidence and review.');
	await saveJson(path.join(context.directory, 'jobs', job.id, 'result.json'), status === 'blocked'
		? { jobId: job.id, status, reason: 'Test account unavailable' }
		: { jobId: job.id, status, headSha: head, baseSha: base, evidencePath,
			checks: [{ command: 'pnpm test', exitCode: 0 }], browser: { status: 'passed', evidence: 'screenshot.png' }, review: 'review.md', ...changes });
}

test('2 a.m. Nepal boundary and installation date', async () => {
	assert.deepEqual(localSchedule(due, config), { date: '2026-09-21', due: true });
	assert.equal(localSchedule(new Date(due.getTime() - 1000), config).due, false);
	const c = await setup();
	await c.scheduler.tick(new Date('2026-09-20T16:00:00Z'));
	await c.scheduler.tick(new Date(due.getTime() - 1000));
	assert.equal(c.calls.start, 0);
	await c.scheduler.tick(due);
	assert.equal(c.calls.start, 1);
});
test('concurrent ticks and restart do not duplicate active jobs', async () => {
	const c = await setup();
	await Promise.all([c.scheduler.tick(due), c.scheduler.tick(due)]);
	const restarted = await NightlyPrScheduler.open(c.directory, config, c.deps);
	await restarted.tick(tomorrow);
	assert.equal(c.calls.start, 1);
	assert.equal(c.calls.active, 1);
});
test('success skips unchanged PRs but new head and base are eligible', async () => {
	const c = await setup();
	await c.scheduler.tick(due);
	await report(c);
	await c.scheduler.tick(due);
	assert.equal(c.scheduler.status().jobs[0].state, 'complete');
	await c.scheduler.tick(tomorrow);
	assert.equal(c.calls.start, 1);
	c.prs[0].baseRefOid = 'c'.repeat(40);
	await c.scheduler.tick(new Date('2026-09-22T20:15:00Z'));
	assert.equal(c.calls.start, 2);
});
test('failed CI rejects completion and resumes same thread next day', async () => {
	const c = await setup({ checksPass: async () => false });
	await c.scheduler.tick(due);
	await report(c);
	await c.scheduler.tick(due);
	assert.equal(c.scheduler.status().jobs[0].state, 'blocked');
	assert.match(c.scheduler.status().jobs[0].error, /CI has not passed/);
	await c.scheduler.tick(tomorrow);
	assert.equal(c.calls.start, 1);
	assert.equal(c.calls.resume, 1);
	assert.equal(c.scheduler.status().jobs[0].state, 'active');
});
test('changed remote SHA and wrong job report cannot complete', async () => {
	for (const changes of [{ headSha: 'c'.repeat(40) }, { jobId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }]) {
		const c = await setup();
		await c.scheduler.tick(due);
		await report(c, 'complete', changes);
		await c.scheduler.tick(due);
		assert.equal(c.scheduler.status().jobs[0].state, 'blocked');
	}
});
test('ambiguous creation is persisted and never blindly retried', async () => {
	let attempts = 0;
	const c = await setup({ start: async () => { attempts++; throw new Error('timeout after send'); } });
	await c.scheduler.tick(due);
	const restarted = await NightlyPrScheduler.open(c.directory, config, c.deps);
	await restarted.tick(tomorrow);
	assert.equal(attempts, 1);
	assert.equal(restarted.status().jobs[0].state, 'uncertain');
});
test('crash during creation retains reservation', async () => {
	const c = await setup();
	await c.scheduler.tick(due);
	const state = JSON.parse(await readFile(path.join(c.directory, 'state.json'), 'utf8'));
	state.jobs[0].state = 'starting';
	delete state.jobs[0].conversationUrl;
	await saveJson(path.join(c.directory, 'state.json'), state);
	const restarted = await NightlyPrScheduler.open(c.directory, config, c.deps);
	await restarted.tick(tomorrow);
	assert.equal(restarted.status().jobs[0].state, 'uncertain');
	assert.equal(c.calls.start, 1);
});
test('crash after the URL is saved retains its slot and never resends automatically', async () => {
	const c = await setup();
	await c.scheduler.tick(due);
	const state = JSON.parse(await readFile(path.join(c.directory, 'state.json'), 'utf8'));
	state.jobs[0].state = 'starting';
	c.prs.push({ number: 2, headRefOid: head, baseRefOid: base });
	await saveJson(path.join(c.directory, 'state.json'), state);
	const restarted = await NightlyPrScheduler.open(c.directory, { ...config, maxActive: 1 }, c.deps);
	await restarted.tick(due);
	await restarted.tick(tomorrow);
	assert.equal(restarted.status().jobs[0].state, 'uncertain');
	assert.equal(restarted.status().jobs[1].state, 'queued');
	assert.equal(c.calls.start, 1);
	assert.equal(c.calls.resume, 0);
});
test('concurrency cap queues remaining PRs and fills freed slots', async () => {
	const c = await setup();
	c.prs.push({ number: 2, headRefOid: head, baseRefOid: base }, { number: 3, headRefOid: head, baseRefOid: base });
	await c.scheduler.tick(due);
	assert.equal(c.calls.start, 2);
	assert.equal(c.scheduler.status().jobs[2].state, 'queued');
	await report(c);
	await c.scheduler.tick(due);
	assert.equal(c.calls.start, 3);
});
test('GitHub failure retries without consuming the daily scan', async () => {
	let fail = true;
	const c = await setup({ list: async () => { if (fail) throw new Error('offline'); return []; } });
	await assert.rejects(c.scheduler.tick(due), /offline/);
	assert.equal(c.scheduler.status().lastScanDate, undefined);
	fail = false;
	await c.scheduler.tick(due);
	assert.equal(c.scheduler.status().lastScanDate, '2026-09-21');
});
test('RALPH completion without a report is a blocker, not a pass or stuck active job', async () => {
	const c = await setup({ isActive: async () => false });
	await c.scheduler.tick(due);
	await c.scheduler.tick(due);
	assert.equal(c.scheduler.status().jobs[0].state, 'blocked');
	assert.match(c.scheduler.status().jobs[0].error, /without a result report/);
});
test('closing started runs preserves queued work and suppresses unchanged PRs', async () => {
	const c = await setup();
	c.prs.push({ number: 2, headRefOid: head, baseRefOid: base }, { number: 3, headRefOid: head, baseRefOid: base });
	await c.scheduler.tick(due);
	const result = await c.scheduler.dismissStarted();
	assert.deepEqual(result, { dismissed: 2, failed: [] });
	assert.equal(c.calls.dismiss, 2);
	assert.deepEqual(c.scheduler.status().jobs.map(job => job.state), ['dismissed', 'dismissed', 'queued']);
	await c.scheduler.tick(tomorrow);
	assert.equal(c.calls.start, 3);
	assert.equal(c.scheduler.status().jobs.length, 3);
	c.prs[0].headRefOid = 'c'.repeat(40);
	await c.scheduler.tick(new Date('2026-09-22T20:15:00Z'));
	assert.equal(c.scheduler.status().jobs.length, 4);
	assert.equal(c.calls.start, 4);
});
