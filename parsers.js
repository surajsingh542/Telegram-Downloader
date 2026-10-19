// Pure parsing/formatting helpers. No Telegram or filesystem access here so they can be unit tested.

// Extracts the URL path segments from anything that looks like a t.me / telegram.me link.
// Returns null when the input is not a Telegram link.
const getTelegramPathSegments = (input) => {
	const trimmed = String(input ?? '').trim();
	const match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)(?:\/(.*))?$/i);
	if (!match) return null;

	const pathOnly = (match[1] ?? '').split(/[?#]/)[0];
	return pathOnly.split('/').filter(Boolean);
};

const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

/**
 * Parses whatever the user typed as a channel reference.
 * Supported:
 *   https://t.me/name, t.me/name, @name, name, https://t.me/s/name   -> { type: 'username', username }
 *   https://t.me/c/1234567890                                       -> { type: 'privateId', channelId }
 *   https://t.me/+hash, https://t.me/joinchat/hash                   -> { type: 'invite', hash }
 */
export const parseChannelInput = (input) => {
	const trimmed = String(input ?? '').trim();
	if (!trimmed) throw new Error('Channel link cannot be empty.');

	const segments = getTelegramPathSegments(trimmed);

	if (!segments) {
		const username = trimmed.replace(/^@/, '');
		if (USERNAME_PATTERN.test(username)) return { type: 'username', username };
		throw new Error(`"${trimmed}" is not a valid Telegram channel link or username.`);
	}

	if (segments.length === 0) throw new Error('Channel link is missing the channel name.');

	const [first, second] = segments;

	if (first.startsWith('+')) return { type: 'invite', hash: first.slice(1) };
	if (first === 'joinchat' && second) return { type: 'invite', hash: second };
	if (first === 'c' && /^\d+$/.test(second ?? '')) return { type: 'privateId', channelId: second };
	if (first === 's' && second && USERNAME_PATTERN.test(second)) return { type: 'username', username: second };
	if (USERNAME_PATTERN.test(first)) return { type: 'username', username: first };

	throw new Error(`Could not understand channel link "${trimmed}".`);
};

/**
 * Parses a link pointing to a single message (the "fileUrl" of a post).
 * Supported:
 *   https://t.me/name/123                  (public channel)
 *   https://t.me/name/45/123               (public channel, message inside a topic)
 *   https://t.me/c/1234567890/123          (private channel)
 *   https://t.me/c/1234567890/45/123       (private channel, message inside a topic)
 *   https://t.me/s/name/123                (web preview link)
 * Query strings such as ?single or ?comment=1 are ignored.
 * Returns { channel: <parseChannelInput result>, messageId: number }.
 */
export const parseMessageLink = (input) => {
	const trimmed = String(input ?? '').trim();
	const segments = getTelegramPathSegments(trimmed);
	if (!segments) throw new Error(`"${trimmed}" is not a Telegram message link (expected https://t.me/<channel>/<messageId>).`);

	let channelSegments;
	let rest;

	if (segments[0] === 'c') {
		channelSegments = segments.slice(0, 2);
		rest = segments.slice(2);
	} else if (segments[0] === 's') {
		channelSegments = segments.slice(0, 2);
		rest = segments.slice(2);
	} else {
		channelSegments = segments.slice(0, 1);
		rest = segments.slice(1);
	}

	const messagePart = rest[rest.length - 1];
	if (!messagePart || !/^\d+$/.test(messagePart) || rest.length > 2) {
		throw new Error(`"${trimmed}" does not contain a message id (expected https://t.me/<channel>/<messageId>).`);
	}

	const channel = parseChannelInput(`https://t.me/${channelSegments.join('/')}`);
	if (channel.type === 'invite') throw new Error('Invite links do not point to a specific message.');

	return { channel, messageId: Number(messagePart) };
};

const sameChannel = (a, b) => {
	if (a.type !== b.type) return false;
	if (a.type === 'username') return a.username.toLowerCase() === b.username.toLowerCase();
	return a.channelId === b.channelId;
};

/**
 * Parses a "from" and "to" message link into an inclusive message id range in one channel.
 * The links may be given in either order. Returns { channel, fromId, toId } with fromId <= toId.
 */
export const parseMessageRange = (fromLink, toLink) => {
	const from = parseMessageLink(fromLink);
	const to = parseMessageLink(toLink);
	if (!sameChannel(from.channel, to.channel)) {
		throw new Error('Both message links must be from the same channel.');
	}
	return {
		channel: from.channel,
		fromId: Math.min(from.messageId, to.messageId),
		toId: Math.max(from.messageId, to.messageId),
	};
};

// Parses YYYY-MM-DD into a local-time Date at 00:00. Returns null if it is not a real calendar date.
const parseLocalDate = (text) => {
	const match = String(text).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (!match) return null;

	const [year, month, day] = match.slice(1).map(Number);
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date;
};

const toUnixSeconds = (date) => Math.floor(date.getTime() / 1000);

const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/**
 * Parses a date filter in the user's local timezone.
 *   ''                         -> null (no filter)
 *   2026-10-19                 -> that whole day
 *   2026-10-01..2026-10-19     -> inclusive range (also accepts " to " as the separator)
 *   2026-10-01..               -> from that day onwards
 *   ..2026-10-19               -> up to and including that day
 * Returns { from, to, label } where from/to are unix seconds (from inclusive, to exclusive), either may be null.
 */
export const parseDateFilter = (input) => {
	const trimmed = String(input ?? '').trim();
	if (!trimmed) return null;

	const parts = trimmed.includes('..')
		? trimmed.split('..')
		: trimmed.split(/\s+to\s+/i);

	if (parts.length > 2) throw new Error(`Invalid date filter "${trimmed}".`);

	const parsePart = (part) => {
		if (!part.trim()) return null;
		const date = parseLocalDate(part);
		if (!date) throw new Error(`"${part.trim()}" is not a valid date. Use YYYY-MM-DD.`);
		return date;
	};

	if (parts.length === 1) {
		const day = parsePart(parts[0]);
		return { from: toUnixSeconds(day), to: toUnixSeconds(addDays(day, 1)), label: formatDay(day) };
	}

	const start = parsePart(parts[0]);
	const end = parsePart(parts[1]);
	if (!start && !end) throw new Error('A date range needs at least a start or an end date.');
	if (start && end && start > end) throw new Error('The start date must be on or before the end date.');

	const label = `${start ? formatDay(start) : 'the beginning'} to ${end ? formatDay(end) : 'now'}`;
	return {
		from: start ? toUnixSeconds(start) : null,
		to: end ? toUnixSeconds(addDays(end, 1)) : null,
		label,
	};
};

export const isWithinDateFilter = (unixSeconds, filter) => {
	if (!filter) return true;
	if (filter.from !== null && unixSeconds < filter.from) return false;
	if (filter.to !== null && unixSeconds >= filter.to) return false;
	return true;
};

/**
 * Parses a selection of 1-based list numbers such as "1,3,5-8" or "all".
 * Returns a sorted array of unique 0-based indexes. Throws on anything out of range.
 */
export const parseSelection = (input, total) => {
	const trimmed = String(input ?? '').trim().toLowerCase();
	if (!trimmed) return [];
	if (trimmed === 'all' || trimmed === '*') return Array.from({ length: total }, (_, i) => i);

	const indexes = new Set();

	for (const rawToken of trimmed.split(/[\s,]+/).filter(Boolean)) {
		const range = rawToken.match(/^(\d+)-(\d+)$/);
		const single = rawToken.match(/^\d+$/);

		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (start > end) throw new Error(`Invalid range "${rawToken}": start is greater than end.`);
			if (start < 1 || end > total) throw new Error(`Range "${rawToken}" is outside 1-${total}.`);
			for (let n = start; n <= end; n++) indexes.add(n - 1);
		} else if (single) {
			const n = Number(rawToken);
			if (n < 1 || n > total) throw new Error(`Number ${n} is outside 1-${total}.`);
			indexes.add(n - 1);
		} else {
			throw new Error(`Could not understand "${rawToken}". Use numbers like 1,3,5-8 or "all".`);
		}
	}

	return [...indexes].sort((a, b) => a - b);
};

const MIME_EXTENSIONS = {
	'application/pdf': 'pdf',
	'application/zip': 'zip',
	'application/x-rar-compressed': 'rar',
	'application/vnd.rar': 'rar',
	'application/x-7z-compressed': '7z',
	'application/epub+zip': 'epub',
	'application/vnd.android.package-archive': 'apk',
	'application/x-tgsticker': 'tgs',
	'audio/mpeg': 'mp3',
	'audio/ogg': 'ogg',
	'audio/mp4': 'm4a',
	'audio/x-flac': 'flac',
	'audio/flac': 'flac',
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'video/mp4': 'mp4',
	'video/x-matroska': 'mkv',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'text/plain': 'txt',
};

export const extensionFromMimeType = (mimeType) => {
	if (!mimeType) return '';
	if (MIME_EXTENSIONS[mimeType]) return MIME_EXTENSIONS[mimeType];
	const subtype = mimeType.split('/')[1] ?? '';
	return /^[a-z0-9]{1,5}$/i.test(subtype) ? subtype.toLowerCase() : '';
};

// Strips characters that are invalid in file names on macOS/Windows/Linux.
export const sanitizeFileName = (name) => {
	const cleaned = String(name ?? '')
		.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '');
	return cleaned || 'file';
};

/**
 * Builds the name a file is saved under. Prefixing with the Telegram message id keeps names unique
 * and stable across every download mode, which is what makes auto-resume work no matter how the
 * file was selected.
 */
export const buildLocalFileName = ({ messageId, name }) => `(${messageId}) ${sanitizeFileName(name)}`;

export const formatBytes = (bytes) => {
	const value = Number(bytes) || 0;
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}
	return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
};

export const formatDuration = (totalSeconds) => {
	const seconds = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h) return `${h}h ${m}m ${s}s`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
};

const pad = (n) => String(n).padStart(2, '0');

export const formatDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const formatMessageDate = (unixSeconds) => {
	const date = new Date(unixSeconds * 1000);
	return `${formatDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const truncate = (text, maxLength) => text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;

// Renders the numbered table shown in the selection modes.
export const formatFileTable = (files, maxNameLength = 60) => {
	const numberWidth = String(files.length).length;
	return files.map((file, i) => {
		const number = String(i + 1).padStart(numberWidth, ' ');
		const size = formatBytes(file.size).padStart(9, ' ');
		return `${number}. ${formatMessageDate(file.date)}  ${size}  ${truncate(file.name, maxNameLength)}`;
	}).join('\n');
};
