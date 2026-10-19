import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planParts, AdaptiveLimiter, downloadInParts } from '../partedDownload.js';

const CHUNK = 16;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parts-test-'));
const finalPath = path.join(root, 'file.bin');
const workDir = path.join(root, '.parts', 'file.bin');

beforeEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const randomDelay = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));

// A fake Telegram serving `source`, recording every requested offset; can be told to fail at an offset.
const fakeSource = (source, { failAt = null, shortAt = null } = {}) => {
	const requested = [];
	let inFlight = 0;
	let maxInFlight = 0;
	return {
		requested,
		maxInFlight: () => maxInFlight,
		fetchChunk: async (offset) => {
			requested.push(offset);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await randomDelay();
			inFlight--;
			if (offset === failAt) throw new Error(`network down at ${offset}`);
			const chunk = Buffer.from(source.subarray(offset, offset + CHUNK));
			return offset === shortAt ? chunk.subarray(0, 2) : chunk;
		},
	};
};

const run = (source, fake, overrides = {}) => downloadInParts({
	finalPath,
	workDir,
	fileKey: 'doc1',
	totalSize: source.length,
	chunkSize: CHUNK,
	partCount: 4,
	fetchChunk: fake.fetchChunk,
	...overrides,
});

const partSizes = () => fs.readdirSync(workDir).filter((f) => f.startsWith('part-')).sort().map((f) => fs.statSync(path.join(workDir, f)).size);

describe('planParts', () => {
	test('splits into chunk-aligned contiguous ranges covering the whole file', () => {
		const parts = planParts(CHUNK * 10 + 5, CHUNK, 4);
		assert.deepEqual(parts.map((p) => [p.start, p.end]), [[0, 48], [48, 96], [96, 144], [144, 165]]);
		for (const part of parts.slice(0, -1)) assert.equal(part.end % CHUNK, 0);
	});

	test('never creates more parts than chunks', () => {
		assert.equal(planParts(CHUNK * 2, CHUNK, 8).length, 2);
		assert.deepEqual(planParts(5, CHUNK, 8), [{ index: 0, start: 0, end: 5 }]);
		assert.deepEqual(planParts(0, CHUNK, 8), []);
	});

	test('balances parts within one chunk of each other', () => {
		const sizes = planParts(CHUNK * 1000, CHUNK, 7).map((p) => (p.end - p.start) / CHUNK);
		assert.equal(sizes.reduce((a, b) => a + b), 1000);
		assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
	});
});

describe('AdaptiveLimiter', () => {
	test('caps concurrency at the limit', async () => {
		const limiter = new AdaptiveLimiter({ max: 3 });
		let active = 0;
		let peak = 0;
		await Promise.all(Array.from({ length: 20 }, async () => {
			await limiter.acquire();
			active++;
			peak = Math.max(peak, active);
			await randomDelay();
			active--;
			limiter.release();
		}));
		assert.equal(peak, 3);
	});

	test('halves on a flood wait, once per flood event, and pauses everyone', () => {
		let now = 1000;
		const limiter = new AdaptiveLimiter({ max: 8, now: () => now });
		const grantedBefore = now;
		now = 2000;
		assert.deepEqual(limiter.onFlood(5, grantedBefore), { reduced: true, limit: 4, pausedFor: 5 });
		// Other requests that were already in flight report the same flood: no further halving.
		assert.equal(limiter.onFlood(5, grantedBefore).reduced, false);
		assert.equal(limiter.limit, 4);
		assert.equal(limiter.pausedUntil, 7000);
		// A request granted after the reduction that still floods halves again.
		assert.equal(limiter.onFlood(1, 2500).limit, 2);
	});

	test('never drops below one and ramps back up after a success streak', () => {
		const limiter = new AdaptiveLimiter({ max: 4, increaseAfter: 3 });
		limiter.onFlood(0, Infinity);
		limiter.onFlood(0, Infinity);
		limiter.onFlood(0, Infinity);
		assert.equal(limiter.limit, 1);
		for (let i = 0; i < 3; i++) limiter.onSuccess();
		assert.equal(limiter.limit, 2);
		for (let i = 0; i < 100; i++) limiter.onSuccess();
		assert.equal(limiter.limit, 4, 'capped at max');
	});

	test('waits out a pause before granting slots', async () => {
		let now = 0;
		const waits = [];
		const limiter = new AdaptiveLimiter({ max: 2, now: () => now, wait: async (ms) => { waits.push(ms); now += ms; } });
		limiter.onFlood(3, 0);
		await limiter.acquire();
		assert.deepEqual(waits, [3000]);
	});
});

describe('downloadInParts', () => {
	test('downloads parts in parallel and merges them into the exact file', async () => {
		const source = crypto.randomBytes(CHUNK * 37 + 9);
		const fake = fakeSource(source);
		const progress = [];
		const result = await run(source, fake, { onProgress: (done) => progress.push(done) });

		assert.equal(result.parts, 4);
		assert.ok(fs.readFileSync(finalPath).equals(source));
		assert.ok(!fs.existsSync(workDir), 'work directory is cleaned up');
		assert.equal(fake.requested.length, 38, 'every chunk requested exactly once');
		assert.equal(new Set(fake.requested).size, 38);
		assert.ok(fake.maxInFlight() > 1, 'parts run in parallel');
		assert.ok(fake.maxInFlight() <= 4);
		assert.equal(progress.at(-1), source.length);
	});

	test('resumes after an interruption without re-downloading finished chunks', async () => {
		const source = crypto.randomBytes(CHUNK * 40);
		const first = fakeSource(source, { failAt: CHUNK * 25 });
		await assert.rejects(run(source, first), /network down/);

		assert.ok(!fs.existsSync(finalPath), 'no final file until everything is merged');
		const onDisk = partSizes().reduce((a, b) => a + b, 0);
		assert.ok(onDisk > 0);

		const second = fakeSource(source);
		let resumedBytes;
		await run(source, second, { onStart: (info) => { resumedBytes = info.resumedBytes; } });

		assert.equal(resumedBytes, onDisk);
		assert.ok(fs.readFileSync(finalPath).equals(source));
		const firstDone = new Set(first.requested.filter((o) => o !== CHUNK * 25));
		const refetched = second.requested.filter((offset) => firstDone.has(offset) && offset < onDisk);
		assert.equal(second.requested.length * CHUNK + onDisk, source.length, 'only the missing chunks are fetched');
		assert.ok(refetched.length <= 4, 'at most the in-flight chunk per part is repeated');
	});

	test('drops a torn (partially written) chunk on resume', async () => {
		const source = crypto.randomBytes(CHUNK * 8);
		await assert.rejects(run(source, fakeSource(source, { failAt: CHUNK * 7 })));

		// Simulate a crash in the middle of writing a chunk: garbage half-chunk appended to part 0.
		const part0 = path.join(workDir, 'part-000');
		fs.appendFileSync(part0, Buffer.alloc(CHUNK / 2, 0xee));

		await run(source, fakeSource(source));
		assert.ok(fs.readFileSync(finalPath).equals(source));
	});

	test('keeps the original layout when the part count changes between runs', async () => {
		const source = crypto.randomBytes(CHUNK * 24);
		await assert.rejects(run(source, fakeSource(source, { failAt: CHUNK * 20 }), { partCount: 4 }));
		const sizesBefore = partSizes();

		const second = fakeSource(source);
		await run(source, second, { partCount: 12 });
		assert.ok(fs.readFileSync(finalPath).equals(source));
		assert.equal(second.requested.length * CHUNK, source.length - sizesBefore.reduce((a, b) => a + b, 0));
	});

	test('starts over if the manifest belongs to a different file', async () => {
		const source = crypto.randomBytes(CHUNK * 8);
		await assert.rejects(run(source, fakeSource(source, { failAt: CHUNK * 6 }), { fileKey: 'old-doc' }));

		const fake = fakeSource(source);
		await run(source, fake, { fileKey: 'new-doc' });
		assert.equal(fake.requested.length, 8);
		assert.ok(fs.readFileSync(finalPath).equals(source));
	});

	test('resumes an interrupted merge from its checkpoint', async () => {
		const source = crypto.randomBytes(CHUNK * 12 + 3);
		const parts = planParts(source.length, CHUNK, 4);
		fs.mkdirSync(workDir, { recursive: true });

		// State after a crash: parts 0-1 merged and checkpointed, part 2 half-appended, parts 2-3 still on disk.
		fs.writeFileSync(path.join(workDir, 'part-000'), Buffer.concat([source.subarray(0, parts[1].end), Buffer.alloc(7, 0xaa)]));
		fs.writeFileSync(path.join(workDir, 'part-002'), source.subarray(parts[2].start, parts[2].end));
		fs.writeFileSync(path.join(workDir, 'part-003'), source.subarray(parts[3].start, parts[3].end));
		fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify({
			version: 1, fileKey: 'doc1', totalSize: source.length, chunkSize: CHUNK, parts, merged: 2,
		}));

		const fake = fakeSource(source);
		let merging;
		await run(source, fake, { onStart: (info) => { merging = info.merging; } });
		assert.equal(merging, true);
		assert.equal(fake.requested.length, 0, 'nothing is downloaded again');
		assert.ok(fs.readFileSync(finalPath).equals(source));
	});

	test('imports a partial file from the old single-stream downloader', async () => {
		const source = crypto.randomBytes(CHUNK * 20);
		fs.writeFileSync(finalPath, Buffer.concat([source.subarray(0, CHUNK * 9), Buffer.alloc(5, 0xff)]));

		const fake = fakeSource(source);
		let resumedBytes;
		await run(source, fake, { onStart: (info) => { resumedBytes = info.resumedBytes; } });

		assert.equal(resumedBytes, CHUNK * 9);
		assert.equal(fake.requested.length, 11);
		assert.ok(fake.requested.every((offset) => offset >= CHUNK * 9));
		assert.ok(fs.readFileSync(finalPath).equals(source));
	});

	test('a short chunk fails the download and is not written', async () => {
		const source = crypto.randomBytes(CHUNK * 8);
		await assert.rejects(run(source, fakeSource(source, { shortAt: CHUNK * 2 })), /Expected 16 bytes at offset 32 but Telegram returned 2/);
		assert.ok(partSizes().every((size) => size % CHUNK === 0));
	});

	test('handles empty and single-chunk files', async () => {
		await run(Buffer.alloc(0), fakeSource(Buffer.alloc(0)));
		assert.equal(fs.statSync(finalPath).size, 0);

		fs.rmSync(finalPath);
		const tiny = crypto.randomBytes(5);
		const fake = fakeSource(tiny);
		const result = await run(tiny, fake);
		assert.equal(result.parts, 1);
		assert.ok(fs.readFileSync(finalPath).equals(tiny));
	});
});
