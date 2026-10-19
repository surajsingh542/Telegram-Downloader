import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import { createRequire } from 'node:module';
import { NativeCTR, NativeIGE, handleData, originals, applyMtprotoPatches } from '../mtprotoPatches.js';

const require = createRequire(import.meta.url);
const AES = require('@mtproto/core/src/crypto/aes');
const Transport = require('@mtproto/core/envs/node/transport');

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

describe('native AES matches the original aes-js implementation', () => {
	test('patches are applied to the library', () => {
		assert.equal(applyMtprotoPatches(), true);
		assert.equal(AES.CTR, NativeCTR);
		assert.equal(AES.IGE, NativeIGE);
		assert.equal(Transport.prototype.handleData, handleData);
	});

	test('CTR keeps its stream position across calls of any size', () => {
		const key = crypto.randomBytes(32);
		const iv = crypto.randomBytes(16);
		const data = crypto.randomBytes(100_003);
		const reference = new originals.CTR(key, iv);
		const native = new NativeCTR(key, iv);

		for (const [start, end] of [[0, 1], [1, 15], [15, 17], [17, 4096], [4096, 70_001], [70_001, data.length]]) {
			assert.ok(same(reference.encrypt(data.subarray(start, end)), native.encrypt(data.subarray(start, end))), `${start}-${end}`);
		}
	});

	test('IGE encrypt/decrypt match, including state carried between calls', () => {
		for (let round = 0; round < 5; round++) {
			const key = crypto.randomBytes(32);
			const iv = crypto.randomBytes(32);
			const first = crypto.randomBytes(16 * (1 + round));
			const second = crypto.randomBytes(16 * 37);

			for (const op of ['encrypt', 'decrypt']) {
				const reference = new originals.IGE(key, iv);
				const native = new NativeIGE(key, iv);
				assert.ok(same(reference[op](first), native[op](first)), `${op} first`);
				assert.ok(same(reference[op](second), native[op](second)), `${op} second`);
			}
		}
	});

	test('IGE round-trips and accepts plain arrays like aes-js', () => {
		const key = Array.from(crypto.randomBytes(32));
		const iv = Array.from(crypto.randomBytes(32));
		const plaintext = crypto.randomBytes(16 * 64);
		const encrypted = new NativeIGE(key, iv).encrypt(Array.from(plaintext));
		assert.ok(same(new NativeIGE(key, iv).decrypt(encrypted), plaintext));
	});

	test('IGE rejects input that is not a multiple of 16 bytes', () => {
		assert.throws(() => new NativeIGE(crypto.randomBytes(32), crypto.randomBytes(32)).decrypt(new Uint8Array(17)), /multiple of 16/);
	});

	test('results own their ArrayBuffer (callers read `.buffer` directly)', () => {
		const result = new NativeCTR(crypto.randomBytes(32), crypto.randomBytes(16)).decrypt(Buffer.alloc(10));
		assert.ok(result instanceof Uint8Array);
		assert.equal(result.buffer.byteLength, 10);
	});
});

describe('patched Transport.handleData', () => {
	const key = crypto.randomBytes(32);
	const iv = crypto.randomBytes(16);

	const makeTransport = () => {
		const transport = Object.create(Transport.prototype);
		EventEmitter.call(transport);
		transport.pendingChunks = [];
		transport.pendingLength = 0;
		transport.decryptAES = new NativeCTR(key, iv);
		const events = [];
		transport.on('message', (buffer) => events.push({ kind: 'message', bytes: Buffer.from(buffer) }));
		transport.on('error', (error) => events.push({ kind: 'error', ...error }));
		return { transport, events };
	};

	const frame = (payload) => {
		const header = Buffer.alloc(4);
		header.writeUInt32LE(payload.length, 0);
		return Buffer.concat([header, payload]);
	};

	const errorFrame = (code) => {
		const bytes = Buffer.alloc(8);
		bytes.writeUInt32LE(4, 0);
		bytes.writeInt32LE(-code, 4);
		return bytes;
	};

	const feed = (transport, wire, sizes) => {
		for (let offset = 0, i = 0; offset < wire.length; i++) {
			const size = sizes[i % sizes.length];
			transport.handleData(Buffer.from(wire.subarray(offset, offset + size)));
			offset += size;
		}
	};

	test('reassembles frames split at every possible boundary, including inside the header', () => {
		const payloads = [crypto.randomBytes(9), crypto.randomBytes(1000), crypto.randomBytes(16), crypto.randomBytes(1)];
		const plainWire = Buffer.concat([...payloads.map(frame), errorFrame(404)]);

		for (const sizes of [[1], [2], [3], [5], [7, 1, 13], [plainWire.length]]) {
			const { transport, events } = makeTransport();
			feed(transport, new NativeCTR(key, iv).encrypt(plainWire), sizes);

			assert.equal(events.length, payloads.length + 1, `packets of ${sizes}`);
			payloads.forEach((payload, n) => assert.ok(events[n].bytes.equals(payload), `payload ${n} with packets of ${sizes}`));
			assert.deepEqual(events.at(-1), { kind: 'error', type: 'transport', code: 404 });
			assert.equal(transport.pendingLength, 0);
		}
	});

	test('reassembles large frames arriving in realistic TCP packet sizes', () => {
		const payloads = [crypto.randomBytes(1024 * 1024 + 64), crypto.randomBytes(300_000)];
		const plainWire = Buffer.concat(payloads.map(frame));

		for (const sizes of [[1460], [16384], [65536, 3], [plainWire.length]]) {
			const { transport, events } = makeTransport();
			feed(transport, new NativeCTR(key, iv).encrypt(plainWire), sizes);
			assert.equal(events.length, 2);
			payloads.forEach((payload, n) => assert.ok(events[n].bytes.equals(payload)));
		}
	});

	test('emitted message buffers contain exactly the payload', () => {
		const { transport } = makeTransport();
		const payload = crypto.randomBytes(40);
		let received;
		transport.on('message', (buffer) => { received = buffer; });
		transport.handleData(new NativeCTR(key, iv).encrypt(Buffer.concat([frame(payload), frame(crypto.randomBytes(8)).subarray(0, 6)])));
		assert.ok(received instanceof ArrayBuffer);
		assert.equal(received.byteLength, 40);
		assert.ok(Buffer.from(received).equals(payload));
		assert.equal(transport.pendingLength, 6, 'the partial second frame stays queued');
	});
});
