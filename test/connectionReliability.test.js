import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';

process.env.api_id ??= '1';
process.env.api_hash ??= 'test';

const { NativeCTR, MAX_PENDING_ACKS, RECONNECT_DELAYS_MS, forgetRequest } = await import('../mtprotoPatches.js');
const { default: mtproto } = await import('../mtProto.js');
const { connectionPool } = await import('../connectionPool.js');

const require = createRequire(import.meta.url);
const Transport = require('@mtproto/core/envs/node/transport');
const RPC = require('@mtproto/core/src/rpc');

const fakeCrypto = { getRandomBytes: (n) => new Uint8Array(crypto.randomBytes(n)) };
const waitFor = async (condition, ms = 2000) => {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error('condition not met in time');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

// A local TCP server standing in for a Telegram data center. It records what every connection receives.
const startServer = async () => {
	const connections = [];
	const server = net.createServer((socket) => {
		const connection = { socket, received: Buffer.alloc(0) };
		socket.on('data', (data) => { connection.received = Buffer.concat([connection.received, data]); });
		socket.on('error', () => {});
		connections.push(connection);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return { server, connections, dc: { id: 2, ip: '127.0.0.1', port: server.address().port } };
};

// Undoes the client side of the obfuscation, like Telegram does: keys come from the 64-byte init message.
const deobfuscate = (wire) => {
	const init = wire.subarray(0, 64);
	const ctr = new NativeCTR(init.subarray(8, 40), init.subarray(40, 56));
	return Buffer.from(ctr.decrypt(wire)).subarray(64);
};

const stopTransport = (transport) => {
	transport.connect = () => {};
	clearTimeout(transport.reconnectTimer);
	transport.socket.destroy();
};

const cleanups = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()();
});

describe('patched Transport connection handling', () => {
	const setup = async () => {
		const fake = await startServer();
		const transport = new Transport(fake.dc, fakeCrypto);
		transport.on('error', () => {}); // the RPC layer listens for these in the app
		cleanups.push(() => { stopTransport(transport); fake.server.close(); });
		return { ...fake, transport };
	};

	test('is only available once the obfuscation handshake has been sent', async () => {
		const { transport, connections } = await setup();
		assert.equal(transport.isAvailable, false, 'a connecting socket is writable but not usable yet');
		transport.send(new Uint8Array([1, 2, 3, 4])); // dropped, not written ahead of the handshake

		await once(transport, 'open');
		assert.equal(transport.isAvailable, true);
		await transport.send(new Uint8Array([9, 8, 7, 6]));
		await waitFor(() => connections[0]?.received.length >= 64 + 8);

		const plain = deobfuscate(connections[0].received);
		assert.deepEqual([...plain], [4, 0, 0, 0, 9, 8, 7, 6], 'only the message sent after the handshake arrives, framed correctly');
	});

	test('reconnects after the server closes the connection, and records incoming data', async () => {
		const { transport, connections } = await setup();
		await once(transport, 'open');
		const firstSocket = transport.socket;
		assert.ok(transport.lastReceivedAt <= Date.now());

		await waitFor(() => connections.length === 1);
		const reopened = new Promise((resolve) => transport.once('open', resolve)); // events.once would reject on the reset's 'error'
		connections[0].socket.destroy();
		await reopened;

		assert.notEqual(transport.socket, firstSocket);
		assert.equal(transport.isAvailable, true);
		assert.equal(transport.reconnectAttempts, 0, 'a successful handshake resets the backoff');
		await waitFor(() => connections.length === 2);
	});

	test('backs off between failed reconnects and ignores events from replaced sockets', async () => {
		const { transport } = await setup();
		await once(transport, 'open');

		const delays = [];
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = (fn, delay) => { delays.push(delay); return realSetTimeout(() => {}, 0); };
		try {
			for (let i = 0; i < RECONNECT_DELAYS_MS.length + 1; i++) {
				transport.reconnectTimer = null;
				transport.handleClose();
			}
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
		assert.deepEqual(delays, [...RECONNECT_DELAYS_MS, RECONNECT_DELAYS_MS.at(-1)]);

		// A second close while a reconnect is already scheduled does not schedule another one.
		const before = delays.length;
		transport.handleClose();
		assert.equal(delays.length, before);
	});
});

describe('patched RPC request tracking', () => {
	const makeRpc = () => {
		const rpc = Object.create(RPC.prototype);
		rpc.debug = () => {};
		rpc.messagesWaitResponse = new Map();
		rpc.messagesWaitAuth = [];
		rpc.pendingAcks = [];
		rpc.flushed = 0;
		rpc.sendAcks = Object.assign(() => {}, { flush: () => { rpc.flushed++; rpc.pendingAcks = []; } });
		rpc.sent = [];
		rpc.call = (method, params) => new Promise((resolve, reject) => rpc.sent.push({ method, params, resolve, reject }));
		return rpc;
	};

	const track = (rpc, id, method, extra = {}) => new Promise((resolve, reject) => {
		rpc.messagesWaitResponse.set(id, { method, params: { id }, resolve, reject, isAck: false, ...extra });
	});

	test('a reopened connection resends every unanswered request once, acknowledged or not', async () => {
		const rpc = makeRpc();
		const acked = track(rpc, '11', 'upload.getFile', { isAck: true });
		const notAcked = track(rpc, '13', 'upload.getFile');
		rpc.messagesWaitResponse.set('15', { isAck: true }); // ack for something never tracked
		const waitingForAuth = new Promise((resolve, reject) => rpc.messagesWaitAuth.push({ method: 'help.getConfig', params: {}, resolve, reject }));

		rpc.sendWaitMessages();

		assert.deepEqual(rpc.sent.map((m) => m.method), ['upload.getFile', 'upload.getFile', 'help.getConfig']);
		assert.equal(rpc.messagesWaitResponse.size, 0, 'old entries are dropped so the next reconnect does not duplicate them');
		assert.equal(rpc.messagesWaitAuth.length, 0);

		rpc.sent.forEach((m, i) => m.resolve(`answer ${i}`));
		assert.deepEqual(await Promise.all([acked, notAcked, waitingForAuth]), ['answer 0', 'answer 1', 'answer 2']);
	});

	test('an answer to a request that is no longer tracked is acknowledged instead of crashing', async () => {
		const rpc = makeRpc();
		await rpc.handleDecryptedMessage({ _: 'mt_rpc_result', req_msg_id: '999', result: { _: 'upload.file' } }, { messageId: '7' });
		assert.deepEqual(rpc.pendingAcks, ['7']);
	});

	test('answers to tracked requests still resolve and reject', async () => {
		const rpc = makeRpc();
		const ok = track(rpc, '21', 'upload.getFile');
		const bad = track(rpc, '23', 'upload.getFile');
		await rpc.handleDecryptedMessage({ _: 'mt_rpc_result', req_msg_id: '21', result: { _: 'upload.file', bytes: [1] } }, { messageId: '7' });
		await rpc.handleDecryptedMessage({ _: 'mt_rpc_result', req_msg_id: '23', result: { _: 'mt_rpc_error', error_message: 'X' } }, { messageId: '9' });
		assert.deepEqual(await ok, { _: 'upload.file', bytes: [1] });
		await assert.rejects(bad, { error_message: 'X' });
		assert.equal(rpc.messagesWaitResponse.size, 0);
	});

	test('acknowledgements only mark requests that are tracked', async () => {
		const rpc = makeRpc();
		track(rpc, '31', 'upload.getFile');
		await rpc.handleDecryptedMessage({ _: 'mt_msgs_ack', msg_ids: ['31', '33'] }, { messageId: '7' });
		assert.equal(rpc.messagesWaitResponse.get('31').isAck, true);
		assert.equal(rpc.messagesWaitResponse.has('33'), false);
	});

	test('acknowledgements are flushed during a busy download instead of being postponed forever', () => {
		const rpc = makeRpc();
		for (let i = 0; i < MAX_PENDING_ACKS - 1; i++) rpc.ackMessage(String(i * 2 + 1));
		assert.equal(rpc.flushed, 0);
		rpc.ackMessage('999');
		assert.equal(rpc.flushed, 1);
	});

	test('forgetRequest removes a request by its params object', () => {
		const rpc = makeRpc();
		const params = { offset: 0 };
		rpc.messagesWaitResponse.set('41', { method: 'upload.getFile', params });
		rpc.messagesWaitResponse.set('43', { method: 'upload.getFile', params: { offset: 0 } });
		rpc.messagesWaitAuth.push({ method: 'upload.getFile', params });
		forgetRequest(rpc, params);
		assert.deepEqual([...rpc.messagesWaitResponse.keys()], ['43']);
		assert.equal(rpc.messagesWaitAuth.length, 0);
	});
});

describe('connectionPool.abandon', () => {
	const setup = (lastReceivedAt) => {
		const params = { offset: 0 };
		let destroyed = false;
		const rpc = {
			messagesWaitResponse: new Map([['51', { method: 'upload.getFile', params }]]),
			messagesWaitAuth: [],
			transport: { lastReceivedAt, socket: { destroy: () => { destroyed = true; } } },
		};
		const original = mtproto.getRPC;
		mtproto.getRPC = () => rpc;
		cleanups.push(() => { mtproto.getRPC = original; });
		return { rpc, params, wasDestroyed: () => destroyed };
	};

	test('reopens a connection that has been silent since the request was sent', async () => {
		const { rpc, params, wasDestroyed } = setup(1000);
		assert.equal(await connectionPool.abandon(2, 0, params, { sentAt: 2000 }), true);
		assert.ok(wasDestroyed());
		assert.equal(rpc.messagesWaitResponse.size, 0);
	});

	test('keeps a connection that is still receiving data, but forgets the lost request', async () => {
		const { rpc, params, wasDestroyed } = setup(3000);
		assert.equal(await connectionPool.abandon(2, 0, params, { sentAt: 2000 }), false);
		assert.equal(wasDestroyed(), false);
		assert.equal(rpc.messagesWaitResponse.size, 0);
	});

	test('without sentAt it only forgets the request', async () => {
		const { params, wasDestroyed } = setup(undefined);
		assert.equal(await connectionPool.abandon(2, 0, params), false);
		assert.equal(wasDestroyed(), false);
	});
});
