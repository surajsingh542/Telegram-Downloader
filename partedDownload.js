import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_VERSION = 1;
const MERGE_BUFFER_SIZE = 8 * 1024 * 1024;

/**
 * Splits a file into `partCount` contiguous byte ranges whose boundaries are multiples of `chunkSize`
 * (Telegram only accepts chunk-aligned offsets). Small files get fewer parts: never more parts than chunks.
 * Returns [{ index, start, end }] with `end` exclusive.
 */
export const planParts = (totalSize, chunkSize, partCount) => {
	const totalChunks = Math.ceil(totalSize / chunkSize);
	const count = Math.max(0, Math.min(partCount, totalChunks));
	if (count === 0) return [];

	const baseChunks = Math.floor(totalChunks / count);
	const extraChunks = totalChunks % count;
	const parts = [];
	let chunkCursor = 0;

	for (let index = 0; index < count; index++) {
		const chunks = baseChunks + (index < extraChunks ? 1 : 0);
		const start = chunkCursor * chunkSize;
		chunkCursor += chunks;
		parts.push({ index, start, end: Math.min(chunkCursor * chunkSize, totalSize) });
	}
	return parts;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Concurrency limiter that backs off when Telegram says "slow down" (FLOOD_WAIT) and slowly ramps back up.
 * Additive increase / multiplicative decrease, like TCP congestion control: on a flood wait everyone pauses
 * and the parallelism halves; after `increaseAfter` successful requests in a row it grows by one again.
 * It is shared by all downloads in the session, so the next file starts at the level that was found to be safe.
 */
export class AdaptiveLimiter {
	constructor({ max, increaseAfter = 32, now = () => Date.now(), wait = sleep } = {}) {
		this.max = max;
		this.limit = max;
		this.increaseAfter = increaseAfter;
		this.active = 0;
		this.waiters = [];
		this.pausedUntil = 0;
		this.lastReductionAt = -Infinity;
		this.successStreak = 0;
		this.now = now;
		this.wait = wait;
	}

	// Raising the configured maximum (e.g. more parts for a new download) keeps the learned limit if it is lower.
	setMax(max) {
		this.max = max;
		this.limit = Math.min(this.limit, max);
		if (this.limit < 1) this.limit = 1;
		this.wakeAll();
	}

	wakeAll() {
		const waiters = this.waiters;
		this.waiters = [];
		for (const wake of waiters) wake();
	}

	// Resolves with the time the slot was granted (used to tell whether a later flood error is "new").
	async acquire() {
		while (true) {
			const pause = this.pausedUntil - this.now();
			if (pause > 0) {
				await this.wait(pause);
				continue;
			}
			if (this.active < this.limit) {
				this.active++;
				return this.now();
			}
			await new Promise((resolve) => this.waiters.push(resolve));
		}
	}

	release() {
		this.active--;
		this.wakeAll();
	}

	onSuccess() {
		if (this.limit >= this.max) return;
		this.successStreak++;
		if (this.successStreak >= this.increaseAfter) {
			this.limit++;
			this.successStreak = 0;
			this.wakeAll();
		}
	}

	/**
	 * Records a FLOOD_WAIT. `requestStartedAt` prevents several in-flight requests rejected for the same
	 * reason from halving the limit several times. Returns { reduced, limit, pausedFor }.
	 */
	onFlood(waitSeconds, requestStartedAt) {
		this.pausedUntil = Math.max(this.pausedUntil, this.now() + waitSeconds * 1000);
		this.successStreak = 0;

		let reduced = false;
		if (requestStartedAt >= this.lastReductionAt && this.limit > 1) {
			this.limit = Math.max(1, Math.floor(this.limit / 2));
			this.lastReductionAt = this.now();
			reduced = true;
		}
		return { reduced, limit: this.limit, pausedFor: waitSeconds };
	}
}

const partFileName = (index) => `part-${String(index).padStart(3, '0')}`;

const fileSize = (filePath) => (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);

const writeManifest = (workDir, manifest) => {
	const target = path.join(workDir, 'manifest.json');
	const temp = `${target}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(manifest, null, '\t'));
	fs.renameSync(temp, target);
};

const readManifest = (workDir) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(workDir, 'manifest.json'), 'utf8'));
	} catch {
		return null;
	}
};

const copyRange = (sourceFd, targetFd, sourceStart, length, targetStart) => {
	const buffer = Buffer.allocUnsafe(Math.min(MERGE_BUFFER_SIZE, Math.max(length, 1)));
	let copied = 0;
	while (copied < length) {
		const read = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, length - copied), sourceStart + copied);
		if (read === 0) throw new Error('Unexpected end of file while copying.');
		fs.writeSync(targetFd, buffer, 0, read, targetStart + copied);
		copied += read;
	}
};

/**
 * Splits a partial file left by the previous single-stream downloader (a valid prefix of the real file)
 * into the new part files, so that progress is not lost after upgrading.
 */
const importLegacyPartial = (legacyPath, workDir, parts, chunkSize) => {
	const usable = Math.floor(fileSize(legacyPath) / chunkSize) * chunkSize;
	if (usable === 0) return 0;

	const legacyFd = fs.openSync(legacyPath, 'r');
	try {
		for (const part of parts) {
			const length = Math.min(part.end, usable) - part.start;
			if (length <= 0) break;
			const partFd = fs.openSync(path.join(workDir, partFileName(part.index)), 'w');
			try {
				copyRange(legacyFd, partFd, part.start, length, 0);
				fs.fsyncSync(partFd);
			} finally {
				fs.closeSync(partFd);
			}
		}
	} finally {
		fs.closeSync(legacyFd);
	}
	return usable;
};

// Prepares the work directory: reuses a matching manifest, otherwise starts a fresh plan.
const loadOrCreateManifest = ({ workDir, fileKey, totalSize, chunkSize, partCount, legacyPartialPath }) => {
	const existing = readManifest(workDir);
	if (
		existing?.version === MANIFEST_VERSION
		&& existing.fileKey === fileKey
		&& existing.totalSize === totalSize
		&& existing.chunkSize === chunkSize
		&& Array.isArray(existing.parts)
	) {
		return { manifest: existing, imported: 0 };
	}

	fs.rmSync(workDir, { recursive: true, force: true });
	fs.mkdirSync(workDir, { recursive: true });

	const parts = planParts(totalSize, chunkSize, partCount);
	let imported = 0;
	if (legacyPartialPath && fs.existsSync(legacyPartialPath)) {
		imported = importLegacyPartial(legacyPartialPath, workDir, parts, chunkSize);
		fs.rmSync(legacyPartialPath, { force: true });
	}

	const manifest = { version: MANIFEST_VERSION, fileKey, totalSize, chunkSize, parts, merged: 1 };
	writeManifest(workDir, manifest);
	return { manifest, imported };
};

/**
 * Reconciliation: appends every part onto part 0 in order, deleting each part once it is safely appended,
 * then atomically renames the result to the final path. Progress is checkpointed in the manifest so an
 * interruption mid-merge resumes cleanly (part 0 is truncated back to the last checkpoint).
 */
const mergeParts = ({ workDir, manifest, finalPath }) => {
	const { parts, totalSize } = manifest;
	const basePath = path.join(workDir, partFileName(0));
	if (!fs.existsSync(basePath)) fs.writeFileSync(basePath, Buffer.alloc(0));

	const baseFd = fs.openSync(basePath, 'r+');
	try {
		let baseSize = parts[manifest.merged - 1]?.end ?? 0;
		fs.ftruncateSync(baseFd, baseSize);

		for (let k = manifest.merged; k < parts.length; k++) {
			const part = parts[k];
			const partPath = path.join(workDir, partFileName(k));
			const length = part.end - part.start;
			if (fileSize(partPath) !== length) throw new Error(`Part ${k} is incomplete; cannot merge.`);

			const partFd = fs.openSync(partPath, 'r');
			try {
				copyRange(partFd, baseFd, 0, length, baseSize);
			} finally {
				fs.closeSync(partFd);
			}
			fs.fsyncSync(baseFd);
			baseSize += length;

			manifest.merged = k + 1;
			writeManifest(workDir, manifest);
			fs.rmSync(partPath, { force: true });
		}
	} finally {
		fs.closeSync(baseFd);
	}

	const mergedSize = fileSize(basePath);
	if (mergedSize !== totalSize) throw new Error(`Merged file is ${mergedSize} bytes, expected ${totalSize}.`);

	fs.renameSync(basePath, finalPath);
	fs.rmSync(workDir, { recursive: true, force: true });
};

/**
 * Downloads a file as several independent parts in parallel, then merges them.
 *
 * - fetchChunk(offset, partIndex, signal) -> Promise<Buffer>   bytes of the file starting at `offset` (one chunk);
 *                                         `signal` aborts once any part has failed, so the others stop retrying
 * - onProgress(bytesDone)                             total bytes on disk across all parts
 * - onStart({ parts, resumedBytes })                  called once the plan is known
 *
 * Each part file only ever grows by whole chunks, written in order and fsynced, so after any interruption
 * (Ctrl+C, crash, power loss) a part's size tells exactly how much of it is done.
 */
export const downloadInParts = async ({
	finalPath,
	workDir,
	fileKey,
	totalSize,
	chunkSize,
	partCount,
	fetchChunk,
	onProgress = () => {},
	onStart = () => {},
	onMergeStart = () => {},
}) => {
	const { manifest } = loadOrCreateManifest({ workDir, fileKey, totalSize, chunkSize, partCount, legacyPartialPath: finalPath });
	const { parts } = manifest;

	// A merge already started in an earlier run means every part was complete.
	const downloadNeeded = manifest.merged <= 1;
	let done = 0;
	let failure = null;
	const stop = new AbortController();

	const partStates = parts.map((part) => {
		const partPath = path.join(workDir, partFileName(part.index));
		const length = part.end - part.start;
		if (!downloadNeeded) return { part, partPath, length, offset: length };

		let size = fileSize(partPath);
		if (size > length) size = length;
		// Drop a torn final chunk (only whole chunks count as done).
		const offset = size === length ? length : Math.floor(size / chunkSize) * chunkSize;
		if (fs.existsSync(partPath) && fileSize(partPath) !== offset) fs.truncateSync(partPath, offset);
		return { part, partPath, length, offset };
	});

	done = partStates.reduce((sum, state) => sum + state.offset, 0);
	onStart({ parts: parts.length, resumedBytes: done, merging: !downloadNeeded });
	onProgress(done);

	const downloadPart = async (state) => {
		if (state.offset >= state.length) return;

		const fd = fs.openSync(state.partPath, state.offset > 0 ? 'r+' : 'w');
		try {
			while (!failure && state.offset < state.length) {
				const expected = Math.min(chunkSize, state.length - state.offset);
				const chunk = await fetchChunk(state.part.start + state.offset, state.part.index, stop.signal);
				if (failure) return;
				if (chunk.length !== expected) {
					throw new Error(`Expected ${expected} bytes at offset ${state.part.start + state.offset} but Telegram returned ${chunk.length}.`);
				}

				fs.writeSync(fd, chunk, 0, chunk.length, state.offset);
				fs.fdatasyncSync(fd);
				state.offset += chunk.length;
				done += chunk.length;
				onProgress(done);
			}
		} finally {
			fs.closeSync(fd);
		}
	};

	if (downloadNeeded) {
		await Promise.all(partStates.map((state) => downloadPart(state).catch((error) => {
			failure ??= error;
			stop.abort(failure); // the other parts give up their in-flight requests and retries right away
		})));
		if (failure) throw failure;
	}

	onMergeStart();
	mergeParts({ workDir, manifest, finalPath });
	return { parts: parts.length };
};
