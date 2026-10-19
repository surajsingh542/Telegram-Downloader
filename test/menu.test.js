import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.api_id ??= '1';
process.env.api_hash ??= 'test';
const { chooseFiles, MENU_OPTIONS } = await import('../menu.js');

const files = [
	{ messageId: 1, date: 1_790_000_000, size: 2048, name: 'a.pdf' },
	{ messageId: 2, date: 1_790_000_100, size: 4096, name: 'b.pdf' },
	{ messageId: 3, date: 1_790_000_200, size: 1024, name: 'c.pdf' },
];

describe('menu', () => {
	test('offers all four download options plus exit', () => {
		assert.deepEqual(MENU_OPTIONS.map((o) => o.key), ['1', '2', '3', '4', '0']);
		assert.match(MENU_OPTIONS[3].label, /between two message links/);
	});
});

describe('chooseFiles with checkboxes', () => {
	test('shows every file as an unticked checkbox with date, size and name, and returns the ticked files', async () => {
		let config;
		const selected = await chooseFiles(files, {
			interactive: true,
			prompt: async (c) => { config = c; return [files[0], files[2]]; },
		});

		assert.deepEqual(selected, [files[0], files[2]]);
		assert.equal(config.choices.length, 3);
		assert.equal(config.choices[1].value, files[1]);
		assert.match(config.choices[1].name, /2\. .*4\.0 KB {2}b\.pdf$/);
		assert.ok(config.choices.every((c) => !c.checked));
		assert.match(config.message, /3 listed, 7\.0 KB in total/);
		assert.equal(config.theme.style.renderSelectedChoices([1, 2]), '2 file(s)', 'long selections are summarised');
	});

	test('Ctrl+C in the checkbox list cancels instead of crashing', async () => {
		const exit = Object.assign(new Error('User force closed the prompt'), { name: 'ExitPromptError' });
		assert.deepEqual(await chooseFiles(files, { interactive: true, prompt: async () => { throw exit; } }), []);
	});

	test('other prompt errors are not swallowed', async () => {
		await assert.rejects(chooseFiles(files, { interactive: true, prompt: async () => { throw new Error('tty broke'); } }), /tty broke/);
	});
});
