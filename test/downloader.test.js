import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Point downloads at a throwaway folder before the app modules read the config.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-downloader-test-'));
process.env.DOWNLOADS_DIR = tempDir;
process.env.api_id ??= '1';
process.env.api_hash ??= 'test';

const { default: mtproto } = await import('../mtProto.js');
const { connectionPool } = await import('../connectionPool.js');
const {
	CHUNK_SIZE,
	resolveChannel,
	fetchFilesFromChannel,
	fetchFileFromMessageLink,
	fetchFilesBetweenMessageLinks,
	downloadFile,
	downloadFiles,
} = await import('../downloader.js');
const { parseDateFilter } = await import('../parsers.js');
const { AdaptiveLimiter } = await import('../partedDownload.js');

const CHANNEL = { _: 'channel', id: '1001', access_hash: '555', title: 'Test Channel' };
const unix = (y, m, d, h = 12) => Math.floor(new Date(y, m - 1, d, h).getTime() / 1000);

const telegramError = (error_message) => Object.assign(new Error(error_message), { error_message });

const documentMessage = (id, date, { name, size = 10, mime = 'application/pdf', reference = 'ref-1' } = {}) => ({
	_: 'message',
	id,
	date,
	media: {
		_: 'messageMediaDocument',
		document: {
			_: 'document',
			id: `doc${id}`,
			access_hash: `hash${id}`,
			file_reference: reference,
			size: String(size),
			mime_type: mime,
			attributes: name ? [{ _: 'documentAttributeFilename', file_name: name }] : [],
		},
	},
});

const textMessage = (id, date) => ({ _: 'message', id, date, message: 'hello' });

// Minimal in-memory Telegram: `messages` is the channel history, newest first, like the real API returns it.
const createFakeTelegram = ({ messages = [], fileBytes = Buffer.alloc(0), onGetFile } = {}) => {
	const calls = [];

	const handlers = {
		'contacts.resolveUsername': ({ username }) => {
			if (username === 'testchannel') return { peer: { _: 'peerChannel', channel_id: CHANNEL.id }, chats: [CHANNEL], users: [] };
			if (username === 'someuser') return { peer: { _: 'peerUser', user_id: '9' }, chats: [], users: [{ id: '9' }] };
			throw telegramError('USERNAME_NOT_OCCUPIED');
		},
		'messages.getDialogs': ({ offset_id }) => {
			// Two pages: first has unrelated chats, second has our channel.
			if (offset_id === 0) {
				const dialogs = Array.from({ length: 100 }, (_, i) => ({ peer: { _: 'peerChannel', channel_id: `${i}` }, top_message: i + 1 }));
				const chats = dialogs.map((d) => ({ _: 'channel', id: d.peer.channel_id, access_hash: 'x', title: `Other ${d.peer.channel_id}` }));
				const msgs = dialogs.map((d) => ({ id: d.top_message, date: 1000, peer_id: d.peer }));
				return { _: 'messages.dialogsSlice', dialogs, chats, messages: msgs, users: [] };
			}
			return { _: 'messages.dialogsSlice', dialogs: [{ peer: { _: 'peerChannel', channel_id: CHANNEL.id }, top_message: 1 }], chats: [CHANNEL], messages: [], users: [] };
		},
		'messages.checkChatInvite': ({ hash }) => {
			if (hash === 'member') return { _: 'chatInviteAlready', chat: CHANNEL };
			return { _: 'chatInvite', title: 'Secret Club' };
		},
		'messages.getHistory': ({ offset_id, offset_date, limit }) => {
			let list = messages;
			if (offset_id) list = list.filter((m) => m.id < offset_id);
			else if (offset_date) list = list.filter((m) => m.date < offset_date);
			return { messages: list.slice(0, limit) };
		},
		'channels.getMessages': ({ id }) => ({
			messages: id.map(({ id: wanted }) => messages.find((m) => m.id === wanted) ?? { _: 'messageEmpty', id: wanted }),
		}),
		'upload.getFile': (params, options) => {
			const override = onGetFile?.(params, options);
			if (override) return override;
			return { bytes: fileBytes.subarray(params.offset, params.offset + params.limit) };
		},
	};

	// Parallel chunk requests go through the connection pool; route them to the same fake, remembering which connection was used.
	connectionPool.call = async (dcId, index, method, params) => {
		calls.push({ method, params, options: dcId ? { dcId } : undefined, connection: index });
		return handlers[method](params, dcId ? { dcId } : undefined);
	};
	connectionPool.importAuthorization = async (dcId) => { calls.push({ method: 'importAuthorization', dcId }); };
	connectionPool.abandon = async (dcId, index, params, options) => {
		calls.push({ method: 'abandon', params, options, connection: index });
		return true;
	};

	mtproto.call = async (method, params, options) => {
		calls.push({ method, params, options });
		const handler = handlers[method];
		if (!handler) throw new Error(`Unexpected call ${method}`);
		return handler(params, options);
	};

	return calls;
};

const silenceConsole = () => {
	for (const method of ['log', 'info', 'error']) console[method] = () => {};
};

beforeEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	fs.mkdirSync(tempDir, { recursive: true });
	silenceConsole();
});

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe('resolveChannel', () => {
	test('resolves a public username link', async () => {
		createFakeTelegram();
		assert.deepEqual(await resolveChannel('https://t.me/testchannel'), { id: '1001', access_hash: '555', title: 'Test Channel' });
	});

	test('rejects usernames that belong to users', async () => {
		createFakeTelegram();
		await assert.rejects(resolveChannel('@someuser'), /is a user, not a channel/);
	});

	test('finds private channels by paging through dialogs', async () => {
		const calls = createFakeTelegram();
		const channel = await resolveChannel('https://t.me/c/1001');
		assert.equal(channel.title, 'Test Channel');
		const dialogCalls = calls.filter((c) => c.method === 'messages.getDialogs');
		assert.equal(dialogCalls.length, 2);
		assert.equal(dialogCalls[1].params.offset_id, 100);
		assert.equal(dialogCalls[1].params.offset_peer._, 'inputPeerChannel');
	});

	test('invite links work when already a member and explain otherwise', async () => {
		createFakeTelegram();
		assert.equal((await resolveChannel('https://t.me/+member')).id, '1001');
		await assert.rejects(resolveChannel('https://t.me/+stranger'), /not a member of "Secret Club"/);
	});
});

describe('fetchFilesFromChannel', () => {
	// 250 messages, one per hour going back from Oct 19 2026 12:00, every other one carries a file.
	const history = Array.from({ length: 250 }, (_, i) => {
		const id = 250 - i;
		const date = unix(2026, 10, 19) - i * 3600;
		return id % 2 === 0 ? documentMessage(id, date, { name: `doc-${id}.pdf` }) : textMessage(id, date);
	});

	test('pages through the whole history and returns files oldest first', async () => {
		const calls = createFakeTelegram({ messages: history });
		const files = await fetchFilesFromChannel('https://t.me/testchannel');
		assert.equal(files.length, 125);
		assert.equal(files[0].messageId, 2);
		assert.equal(files.at(-1).messageId, 250);
		assert.equal(files[0].size, 10);
		assert.equal(typeof files[0].size, 'number');
		assert.equal(calls.filter((c) => c.method === 'messages.getHistory').length, 3);
	});

	test('date filter only returns files from that day and stops paging early', async () => {
		const calls = createFakeTelegram({ messages: history });
		const filter = parseDateFilter('2026-10-17');
		const files = await fetchFilesFromChannel('https://t.me/testchannel', { dateFilter: filter });

		assert.equal(files.length, 12); // 24 hourly messages that day, half with files
		for (const file of files) {
			assert.ok(file.date >= filter.from && file.date < filter.to);
		}
		const historyCalls = calls.filter((c) => c.method === 'messages.getHistory');
		assert.equal(historyCalls[0].params.offset_date, filter.to);
		assert.equal(historyCalls.length, 1, 'should not page past the start of the range');
	});

	test('date range with no files returns an empty list', async () => {
		createFakeTelegram({ messages: history });
		const files = await fetchFilesFromChannel('https://t.me/testchannel', { dateFilter: parseDateFilter('2020-01-01') });
		assert.deepEqual(files, []);
	});

	test('names files without a filename attribute from their mime type', async () => {
		createFakeTelegram({ messages: [documentMessage(1, unix(2026, 10, 19), { mime: 'video/mp4' })] });
		const [file] = await fetchFilesFromChannel('https://t.me/testchannel');
		assert.equal(file.name, 'file_doc1.mp4');
	});
});

describe('fetchFilesBetweenMessageLinks', () => {
	// 250 messages with ids 1..250; even ids carry files.
	const history = Array.from({ length: 250 }, (_, i) => {
		const id = 250 - i;
		const date = unix(2026, 10, 19) - i * 60;
		return id % 2 === 0 ? documentMessage(id, date, { name: `doc-${id}.pdf` }) : textMessage(id, date);
	});

	test('returns files between both links, inclusive, oldest first', async () => {
		const calls = createFakeTelegram({ messages: history });
		const { files, fromId, toId, channel } = await fetchFilesBetweenMessageLinks('https://t.me/testchannel/120', 'https://t.me/testchannel/130');
		assert.equal(channel.title, 'Test Channel');
		assert.deepEqual([fromId, toId], [120, 130]);
		assert.deepEqual(files.map((f) => f.messageId), [120, 122, 124, 126, 128, 130]);

		const historyCalls = calls.filter((c) => c.method === 'messages.getHistory');
		assert.equal(historyCalls[0].params.offset_id, 131, 'starts right above the last message');
		assert.equal(historyCalls.length, 1, 'stops once it passes the first message');
	});

	test('pages through long ranges and accepts links in reverse order', async () => {
		createFakeTelegram({ messages: history });
		const { files } = await fetchFilesBetweenMessageLinks('https://t.me/testchannel/240', 'https://t.me/testchannel/11');
		assert.equal(files.length, 115);
		assert.equal(files[0].messageId, 12);
		assert.equal(files.at(-1).messageId, 240);
	});

	test('rejects links from different channels before calling Telegram', async () => {
		const calls = createFakeTelegram({ messages: history });
		await assert.rejects(fetchFilesBetweenMessageLinks('https://t.me/testchannel/1', 'https://t.me/other/2'), /same channel/);
		assert.equal(calls.length, 0);
	});
});

describe('fetchFileFromMessageLink', () => {
	test('returns the file attached to the linked message', async () => {
		createFakeTelegram({ messages: [documentMessage(7, unix(2026, 10, 19), { name: 'report.pdf', size: 99 })] });
		const file = await fetchFileFromMessageLink('https://t.me/testchannel/7?single');
		assert.equal(file.name, 'report.pdf');
		assert.equal(file.messageId, 7);
		assert.equal(file.size, 99);
		assert.equal(file.channel.title, 'Test Channel');
	});

	test('explains when the message is missing or has no file', async () => {
		createFakeTelegram({ messages: [textMessage(8, unix(2026, 10, 19))] });
		await assert.rejects(fetchFileFromMessageLink('https://t.me/testchannel/9'), /was not found/);
		await assert.rejects(fetchFileFromMessageLink('https://t.me/testchannel/8'), /does not contain a downloadable file/);
	});
});

describe('downloadFile', () => {
	const size = CHUNK_SIZE * 2 + 1234;
	const bytes = crypto.randomBytes(size);
	const message = documentMessage(5, unix(2026, 10, 19), { name: 'big.bin', size });
	const makeFile = () => ({
		messageId: 5,
		date: message.date,
		id: 'doc5',
		access_hash: 'hash5',
		file_reference: 'ref-1',
		size,
		name: 'big.bin',
		channel: { id: CHANNEL.id, access_hash: CHANNEL.access_hash, title: CHANNEL.title },
	});
	const localPath = () => path.join(tempDir, '(5) big.bin');

	test('downloads the whole file in chunk-aligned requests spread over the connections', async () => {
		const calls = createFakeTelegram({ messages: [message], fileBytes: bytes });
		assert.equal(await downloadFile(makeFile(), { connections: 3 }), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));

		const fileCalls = calls.filter((c) => c.method === 'upload.getFile');
		assert.deepEqual(fileCalls.map((c) => c.params.offset).sort((a, b) => a - b), [0, CHUNK_SIZE, CHUNK_SIZE * 2]);
		assert.ok(fileCalls.every((c) => c.params.limit === CHUNK_SIZE));
		assert.deepEqual(new Set(fileCalls.map((c) => c.connection)), new Set([0, 1, 2]));
	});

	test('a single connection still works', async () => {
		createFakeTelegram({ messages: [message], fileBytes: bytes });
		assert.equal(await downloadFile(makeFile(), { connections: 1 }), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
	});

	test('starts on the data center the document lives on', async () => {
		const calls = createFakeTelegram({ messages: [message], fileBytes: bytes });
		assert.equal(await downloadFile({ ...makeFile(), dcId: 5 }), 'downloaded');
		assert.ok(calls.filter((c) => c.method === 'upload.getFile').every((c) => c.options?.dcId === 5));
	});

	test('imports the login into a data center that rejects the session', async () => {
		let imported = false;
		const calls = createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: () => {
				if (!imported) throw telegramError('AUTH_KEY_UNREGISTERED');
				return null;
			},
		});
		const original = connectionPool.importAuthorization;
		connectionPool.importAuthorization = async (dcId) => { imported = true; return original(dcId); };
		assert.equal(await downloadFile({ ...makeFile(), dcId: 4 }), 'downloaded');
		assert.deepEqual(calls.filter((c) => c.method === 'importAuthorization').map((c) => c.dcId), [4]);
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
	});

	test('fails (resumably) when Telegram returns a short chunk mid-file', async () => {
		createFakeTelegram({ messages: [message], fileBytes: bytes.subarray(0, CHUNK_SIZE + 10) });
		assert.equal(await downloadFile(makeFile()), 'failed');
		assert.ok(!fs.existsSync(localPath()), 'the final file only appears once complete');
		const partsDir = path.join(tempDir, '.parts', '(5) big.bin');
		const sizes = fs.readdirSync(partsDir).filter((f) => f.startsWith('part-')).map((f) => fs.statSync(path.join(partsDir, f)).size);
		assert.ok(sizes.every((size) => size % CHUNK_SIZE === 0), 'only whole chunks are kept for resuming');
	});

	test('resumes a partial download from the last full chunk, discarding a torn chunk', async () => {
		// Simulate a previous run that wrote one full chunk plus half of the next one, with junk at the end.
		const partial = Buffer.concat([bytes.subarray(0, CHUNK_SIZE), Buffer.alloc(CHUNK_SIZE / 2, 0xff)]);
		fs.writeFileSync(localPath(), partial);

		const calls = createFakeTelegram({ messages: [message], fileBytes: bytes });
		assert.equal(await downloadFile(makeFile()), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
		assert.equal(calls.find((c) => c.method === 'upload.getFile').params.offset, CHUNK_SIZE);
	});

	test('skips files that are already complete', async () => {
		fs.writeFileSync(localPath(), bytes);
		const calls = createFakeTelegram({ messages: [message], fileBytes: bytes });
		assert.equal(await downloadFile(makeFile()), 'skipped');
		assert.equal(calls.length, 0);
	});

	test('switches every worker to the right data center on FILE_MIGRATE', async () => {
		const served = [];
		createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: (params, options) => {
				if (options?.dcId !== 4) throw telegramError('FILE_MIGRATE_4');
				served.push(params.offset);
				return null;
			},
		});
		assert.equal(await downloadFile(makeFile()), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
		assert.deepEqual(served.sort((a, b) => a - b), [0, CHUNK_SIZE, CHUNK_SIZE * 2]);
	});

	test('refreshes an expired file reference and continues', async () => {
		const freshMessage = documentMessage(5, message.date, { name: 'big.bin', size, reference: 'ref-2' });
		const calls = createFakeTelegram({
			messages: [freshMessage],
			fileBytes: bytes,
			onGetFile: (params) => {
				if (params.location.file_reference === 'ref-1') throw telegramError('FILE_REFERENCE_EXPIRED');
				return null;
			},
		});
		assert.equal(await downloadFile(makeFile()), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
		// All parallel workers hit the expired reference, but it is refreshed only once.
		assert.equal(calls.filter((c) => c.method === 'channels.getMessages').length, 1);
	});

	test('gives up after repeated expired references', async () => {
		createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: () => { throw telegramError('FILE_REFERENCE_EXPIRED'); },
		});
		assert.equal(await downloadFile(makeFile()), 'failed');
	});

	test('waits out FLOOD_WAIT and retries', async () => {
		let flooded = false;
		createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: () => {
				if (!flooded) {
					flooded = true;
					throw telegramError('FLOOD_WAIT_0');
				}
				return null;
			},
		});
		assert.equal(await downloadFile(makeFile()), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
	});

	test('an interrupted download resumes on the next run, fetching only what is missing', async () => {
		const bigSize = CHUNK_SIZE * 12 + 77;
		const bigBytes = crypto.randomBytes(bigSize);
		const bigFile = { ...makeFile(), size: bigSize };
		const bigMessage = documentMessage(5, message.date, { name: 'big.bin', size: bigSize });

		const firstCalls = createFakeTelegram({
			messages: [bigMessage],
			fileBytes: bigBytes,
			onGetFile: (params) => {
				if (params.offset === CHUNK_SIZE * 7) throw telegramError('INTERNAL_SERVER_ERROR');
				return null;
			},
		});
		assert.equal(await downloadFile(bigFile, { parts: 4 }), 'failed');
		const servedFirst = firstCalls.filter((c) => c.method === 'upload.getFile' && c.params.offset !== CHUNK_SIZE * 7).length;

		const secondCalls = createFakeTelegram({ messages: [bigMessage], fileBytes: bigBytes });
		assert.equal(await downloadFile(bigFile, { parts: 4 }), 'downloaded');
		const fetchedSecond = secondCalls.filter((c) => c.method === 'upload.getFile').length;

		assert.ok(fs.readFileSync(localPath()).equals(bigBytes));
		assert.ok(fetchedSecond < 13, `second run fetched ${fetchedSecond} of 13 chunks`);
		assert.ok(servedFirst + fetchedSecond <= 13 + 4, 'at most one in-flight chunk per part is repeated');
		assert.ok(!fs.existsSync(path.join(tempDir, '.parts')), 'parts folder is removed once nothing is pending');
	});

	test('a flood wait lowers parallelism through the limiter', async () => {
		const limiter = new AdaptiveLimiter({ max: 8 });
		let flooded = false;
		createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: () => {
				if (!flooded) {
					flooded = true;
					throw telegramError('FLOOD_WAIT_0');
				}
				return null;
			},
		});
		assert.equal(await downloadFile(makeFile(), { limiter }), 'downloaded');
		assert.equal(limiter.limit, 4);
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
	});

	test('a request with no answer is abandoned (reopening its connection) and retried', async () => {
		let stalled = null;
		const calls = createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: (params) => {
				if (stalled || params.offset !== CHUNK_SIZE) return null;
				stalled = params;
				return new Promise(() => {}); // Telegram never answers this one
			},
		});
		const notices = [];
		console.info = (text) => notices.push(String(text));

		assert.equal(await downloadFile(makeFile(), { requestTimeoutMs: 50 }), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));

		const abandoned = calls.filter((c) => c.method === 'abandon');
		assert.equal(abandoned.length, 1);
		assert.equal(abandoned[0].params, stalled, 'the exact request object is handed over so it can be forgotten');
		assert.equal(typeof abandoned[0].options.sentAt, 'number');
		assert.equal(calls.filter((c) => c.method === 'upload.getFile' && c.params.offset === CHUNK_SIZE).length, 2);
		assert.ok(notices.some((text) => /No response from Telegram.*reconnected\. Retrying \(1\/5\)/.test(text)), notices.join('\n'));
	});

	test("retries Telegram's internal -503 Timeout error", async () => {
		let failed = false;
		createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: () => {
				if (failed) return null;
				failed = true;
				// Shaped like the library's rpc_error: no `message`, only error_code / error_message.
				throw { _: 'mt_rpc_error', error_code: -503, error_message: 'Timeout' };
			},
		});
		const notices = [];
		console.info = (text) => notices.push(String(text));
		assert.equal(await downloadFile(makeFile()), 'downloaded');
		assert.ok(fs.readFileSync(localPath()).equals(bytes));
		assert.ok(notices.some((text) => /Telegram's servers timed out internally\. Retrying \(1\/5\)/.test(text)), notices.join('\n'));
	});

	test('once one part fails, the others stop instead of waiting out their own retries', async () => {
		createFakeTelegram({
			messages: [message],
			fileBytes: bytes,
			onGetFile: (params) => {
				if (params.offset === 0) throw telegramError('AUTH_KEY_INVALID');
				return new Promise(() => {}); // every other part is stuck on a request
			},
		});
		const started = Date.now();
		assert.equal(await downloadFile(makeFile(), { requestTimeoutMs: 60_000 }), 'failed');
		assert.ok(Date.now() - started < 5000, 'did not wait for the stuck requests to time out');
	});

	test('reports failure on unexpected errors without throwing', async () => {
		createFakeTelegram({ fileBytes: bytes, onGetFile: () => { throw telegramError('AUTH_KEY_INVALID'); } });
		assert.equal(await downloadFile(makeFile()), 'failed');
	});
});

describe('downloadFiles', () => {
	test('downloads only the given files and summarises the result', async () => {
		const messages = [
			documentMessage(3, unix(2026, 10, 19), { name: 'c.txt', size: 3 }),
			documentMessage(2, unix(2026, 10, 18), { name: 'b.txt', size: 3 }),
			documentMessage(1, unix(2026, 10, 17), { name: 'a.txt', size: 3 }),
		];
		createFakeTelegram({ messages, fileBytes: Buffer.from('abc') });
		const files = await fetchFilesFromChannel('https://t.me/testchannel');

		fs.writeFileSync(path.join(tempDir, '(1) a.txt'), 'abc');
		const summary = await downloadFiles([files[0], files[2]], { pauseMs: 0 });

		assert.deepEqual(summary, { downloaded: 1, skipped: 1, failed: 0 });
		assert.deepEqual(fs.readdirSync(tempDir).sort(), ['(1) a.txt', '(3) c.txt']);
	});
});
