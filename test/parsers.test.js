import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseChannelInput,
	parseMessageLink,
	parseMessageRange,
	parseDateFilter,
	isWithinDateFilter,
	parseSelection,
	extensionFromMimeType,
	sanitizeFileName,
	buildLocalFileName,
	formatBytes,
	formatFileTable,
	formatDuration,
} from '../parsers.js';

const unix = (y, m, d, h = 0, min = 0) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

describe('parseChannelInput', () => {
	test('accepts the common public channel formats', () => {
		for (const input of ['https://t.me/mychannel', 'http://t.me/mychannel/', 't.me/mychannel', '@mychannel', 'mychannel', 'https://telegram.me/mychannel', 'https://t.me/s/mychannel', ' https://t.me/mychannel?x=1 ']) {
			assert.deepEqual(parseChannelInput(input), { type: 'username', username: 'mychannel' }, input);
		}
	});

	test('accepts private channel links', () => {
		assert.deepEqual(parseChannelInput('https://t.me/c/1234567890'), { type: 'privateId', channelId: '1234567890' });
		assert.deepEqual(parseChannelInput('https://t.me/c/1234567890/55'), { type: 'privateId', channelId: '1234567890' });
	});

	test('accepts invite links', () => {
		assert.deepEqual(parseChannelInput('https://t.me/+AbC_dEf123'), { type: 'invite', hash: 'AbC_dEf123' });
		assert.deepEqual(parseChannelInput('https://t.me/joinchat/AbCdEf'), { type: 'invite', hash: 'AbCdEf' });
	});

	test('rejects garbage', () => {
		assert.throws(() => parseChannelInput(''), /empty/);
		assert.throws(() => parseChannelInput('https://example.com/foo'), /not a valid/);
		assert.throws(() => parseChannelInput('ab'), /not a valid/);
		assert.throws(() => parseChannelInput('https://t.me/'), /missing/);
	});
});

describe('parseMessageLink', () => {
	test('public channel message', () => {
		assert.deepEqual(parseMessageLink('https://t.me/mychannel/123'), { channel: { type: 'username', username: 'mychannel' }, messageId: 123 });
	});

	test('ignores query strings like ?single', () => {
		assert.equal(parseMessageLink('https://t.me/mychannel/123?single').messageId, 123);
		assert.equal(parseMessageLink('t.me/mychannel/123?comment=4').messageId, 123);
	});

	test('message inside a topic uses the last segment', () => {
		assert.equal(parseMessageLink('https://t.me/mychannel/7/123').messageId, 123);
		assert.deepEqual(parseMessageLink('https://t.me/c/1234567890/7/123'), { channel: { type: 'privateId', channelId: '1234567890' }, messageId: 123 });
	});

	test('private channel and web preview links', () => {
		assert.deepEqual(parseMessageLink('https://t.me/c/1234567890/42'), { channel: { type: 'privateId', channelId: '1234567890' }, messageId: 42 });
		assert.deepEqual(parseMessageLink('https://t.me/s/mychannel/42'), { channel: { type: 'username', username: 'mychannel' }, messageId: 42 });
	});

	test('rejects links without a message id', () => {
		assert.throws(() => parseMessageLink('https://t.me/mychannel'), /message id/);
		assert.throws(() => parseMessageLink('https://t.me/c/1234567890'), /message id/);
		assert.throws(() => parseMessageLink('https://t.me/mychannel/abc'), /message id/);
		assert.throws(() => parseMessageLink('mychannel/123'), /not a Telegram message link/);
	});
});

describe('parseMessageRange', () => {
	test('returns an inclusive id range for two links in the same channel', () => {
		assert.deepEqual(parseMessageRange('https://t.me/mychannel/100', 't.me/mychannel/250?single'), {
			channel: { type: 'username', username: 'mychannel' }, fromId: 100, toId: 250,
		});
	});

	test('accepts the links in either order and a single-message range', () => {
		assert.deepEqual(parseMessageRange('https://t.me/c/123456/90', 'https://t.me/c/123456/40'), {
			channel: { type: 'privateId', channelId: '123456' }, fromId: 40, toId: 90,
		});
		const same = parseMessageRange('https://t.me/mychannel/7', 'https://t.me/mychannel/7');
		assert.equal(same.fromId, 7);
		assert.equal(same.toId, 7);
	});

	test('treats usernames case-insensitively', () => {
		assert.equal(parseMessageRange('https://t.me/MyChannel/1', 'https://t.me/mychannel/2').toId, 2);
	});

	test('rejects links from different channels or without message ids', () => {
		assert.throws(() => parseMessageRange('https://t.me/channelone/1', 'https://t.me/channeltwo/2'), /same channel/);
		assert.throws(() => parseMessageRange('https://t.me/mychannel/1', 'https://t.me/c/123/2'), /same channel/);
		assert.throws(() => parseMessageRange('https://t.me/mychannel/1', 'https://t.me/mychannel'), /message id/);
	});
});

describe('parseDateFilter', () => {
	test('blank means no filter', () => {
		assert.equal(parseDateFilter(''), null);
		assert.equal(parseDateFilter('   '), null);
	});

	test('single date covers the whole local day', () => {
		const filter = parseDateFilter('2026-10-19');
		assert.equal(filter.from, unix(2026, 10, 19));
		assert.equal(filter.to, unix(2026, 10, 20));
		assert.equal(filter.label, '2026-10-19');
		assert.ok(isWithinDateFilter(unix(2026, 10, 19, 0, 0), filter));
		assert.ok(isWithinDateFilter(unix(2026, 10, 19, 23, 59), filter));
		assert.ok(!isWithinDateFilter(unix(2026, 10, 18, 23, 59), filter));
		assert.ok(!isWithinDateFilter(unix(2026, 10, 20, 0, 0), filter));
	});

	test('inclusive ranges with .. or "to"', () => {
		for (const input of ['2026-10-01..2026-10-19', '2026-10-01 to 2026-10-19', '2026-10-01 .. 2026-10-19']) {
			const filter = parseDateFilter(input);
			assert.equal(filter.from, unix(2026, 10, 1), input);
			assert.equal(filter.to, unix(2026, 10, 20), input);
			assert.equal(filter.label, '2026-10-01 to 2026-10-19');
		}
	});

	test('open-ended ranges', () => {
		const since = parseDateFilter('2026-10-01..');
		assert.equal(since.from, unix(2026, 10, 1));
		assert.equal(since.to, null);
		assert.ok(isWithinDateFilter(unix(2030, 1, 1), since));

		const until = parseDateFilter('..2026-10-19');
		assert.equal(until.from, null);
		assert.equal(until.to, unix(2026, 10, 20));
		assert.ok(isWithinDateFilter(0, until));
	});

	test('rejects invalid dates and ranges', () => {
		assert.throws(() => parseDateFilter('2026-02-30'), /not a valid date/);
		assert.throws(() => parseDateFilter('19-10-2026'), /not a valid date/);
		assert.throws(() => parseDateFilter('yesterday'), /not a valid date/);
		assert.throws(() => parseDateFilter('2026-10-19..2026-10-01'), /start date/);
		assert.throws(() => parseDateFilter('..'), /at least/);
		assert.throws(() => parseDateFilter('2026-10-01..2026-10-02..2026-10-03'), /Invalid/);
	});

	test('handles month and year boundaries', () => {
		const filter = parseDateFilter('2026-12-31');
		assert.equal(filter.to, unix(2027, 1, 1));
	});
});

describe('parseSelection', () => {
	test('numbers, ranges and mixed separators', () => {
		assert.deepEqual(parseSelection('1,3,5-8', 10), [0, 2, 4, 5, 6, 7]);
		assert.deepEqual(parseSelection('2 4  6', 10), [1, 3, 5]);
		assert.deepEqual(parseSelection('3-3', 5), [2]);
	});

	test('deduplicates and sorts', () => {
		assert.deepEqual(parseSelection('5,1,1-3,2', 5), [0, 1, 2, 4]);
	});

	test('all / * / blank', () => {
		assert.deepEqual(parseSelection('all', 3), [0, 1, 2]);
		assert.deepEqual(parseSelection('ALL', 2), [0, 1]);
		assert.deepEqual(parseSelection('*', 2), [0, 1]);
		assert.deepEqual(parseSelection('', 5), []);
	});

	test('rejects out-of-range and malformed input', () => {
		assert.throws(() => parseSelection('0', 5), /outside/);
		assert.throws(() => parseSelection('6', 5), /outside/);
		assert.throws(() => parseSelection('4-9', 5), /outside/);
		assert.throws(() => parseSelection('5-2', 5), /greater/);
		assert.throws(() => parseSelection('1,a', 5), /understand/);
		assert.throws(() => parseSelection('-3', 5), /understand/);
	});
});

describe('file naming', () => {
	test('extensionFromMimeType', () => {
		assert.equal(extensionFromMimeType('application/pdf'), 'pdf');
		assert.equal(extensionFromMimeType('video/x-matroska'), 'mkv');
		assert.equal(extensionFromMimeType('audio/wav'), 'wav');
		assert.equal(extensionFromMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), '');
		assert.equal(extensionFromMimeType(undefined), '');
	});

	test('sanitizeFileName removes characters that break paths', () => {
		assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j.txt'), 'a_b_c_d_e_f_g_h_i_j.txt');
		assert.equal(sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
		assert.equal(sanitizeFileName('  name   with  spaces .  '), 'name with spaces');
		assert.equal(sanitizeFileName(''), 'file');
		assert.equal(sanitizeFileName('...'), 'file');
	});

	test('buildLocalFileName prefixes the message id', () => {
		assert.equal(buildLocalFileName({ messageId: 42, name: 'Movie: Part 1.mkv' }), '(42) Movie_ Part 1.mkv');
	});
});

describe('formatting', () => {
	test('formatBytes', () => {
		assert.equal(formatBytes(0), '0 B');
		assert.equal(formatBytes(512), '512 B');
		assert.equal(formatBytes(1536), '1.5 KB');
		assert.equal(formatBytes(5 * 1024 * 1024 * 1024), '5.0 GB');
	});

	test('formatDuration', () => {
		assert.equal(formatDuration(0), '0s');
		assert.equal(formatDuration(59.6), '1m 0s');
		assert.equal(formatDuration(125), '2m 5s');
		assert.equal(formatDuration(3 * 3600 + 61), '3h 1m 1s');
	});

	test('formatFileTable numbers rows from 1 and aligns them', () => {
		const files = Array.from({ length: 10 }, (_, i) => ({ date: unix(2026, 10, 19, 9, 5), size: 2048, name: `file${i}.pdf` }));
		const lines = formatFileTable(files).split('\n');
		assert.equal(lines.length, 10);
		assert.match(lines[0], /^ 1\. 2026-10-19 09:05 +2\.0 KB {2}file0\.pdf$/);
		assert.match(lines[9], /^10\. /);
	});

	test('formatFileTable truncates long names', () => {
		const [line] = formatFileTable([{ date: 0, size: 1, name: 'x'.repeat(100) }], 20).split('\n');
		assert.ok(line.endsWith(`${'x'.repeat(17)}...`));
	});
});
