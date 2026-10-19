import fs from 'node:fs'
import path from 'node:path'
import { callApi, sleep, drawProgressBar } from "./helper.js";
import { connectionPool } from './connectionPool.js';
import { downloadInParts, AdaptiveLimiter } from './partedDownload.js';
import { speedTracker, downloadsFolderPath, downloadConnections, downloadParts } from './config.js';
import {
	parseChannelInput,
	parseMessageLink,
	parseMessageRange,
	isWithinDateFilter,
	extensionFromMimeType,
	buildLocalFileName,
	formatBytes,
	formatDuration,
} from './parsers.js';

// 1MB is the largest chunk Telegram serves; offsets must be multiples of it.
export const CHUNK_SIZE = 1024 * 1024;
const HISTORY_PAGE_SIZE = 100;
const MAX_FILE_REFERENCE_REFRESHES = 3;
const MAX_TRANSIENT_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 60 * 1000;
// Unfinished parts live here, next to the downloads, until they are merged into the final file.
export const PARTS_FOLDER = '.parts';

const toInputChannel = (channel) => ({
	_: 'inputChannel',
	channel_id: channel.id,
	access_hash: channel.access_hash,
});

const toInputPeerChannel = (channel) => ({
	_: 'inputPeerChannel',
	channel_id: channel.id,
	access_hash: channel.access_hash,
});

const assertIsChannel = (chat, reference) => {
	if (!chat) throw new Error(`Could not find a channel for "${reference}".`);
	if (chat._ === 'channelForbidden') throw new Error(`You do not have access to "${chat.title}".`);
	if (chat._ !== 'channel') throw new Error(`"${chat.title ?? reference}" is not a channel or supergroup.`);
	return { id: chat.id, access_hash: chat.access_hash, title: chat.title };
};

// Converts a dialog peer into an InputPeer so getDialogs can be paginated.
const dialogPeerToInputPeer = (peer, chats, users) => {
	if (peer._ === 'peerChannel') {
		const chat = chats.find((c) => String(c.id) === String(peer.channel_id));
		return { _: 'inputPeerChannel', channel_id: peer.channel_id, access_hash: chat?.access_hash ?? 0 };
	}
	if (peer._ === 'peerChat') return { _: 'inputPeerChat', chat_id: peer.chat_id };
	const user = users.find((u) => String(u.id) === String(peer.user_id));
	return { _: 'inputPeerUser', user_id: peer.user_id, access_hash: user?.access_hash ?? 0 };
};

const peerKey = (peer) => `${peer?._}:${peer?.channel_id ?? peer?.chat_id ?? peer?.user_id}`;

// Private channels (t.me/c/<id>) carry no access hash, so look the channel up in the user's chat list.
const findChannelInDialogs = async (channelId) => {
	let offsetDate = 0;
	let offsetId = 0;
	let offsetPeer = { _: 'inputPeerEmpty' };

	while (true) {
		const result = await callApi('messages.getDialogs', {
			offset_date: offsetDate,
			offset_id: offsetId,
			offset_peer: offsetPeer,
			limit: HISTORY_PAGE_SIZE,
			hash: 0,
		});

		if (result._ === 'messages.dialogsNotModified') return null;

		const match = result.chats.find((chat) => String(chat.id) === String(channelId));
		if (match) return match;

		const dialogs = result.dialogs ?? [];
		if (result._ === 'messages.dialogs' || dialogs.length < HISTORY_PAGE_SIZE) return null;

		const last = dialogs[dialogs.length - 1];
		const topMessage = result.messages.find((m) => m.id === last.top_message && peerKey(m.peer_id) === peerKey(last.peer));
		offsetDate = topMessage?.date ?? 0;
		offsetId = last.top_message;
		offsetPeer = dialogPeerToInputPeer(last.peer, result.chats, result.users);
	}
};

// Resolves a channel link / @username / private link / invite link into { id, access_hash, title }.
export const resolveChannel = async (channelInput) => {
	const reference = typeof channelInput === 'string' ? parseChannelInput(channelInput) : channelInput;

	if (reference.type === 'username') {
		const resolved = await callApi('contacts.resolveUsername', { username: reference.username });
		if (resolved.peer?._ !== 'peerChannel') {
			throw new Error(`@${reference.username} is a user, not a channel.`);
		}
		const chat = resolved.chats.find((c) => String(c.id) === String(resolved.peer.channel_id));
		return assertIsChannel(chat, `@${reference.username}`);
	}

	if (reference.type === 'invite') {
		const invite = await callApi('messages.checkChatInvite', { hash: reference.hash });
		if (invite._ === 'chatInviteAlready' || invite._ === 'chatInvitePeek') {
			return assertIsChannel(invite.chat, 'invite link');
		}
		throw new Error(`You are not a member of "${invite.title ?? 'this chat'}". Join it in Telegram first, then try again.`);
	}

	if (reference.type === 'privateId') {
		const chat = await findChannelInDialogs(reference.channelId);
		if (!chat) {
			throw new Error(`Private channel ${reference.channelId} was not found in your chats. Make sure this account has joined it.`);
		}
		return assertIsChannel(chat, `t.me/c/${reference.channelId}`);
	}

	throw new Error(`Unsupported channel reference type: ${reference.type}`);
};

// Turns a message with a document into the file descriptor used across the app (or null if there is no file).
export const extractFileFromMessage = (msg, channel) => {
	const document = msg?.media?.document;
	if (!document || document._ !== 'document') return null;

	const attributes = document.attributes || [];
	const nameAttr = attributes.find((attr) => attr._ === 'documentAttributeFilename');
	const extension = extensionFromMimeType(document.mime_type);
	const fallbackName = `file_${document.id}${extension ? `.${extension}` : ''}`;

	return {
		messageId: msg.id,
		date: msg.date,
		id: document.id,
		access_hash: document.access_hash,
		file_reference: document.file_reference,
		size: Number(document.size),
		dcId: document.dc_id,
		mimeType: document.mime_type,
		name: nameAttr ? nameAttr.file_name : fallbackName,
		channel,
	};
};

/**
 * Fetches every downloadable file in a channel, oldest first.
 * When a dateFilter ({ from, to } in unix seconds, from parseDateFilter) is given, only that window is
 * scanned: history paging starts at `to` and stops as soon as messages are older than `from`.
 * An idRange ({ fromId, toId }, inclusive) works the same way with message ids.
 */
export const fetchFilesFromChannel = async (channelInput, { dateFilter = null, idRange = null } = {}) => {
	try {
		const channel = typeof channelInput === 'object' && channelInput.access_hash !== undefined
			? channelInput
			: await resolveChannel(channelInput);

		const scope = dateFilter ? ` (${dateFilter.label})` : idRange ? ` (messages ${idRange.fromId} to ${idRange.toId})` : '';
		console.info(`Fetching files from channel: ${channel.title}${scope}`);

		// getHistory returns messages older than offset_id, so start just above the end of the range.
		let offsetId = idRange ? idRange.toId + 1 : 0;
		let offsetDate = dateFilter?.to ?? 0;
		let scanned = 0;
		const files = [];

		while (true) {
			const history = await callApi('messages.getHistory', {
				peer: toInputPeerChannel(channel),
				offset_id: offsetId,
				offset_date: offsetDate,
				add_offset: 0,
				limit: HISTORY_PAGE_SIZE,
				max_id: 0,
				min_id: 0,
				hash: 0,
			});

			const messages = history.messages;
			if (!messages || messages.length === 0) break;

			scanned += messages.length;
			let reachedStartOfRange = false;

			for (const msg of messages) {
				if ((dateFilter?.from != null && msg.date < dateFilter.from) || (idRange && msg.id < idRange.fromId)) {
					reachedStartOfRange = true;
					continue;
				}
				if (!isWithinDateFilter(msg.date, dateFilter)) continue;
				if (idRange && msg.id > idRange.toId) continue;

				const file = extractFileFromMessage(msg, channel);
				if (file) files.push(file);
			}

			if (process.stdout.isTTY) {
				process.stdout.clearLine(0);
				process.stdout.cursorTo(0);
				process.stdout.write(`Scanned ${scanned} messages, found ${files.length} files...`);
			}

			if (reachedStartOfRange || messages.length < HISTORY_PAGE_SIZE) break;
			offsetId = messages[messages.length - 1].id;
			offsetDate = 0;
		}

		if (process.stdout.isTTY) process.stdout.write('\n');
		console.info(`Found ${files.length} files in the channel.`);
		return files.reverse();
	} catch (error) {
		console.error('Error fetching files:', error.message ?? error);
		throw error;
	}
};

const getChannelMessage = async (channel, messageId) => {
	const result = await callApi('channels.getMessages', {
		channel: toInputChannel(channel),
		id: [{ _: 'inputMessageID', id: messageId }],
	});
	return result.messages?.find((m) => m.id === messageId && m._ === 'message') ?? null;
};

/**
 * Fetches the files posted between two message links of the same channel, including both linked messages.
 * Resolves to { channel, fromId, toId, files }.
 */
export const fetchFilesBetweenMessageLinks = async (fromLink, toLink) => {
	const { channel: reference, fromId, toId } = parseMessageRange(fromLink, toLink);
	const channel = await resolveChannel(reference);
	const files = await fetchFilesFromChannel(channel, { idRange: { fromId, toId } });
	return { channel, fromId, toId, files };
};

// Fetches the single file attached to a message link such as https://t.me/channel/123.
export const fetchFileFromMessageLink = async (messageLink) => {
	const { channel: reference, messageId } = parseMessageLink(messageLink);
	const channel = await resolveChannel(reference);

	const message = await getChannelMessage(channel, messageId);
	if (!message) throw new Error(`Message ${messageId} was not found in "${channel.title}" (it may have been deleted).`);

	const file = extractFileFromMessage(message, channel);
	if (!file) throw new Error(`Message ${messageId} in "${channel.title}" does not contain a downloadable file.`);

	return file;
};

// File references expire after a while (e.g. when the user spends time picking files), so fetch a fresh one.
const refreshFileReference = async (file) => {
	const message = await getChannelMessage(file.channel, file.messageId);
	const refreshed = extractFileFromMessage(message, file.channel);
	if (!refreshed) throw new Error(`Message ${file.messageId} no longer contains a file.`);
	file.file_reference = refreshed.file_reference;
};

// Worth retrying: our own timeouts, connection drops (no Telegram error at all), and Telegram's
// "-503 Timeout", which means one of its internal servers did not answer in time.
const isTransient = (error) => !error.error_message || error.error_message === 'Timeout' || error.error_code === -503;

// Human-readable reason for a retry notice.
const describeFailure = (error) => {
	if (error.error_message === 'Timeout' || error.error_code === -503) return 'Telegram\'s servers timed out internally';
	return error.message || error.error_message || error.code || 'Network error';
};

// Rejects after `ms`, or as soon as `signal` aborts (another part of the download already failed).
const withTimeout = (promise, ms, signal) => {
	let timer;
	let onAbort;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error(`No response from Telegram within ${ms / 1000}s`), { isTimeout: true })), ms);
		onAbort = () => reject(signal.reason);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
	return Promise.race([promise, timeout]).finally(() => {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	});
};

/**
 * Builds the function that fetches one chunk, shared by all parts of a single file download.
 * Error handling is coordinated across parts: flood waits go through the shared adaptive limiter (pause +
 * lower parallelism), a data center switch or refreshed file reference is picked up by every part, and
 * lost requests are retried after a timeout (reopening the connection when it has gone silent).
 */
const createChunkFetcher = (file, { connections, limiter, onNotice, requestTimeoutMs = REQUEST_TIMEOUT_MS }) => {
	const state = {
		dcId: file.dcId ?? null,
		referenceRefreshes: 0,
		refreshing: null,
		authImports: new Map(), // dcId -> Promise<time the import finished>
	};

	return async (offset, partIndex, signal) => {
		let transientFailures = 0;

		while (true) {
			signal?.throwIfAborted();
			const dcId = state.dcId;
			const fileReference = file.file_reference;
			const grantedAt = await limiter.acquire();
			const requestedAt = performance.now();
			const sentAt = Date.now();
			const params = {
				location: {
					_: 'inputDocumentFileLocation',
					id: file.id,
					access_hash: file.access_hash,
					file_reference: fileReference,
					thumb_size: '',
				},
				offset,
				limit: CHUNK_SIZE,
			};
			let data;
			let failure = null;

			try {
				data = await withTimeout(connectionPool.call(dcId, partIndex, 'upload.getFile', params, { size: connections }), requestTimeoutMs, signal);
			} catch (error) {
				failure = error;
			} finally {
				limiter.release();
			}

			if (signal?.aborted) {
				connectionPool.abandon(dcId, partIndex, params, { size: connections }).catch(() => {}); // just forget it
				throw signal.reason;
			}

			if (!failure) {
				limiter.onSuccess();
				return Buffer.from(data?.bytes ?? []);
			}

			const message = failure.error_message ?? '';

			if (message.startsWith('FLOOD_WAIT_') || message.startsWith('FLOOD_PREMIUM_WAIT_')) {
				const waitTime = parseInt(message.split('_').pop(), 10);
				const { reduced, limit } = limiter.onFlood(waitTime, grantedAt);
				if (reduced) onNotice(`Telegram asked to slow down. Pausing ${waitTime}s and lowering to ${limit} parallel request(s); it will ramp back up gradually.`);
			} else if (message.startsWith('FILE_MIGRATE_')) {
				const newDcId = parseInt(message.split('_').pop(), 10);
				if (state.dcId !== newDcId) {
					state.dcId = newDcId;
					onNotice(`File is in data center ${newDcId}. Re-routing requests...`);
				}
			} else if (message.startsWith('FILE_REFERENCE_')) {
				// Another part may already have refreshed it while this request was in flight.
				if (file.file_reference === fileReference) {
					if (!state.refreshing) {
						if (state.referenceRefreshes >= MAX_FILE_REFERENCE_REFRESHES) throw failure;
						state.referenceRefreshes++;
						onNotice('File reference expired. Refreshing it...');
						state.refreshing = refreshFileReference(file).finally(() => { state.refreshing = null; });
					}
					await state.refreshing;
				}
			} else if (message === 'AUTH_KEY_UNREGISTERED' && dcId) {
				if (!state.authImports.has(dcId)) {
					onNotice(`Authorizing this session on data center ${dcId}...`);
					state.authImports.set(dcId, connectionPool.importAuthorization(dcId).then(() => performance.now()));
				}
				const importedAt = await state.authImports.get(dcId);
				// Still rejected by a request sent after the import finished: the session itself is invalid.
				if (requestedAt >= importedAt) throw failure;
			} else if (isTransient(failure) && transientFailures < MAX_TRANSIENT_RETRIES) {
				transientFailures++;
				let action = 'Retrying';
				if (failure.isTimeout) {
					// Stop waiting for the lost request, and replace the connection if it has gone silent.
					const reconnected = await connectionPool.abandon(dcId, partIndex, params, { size: connections, sentAt }).catch(() => false);
					if (reconnected) action = 'The connection went silent; reconnected. Retrying';
				}
				onNotice(`${describeFailure(failure)}. ${action} (${transientFailures}/${MAX_TRANSIENT_RETRIES})...`);
				await sleep(1000 * transientFailures);
			} else {
				throw failure;
			}
		}
	};
};

const removeEmptyPartsFolder = () => {
	try {
		fs.rmdirSync(path.join(downloadsFolderPath, PARTS_FOLDER)); // only succeeds when no other download is pending
	} catch {
		// still has unfinished downloads in it (or already gone)
	}
};

// Shared by every download in this session so a parallelism level that triggered flood waits is remembered.
export const downloadLimiter = new AdaptiveLimiter({ max: downloadParts });

/**
 * Downloads one file (as returned by fetchFilesFromChannel / fetchFileFromMessageLink) into the downloads folder.
 * The file is split into `parts` ranges downloaded in parallel into downloads/.parts/<file>/, then merged.
 * Interrupted downloads resume exactly where each part stopped. Resolves to 'downloaded', 'skipped' or 'failed'.
 */
export const downloadFile = async (file, {
	parts = downloadParts,
	connections = downloadConnections,
	limiter = downloadLimiter,
	requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) => {
	fs.mkdirSync(downloadsFolderPath, { recursive: true });
	const fileName = buildLocalFileName(file);
	const filePath = path.join(downloadsFolderPath, fileName);
	const workDir = path.join(downloadsFolderPath, PARTS_FOLDER, fileName);
	const totalSize = file.size;

	if (fs.existsSync(filePath) && fs.statSync(filePath).size >= totalSize) {
		console.info(`[Skipped] ${fileName} already fully downloaded.`);
		return 'skipped';
	}

	speedTracker.history = [];
	const startTime = Date.now();
	let resumedBytes = 0;
	const notice = (text) => console.info(`\n${text}`);

	try {
		const result = await downloadInParts({
			finalPath: filePath,
			workDir,
			fileKey: String(file.id),
			totalSize,
			chunkSize: CHUNK_SIZE,
			partCount: parts,
			fetchChunk: createChunkFetcher(file, { connections, limiter, onNotice: notice, requestTimeoutMs }),
			onStart: ({ parts: plannedParts, resumedBytes: resumed, merging }) => {
				resumedBytes = resumed;
				if (merging) {
					console.info('[Resuming] All parts were already downloaded; finishing the merge.');
				} else if (resumed > 0) {
					console.info(`[Resuming] ${formatBytes(resumed)} of ${formatBytes(totalSize)} already downloaded across ${plannedParts} part(s).`);
				}
				if (!merging && plannedParts > 1) console.info(`Downloading in ${plannedParts} parallel parts over ${Math.min(connections, plannedParts)} connection(s)...`);
			},
			onProgress: (done) => drawProgressBar(fileName, done, totalSize, startTime),
			onMergeStart: () => {
				if (process.stdout.isTTY) process.stdout.write(' | merging parts...');
			},
		});

		removeEmptyPartsFolder();
		const seconds = (Date.now() - startTime) / 1000;
		const transferred = totalSize - resumedBytes;
		drawProgressBar(fileName, totalSize, totalSize, startTime);
		console.info(`\nFinished downloading: ${fileName} (${formatBytes(transferred)} in ${formatDuration(seconds)}, avg ${formatBytes(transferred / Math.max(seconds, 0.001))}/s, ${result.parts} part(s))`);
		return 'downloaded';
	} catch (error) {
		console.error(`\nFatal failure during file download (${fileName}):`, error.error_message ?? error.message ?? error);
		console.error('Progress is saved. Run the same download again to resume from where it stopped.');
		return 'failed';
	}
};

// Downloads files one after another and prints a summary at the end.
export const downloadFiles = async (files, { pauseMs = 0 } = {}) => {
	const summary = { downloaded: 0, skipped: 0, failed: 0 };
	const startTime = Date.now();

	console.info(`Starting batch download of ${files.length} file(s) (up to ${downloadParts} parallel parts per file)...`);

	for (const [i, file] of files.entries()) {
		console.info(`\n[${i + 1}/${files.length}]`);
		const status = await downloadFile(file);
		summary[status]++;

		if (i < files.length - 1 && status !== 'skipped' && pauseMs > 0) {
			await sleep(pauseMs);
		}
	}

	console.info(`\nDone in ${formatDuration((Date.now() - startTime) / 1000)}. Downloaded: ${summary.downloaded}, skipped (already present): ${summary.skipped}, failed: ${summary.failed}.`);
	console.info(`Files are saved in: ${downloadsFolderPath}`);
	return summary;
};
