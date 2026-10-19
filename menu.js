import checkbox from '@inquirer/checkbox';
import { readInput, releaseInput } from './helper.js';
import {
	resolveChannel,
	fetchFilesFromChannel,
	fetchFileFromMessageLink,
	fetchFilesBetweenMessageLinks,
	downloadFiles,
} from './downloader.js';
import {
	parseDateFilter,
	parseSelection,
	parseMessageLink,
	parseMessageRange,
	formatFileTable,
	formatBytes,
	formatMessageDate,
} from './parsers.js';

export const MENU_OPTIONS = [
	{ key: '1', label: 'Download all files from a channel', action: () => downloadAllFromChannel() },
	{ key: '2', label: 'List files from a channel (optionally from a specific date) and download the selected ones', action: () => listAndDownloadSelected() },
	{ key: '3', label: 'Download a single file from its message link (e.g. https://t.me/channel/123)', action: () => downloadFromMessageLink() },
	{ key: '4', label: 'List files between two message links (both included) and download the selected ones', action: () => listAndDownloadBetweenLinks() },
	{ key: '0', label: 'Exit', action: null },
];

// Keeps asking until `parse` accepts the answer. `parse` should throw an Error with a helpful message otherwise.
// With `required`, an empty line (e.g. an extra Enter after pasting a link) just asks again without an error.
export const askUntilValid = async (question, parse, { required = false } = {}) => {
	while (true) {
		const answer = await readInput(question);
		if (required && !answer.trim()) continue;
		try {
			return await parse(answer);
		} catch (error) {
			console.error(`  ${error.error_message ?? error.message ?? error}`);
		}
	}
};

const confirm = async (question) => {
	const answer = await readInput(`${question} (y/N): `);
	return /^y(es)?$/i.test(answer.trim());
};

const totalSize = (files) => files.reduce((sum, file) => sum + file.size, 0);

const askForChannel = () => askUntilValid('Enter the telegram channel link (e.g. https://t.me/channelname): ', (answer) => resolveChannel(answer), { required: true });

// Option 1
export const downloadAllFromChannel = async () => {
	const channel = await askForChannel();
	const files = await fetchFilesFromChannel(channel);

	if (!files.length) {
		console.info('No files found in the channel.');
		return;
	}

	if (!(await confirm(`Download all ${files.length} files (${formatBytes(totalSize(files))})?`))) {
		console.info('Cancelled.');
		return;
	}

	await downloadFiles(files);
};

const isInteractiveTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

// Fallback for piped/scripted input: numbered list + typed selection such as 1,3,5-8 or "all".
const chooseFilesByTyping = async (files) => {
	console.info(`\n${formatFileTable(files)}\n`);
	const indexes = await askUntilValid(
		'Select files to download (e.g. 1,3,5-8 or "all"; press Enter to cancel): ',
		(answer) => parseSelection(answer, files.length),
	);
	return indexes.map((i) => files[i]);
};

// Arrow keys to move, space to tick, "a" to toggle all, "i" to invert, Enter to confirm. Ctrl+C cancels.
const chooseFilesWithCheckboxes = async (files, prompt) => {
	const columns = process.stdout.columns || 100;
	const rows = process.stdout.rows || 24;
	const lines = formatFileTable(files, Math.max(20, columns - 45)).split('\n');

	releaseInput(); // the checkbox needs the terminal to itself
	try {
		return await prompt({
			message: `Select files to download (${files.length} listed, ${formatBytes(totalSize(files))} in total)`,
			choices: files.map((file, i) => ({ value: file, name: lines[i], short: file.name })),
			pageSize: Math.max(5, Math.min(20, rows - 6)),
			loop: false,
			theme: { style: { renderSelectedChoices: (selected) => `${selected.length} file(s)` } },
		});
	} catch (error) {
		if (error?.name === 'ExitPromptError' || error?.name === 'AbortPromptError') return [];
		throw error;
	}
};

/**
 * Lets the user pick files: checkboxes in a real terminal, typed numbers otherwise.
 * `interactive` and `prompt` can be overridden (used by the tests).
 */
export const chooseFiles = (files, { interactive = isInteractiveTerminal(), prompt = checkbox } = {}) => (
	interactive ? chooseFilesWithCheckboxes(files, prompt) : chooseFilesByTyping(files)
);

// Lets the user pick from a list of files, confirms, and downloads them. Shared by options 2 and 4.
const selectAndDownload = async (files) => {
	const selected = await chooseFiles(files);

	if (!selected.length) {
		console.info('Nothing selected.');
		return;
	}

	console.info(`\nSelected ${selected.length} file(s), ${formatBytes(totalSize(selected))} in total:`);
	for (const file of selected) console.info(`  - ${file.name}`);

	if (!(await confirm('Start download?'))) {
		console.info('Cancelled.');
		return;
	}

	await downloadFiles(selected);
};

// Option 2 (with optional date filter)
export const listAndDownloadSelected = async () => {
	const channel = await askForChannel();

	const dateFilter = await askUntilValid(
		'Only list files from a specific date? Enter YYYY-MM-DD, a range like 2026-10-01..2026-10-19, '
		+ 'an open range like 2026-10-01.. , or press Enter for all dates: ',
		parseDateFilter,
	);

	const files = await fetchFilesFromChannel(channel, { dateFilter });

	if (!files.length) {
		console.info(dateFilter ? `No files found for ${dateFilter.label}.` : 'No files found in the channel.');
		return;
	}

	await selectAndDownload(files);
};

// Option 3
export const downloadFromMessageLink = async () => {
	const file = await askUntilValid(
		'Enter the message link of the file (e.g. https://t.me/channelname/123): ',
		(answer) => fetchFileFromMessageLink(answer),
		{ required: true },
	);

	console.info(`Found "${file.name}" (${formatBytes(file.size)}) posted ${formatMessageDate(file.date)} in ${file.channel.title}.`);
	await downloadFiles([file], { pauseMs: 0 });
};

// Option 4
export const listAndDownloadBetweenLinks = async () => {
	const fromLink = await askUntilValid(
		'Enter the FIRST message link of the range (e.g. https://t.me/channelname/100): ',
		(answer) => { parseMessageLink(answer); return answer; },
		{ required: true },
	);

	const { files, fromId, toId } = await askUntilValid(
		'Enter the LAST message link of the range (e.g. https://t.me/channelname/250): ',
		(answer) => {
			parseMessageRange(fromLink, answer); // validate before hitting the network
			return fetchFilesBetweenMessageLinks(fromLink, answer);
		},
		{ required: true },
	);

	if (!files.length) {
		console.info(`No files found between messages ${fromId} and ${toId}.`);
		return;
	}

	await selectAndDownload(files);
};

export const printMenu = () => {
	console.info('\nWhat would you like to do?');
	for (const option of MENU_OPTIONS) console.info(`  ${option.key}. ${option.label}`);
};

// Shows the menu until the user exits. Errors inside an option return the user to the menu instead of crashing.
export const runMenu = async () => {
	while (true) {
		printMenu();
		const choice = (await readInput('Choose an option: ')).trim();
		const option = MENU_OPTIONS.find((o) => o.key === choice);

		if (!option) {
			console.error(`  "${choice}" is not a valid option.`);
			continue;
		}
		if (!option.action) return;

		try {
			await option.action();
		} catch (error) {
			console.error(`\nSomething went wrong: ${error.error_message ?? error.message ?? error}`);
		}
	}
};
