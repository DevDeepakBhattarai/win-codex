import 'dotenv/config';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildPrompt, nightlyConfigSchema } from '../dist/nightly-pr.js';

const directory = path.resolve(process.env.DATA_DIR ?? '.data');
const command = process.argv[2] ?? 'status';
if (!['status', 'preview', 'tick', 'dismiss-started'].includes(command)) throw new Error('Use status, preview, tick, or dismiss-started.');
if (command === 'preview') {
	const config = nightlyConfigSchema.parse(JSON.parse(await readFile(path.join(directory, 'nightly-pr/config.json'), 'utf8')));
	const { stdout } = await promisify(execFile)('gh', ['api', '--paginate', '--slurp', `repos/${config.repository}/pulls?state=open&per_page=100`], { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	const prs = JSON.parse(stdout).flat();
	console.log(`Open PRs: ${prs.map(pr => `#${pr.number}`).join(', ')}`);
	if (prs[0]) {
		const pr = prs[0];
		console.log(buildPrompt(config, { id: randomUUID(), number: pr.number, headRefOid: pr.head.sha, baseRefOid: pr.base.sha }, path.join(directory, 'nightly-pr/example-result.json')));
	}
} else {
	const token = (await readFile(path.join(directory, 'support-extension-token'), 'utf8')).trim();
	const response = await fetch(`http://127.0.0.1:${process.env.THREAD_SYNC_PORT ?? 6002}/chatgpt-support/nightly-pr${command === 'status' ? '' : `/${command}`}`, {
		method: command === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(command === 'dismiss-started' ? 15 * 60_000 : 10_000),
	});
	if (!response.ok) throw new Error(`Connector returned HTTP ${response.status}. Rebuild and restart it after configuring nightly PRs.`);
	console.log(JSON.stringify(await response.json(), null, 2));
}
