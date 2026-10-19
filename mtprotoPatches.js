// Performance and reliability patches for @mtproto/core.
//
// Speed. Out of the box the library is CPU bound at roughly 1-2 MB/s regardless of how fast Telegram sends data:
//   1. Transport.handleData rebuilds its receive buffer with `new Uint8Array([...stream, ...bytes])` on every
//      TCP packet, which copies the whole buffer byte by byte (quadratic: ~700ms of CPU per 1MB response).
//   2. AES-CTR (transport obfuscation) and AES-IGE (MTProto encryption) run in pure JavaScript (aes-js).
//
// These patches swap in Node's native OpenSSL AES and a linear-time frame parser.
//
// Reliability. When a TCP connection drops, the library reconnects but silently loses requests:
//   3. It writes to the new socket before the obfuscation handshake is sent (a connecting socket is already
//      "writable"), so Telegram receives garbage and closes that connection too.
//   4. After reconnecting it only resends requests Telegram has not acknowledged yet. Telegram acknowledges
//      upload.getFile almost immediately, long before the 1MB answer, so an in-flight download chunk is never
//      resent and its promise hangs forever. Requests that *are* resent keep their old entry as well, so every
//      reconnect duplicates them.
//   5. An answer to a request it no longer tracks crashes it (`waitMessage` is undefined).
//   6. Acknowledgements are debounced without a maximum wait, so during a busy download they are never sent.
//   7. A failing connection is retried in a tight loop with no delay.
//
// The patches only touch the exact version they were written against; any other version is left unpatched
// with a warning.
import crypto from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const PATCHED_MTPROTO_VERSION = '6.3.0';

const AES = require('@mtproto/core/src/crypto/aes');
const RPC = require('@mtproto/core/src/rpc');
const Transport = require('@mtproto/core/envs/node/transport');
const { version: installedVersion } = require('@mtproto/core/package.json');

const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

// Callers use `.buffer` on results, so always hand back a Uint8Array that owns its own ArrayBuffer.
const toOwnedUint8Array = (buffer) => new Uint8Array(buffer);

// Drop-in replacement for aes-js' streaming CTR mode (same counter layout: 128-bit big-endian).
export class NativeCTR {
	constructor(key, iv) {
		this.cipher = crypto.createCipheriv(`aes-${key.length * 8}-ctr`, toBuffer(key), toBuffer(iv));
	}

	encrypt(bytes) {
		return toOwnedUint8Array(this.cipher.update(toBuffer(bytes)));
	}

	decrypt(bytes) {
		return this.encrypt(bytes);
	}
}

const xorInto = (target, targetOffset, a, aOffset, b, bOffset) => {
	for (let i = 0; i < 16; i++) target[targetOffset + i] = a[aOffset + i] ^ b[bOffset + i];
};

// AES-IGE built on native single-block AES-ECB. IGE chains on the previous plaintext, so it is inherently
// sequential, but a native block call is still far cheaper than aes-js.
export class NativeIGE {
	constructor(key, iv) {
		this.key = toBuffer(key);
		const ivBuffer = toBuffer(iv);
		this.iv1 = Buffer.from(ivBuffer.subarray(0, 16));
		this.iv2 = Buffer.from(ivBuffer.subarray(16, 32));
	}

	process(input, mode) {
		const source = toBuffer(input);
		if (source.length % 16 !== 0) {
			throw new Error(`invalid ${mode === 'encrypt' ? 'plaintext' : 'ciphertext'} size (must be multiple of 16 bytes)`);
		}

		const algorithm = `aes-${this.key.length * 8}-ecb`;
		const cipher = mode === 'encrypt'
			? crypto.createCipheriv(algorithm, this.key, null)
			: crypto.createDecipheriv(algorithm, this.key, null);
		cipher.setAutoPadding(false);

		const output = Buffer.allocUnsafe(source.length);
		const block = Buffer.allocUnsafe(16);
		// encrypt: c_i = E(p_i ^ c_{i-1}) ^ p_{i-1}   (c_0 = iv1, p_0 = iv2)
		// decrypt: p_i = D(c_i ^ p_{i-1}) ^ c_{i-1}   (c_0 = iv1, p_0 = iv2)
		let prevIn = mode === 'encrypt' ? this.iv2 : this.iv1;
		let prevOut = mode === 'encrypt' ? this.iv1 : this.iv2;
		let prevInOffset = 0;
		let prevOutOffset = 0;

		for (let i = 0; i < source.length; i += 16) {
			xorInto(block, 0, source, i, prevOut, prevOutOffset);
			const transformed = cipher.update(block);
			xorInto(output, i, transformed, 0, prevIn, prevInOffset);

			prevIn = source;
			prevInOffset = i;
			prevOut = output;
			prevOutOffset = i;
		}

		// Keep chaining state so consecutive calls behave like aes-js' stateful instance.
		if (source.length > 0) {
			const lastIn = Buffer.from(source.subarray(source.length - 16));
			const lastOut = Buffer.from(output.subarray(output.length - 16));
			if (mode === 'encrypt') {
				this.iv1 = lastOut;
				this.iv2 = lastIn;
			} else {
				this.iv1 = lastIn;
				this.iv2 = lastOut;
			}
		}

		return toOwnedUint8Array(output);
	}

	encrypt(plaintext) {
		return this.process(plaintext, 'encrypt');
	}

	decrypt(ciphertext) {
		return this.process(ciphertext, 'decrypt');
	}
}

// Linear-time replacement for Transport.prototype.handleData. Incoming packets are queued and only joined
// once a whole frame (intermediate transport: 4-byte little-endian length + payload) has arrived.
export function handleData(data) {
	this.lastReceivedAt = Date.now(); // lets a stuck request tell a dead connection from a slow one
	const bytes = this.decryptAES.decrypt(data);
	this.pendingChunks.push(bytes);
	this.pendingLength += bytes.length;

	// The minimum length is eight (transport error with an intermediate header)
	while (this.pendingLength >= 8) {
		if (this.pendingChunks[0].length < 4) {
			this.pendingChunks = [Buffer.concat(this.pendingChunks, this.pendingLength)];
		}

		const head = this.pendingChunks[0];
		const payloadLength = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, true);
		const frameLength = payloadLength + 4;
		if (this.pendingLength < frameLength) break;

		const joined = this.pendingChunks.length === 1 ? toBuffer(head) : Buffer.concat(this.pendingChunks, this.pendingLength);
		const payload = new Uint8Array(payloadLength);
		payload.set(joined.subarray(4, frameLength));

		const rest = joined.subarray(frameLength);
		this.pendingChunks = rest.length ? [rest] : [];
		this.pendingLength = rest.length;

		if (payloadLength === 4) {
			this.emit('error', { type: 'transport', code: new DataView(payload.buffer).getInt32(0, true) * -1 });
		} else {
			this.emit('message', payload.buffer);
		}
	}
}

// Reconnect immediately the first time, then back off so an offline network is not hammered.
export const RECONNECT_DELAYS_MS = [0, 1000, 2000, 5000, 10000];
// Send acknowledgements at least this often while answers keep arriving.
export const MAX_PENDING_ACKS = 16;

// Replacement for Transport.prototype.connect. Each socket's events are ignored once it has been replaced,
// and the transport only counts as available after the obfuscation handshake has been written.
export function connect() {
	clearTimeout(this.reconnectTimer);
	this.reconnectTimer = null;
	this.ready = false;
	this.stream = new Uint8Array();
	// Reset the receive queue on every (re)connect, exactly like the original resets `this.stream`.
	this.pendingChunks = [];
	this.pendingLength = 0;

	const socket = net.connect(this.dc.port, this.dc.ip, () => this.handleConnect(socket));
	this.socket = socket;

	socket.on('data', (data) => {
		if (socket === this.socket) this.handleData(data);
	});
	socket.on('error', () => {
		if (socket === this.socket) this.emit('error', { type: 'socket' });
	});
	socket.on('close', () => {
		if (socket === this.socket) this.handleClose();
	});

	this.debug('connect');
}

export async function handleConnect(socket) {
	if (socket !== this.socket) return;
	const initialMessage = await this.generateObfuscationKeys();
	if (socket !== this.socket || socket.destroyed) return;

	socket.write(initialMessage);
	this.ready = true;
	this.reconnectAttempts = 0;
	this.lastReceivedAt = Date.now();
	this.emit('open');
}

export function handleClose() {
	this.ready = false;
	if (!this.socket.destroyed) this.socket.destroy();
	if (this.reconnectTimer) return;

	const attempt = this.reconnectAttempts ?? 0;
	this.reconnectAttempts = attempt + 1;
	const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
	this.debug(`connection closed, reconnecting in ${delay}ms`);
	this.reconnectTimer = setTimeout(() => this.connect(), delay);
}

// Bytes for a connection that is not ready are dropped: the RPC layer resends every unanswered request when
// the connection opens again, so nothing is lost and nothing is sent twice.
export async function send(bytes) {
	if (!this.ready) return;
	this.socket.write(this.encryptAES.encrypt(this.getIntermediateBytes(bytes)));
}

function isAvailable() {
	return Boolean(this.ready && this.socket?.writable);
}

// Replacement for RPC.prototype.sendWaitMessages, run whenever the connection (re)opens. Every request that has
// not been answered yet is sent again, acknowledged or not, and its old entry is removed.
export function sendWaitMessages() {
	const pending = [...this.messagesWaitResponse.values(), ...this.messagesWaitAuth];
	this.messagesWaitResponse.clear();
	this.messagesWaitAuth = [];

	for (const { method, params, resolve, reject } of pending) {
		if (!method) continue; // an acknowledgement for a request that was not tracked
		this.call(method, params).then(resolve, reject);
	}
}

const originalHandleDecryptedMessage = RPC.prototype.handleDecryptedMessage;

export function handleDecryptedMessage(message, params = {}) {
	// An answer to a request that was resent or abandoned in the meantime: acknowledge it and move on.
	if (message?._ === 'mt_rpc_result' && !this.messagesWaitResponse.has(message.req_msg_id)) {
		this.ackMessage(params.messageId);
		return;
	}
	// Only mark requests we still track, instead of creating empty entries for unknown ids.
	if (message?._ === 'mt_msgs_ack') {
		message.msg_ids = message.msg_ids.filter((msgId) => this.messagesWaitResponse.has(msgId));
	}
	return originalHandleDecryptedMessage.call(this, message, params);
}

export function ackMessage(messageId) {
	this.pendingAcks.push(messageId);
	this.sendAcks();
	if (this.pendingAcks.length >= MAX_PENDING_ACKS) this.sendAcks.flush();
}

/**
 * Stops waiting for a request on this connection, so a later reconnect does not send it again.
 * Requests are matched by their `params` object, which the library keeps as-is when it resends.
 */
export const forgetRequest = (rpc, params) => {
	for (const [messageId, message] of rpc.messagesWaitResponse) {
		if (message.params === params) rpc.messagesWaitResponse.delete(messageId);
	}
	rpc.messagesWaitAuth = rpc.messagesWaitAuth.filter((message) => message.params !== params);
};

export const originals = {
	CTR: AES.CTR,
	IGE: AES.IGE,
	handleData: Transport.prototype.handleData,
	connect: Transport.prototype.connect,
	handleConnect: Transport.prototype.handleConnect,
	handleClose: Transport.prototype.handleClose,
	send: Transport.prototype.send,
	isAvailable: Object.getOwnPropertyDescriptor(Transport.prototype, 'isAvailable'),
	sendWaitMessages: RPC.prototype.sendWaitMessages,
	handleDecryptedMessage: originalHandleDecryptedMessage,
	ackMessage: RPC.prototype.ackMessage,
};

let applied = false;

export const applyMtprotoPatches = () => {
	if (applied) return true;

	if (installedVersion !== PATCHED_MTPROTO_VERSION) {
		console.warn(`[perf] @mtproto/core ${installedVersion} is installed but the patches target ${PATCHED_MTPROTO_VERSION}; running unpatched (slower and less reliable).`);
		return false;
	}

	AES.CTR = NativeCTR;
	AES.IGE = NativeIGE;

	Object.assign(Transport.prototype, { connect, handleConnect, handleClose, send, handleData });
	Object.defineProperty(Transport.prototype, 'isAvailable', { get: isAvailable, configurable: true });

	Object.assign(RPC.prototype, { sendWaitMessages, handleDecryptedMessage, ackMessage });

	applied = true;
	return true;
};

applyMtprotoPatches();
