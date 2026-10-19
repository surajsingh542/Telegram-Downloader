// Extra MTProto connections per data center for parallel file downloads.
//
// @mtproto/core keeps exactly one TCP connection per DC. A single connection is limited by round-trip
// latency and per-connection throttling, so official clients download over several connections at once.
// Each extra connection is a new MTProto session over the same (already authorized) auth key.
import { createRequire } from 'node:module';
import mtproto from './mtProto.js';
import { forgetRequest } from './mtprotoPatches.js';

const require = createRequire(import.meta.url);
const RPC = require('@mtproto/core/src/rpc');

const pools = new Map(); // dcId -> Promise<RPC[]>
const authImports = new Map(); // dcId -> Promise

export const resolveDcId = async (dcId) => dcId || (await mtproto.storage.get('defaultDcId')) || 2;

const createPool = async (dcId, size) => {
	// Talk to the DC over the main connection first so its auth key exists in storage before the extra
	// connections start; otherwise each one would generate (and overwrite) its own key.
	await mtproto.call('help.getConfig', {}, { dcId });

	const dc = mtproto.dcList.find(({ id }) => id === dcId);
	const extras = Array.from({ length: size - 1 }, () => new RPC({
		dc,
		context: mtproto,
		transport: mtproto.envMethods.createTransport(dc, mtproto.crypto),
	}));

	return [mtproto.getRPC(dcId), ...extras];
};

const getPool = (dcId, size) => {
	if (!pools.has(dcId)) {
		const pool = createPool(dcId, size);
		pools.set(dcId, pool);
		pool.catch(() => pools.delete(dcId));
	}
	return pools.get(dcId);
};

// The connection that serves `index` (size 1 means the library's own connection for that DC).
const getConnection = async (dcId, index, size) => {
	if (size <= 1) return mtproto.getRPC(dcId);
	const pool = await getPool(dcId, size);
	return pool[index % pool.length];
};

export const connectionPool = {
	// Calls `method` on connection number `index` (wrapped around the pool size) of the given DC.
	async call(dcId, index, method, params, { size = 1 } = {}) {
		const id = await resolveDcId(dcId);
		if (size <= 1) return mtproto.call(method, params, { dcId: id });

		const connection = await getConnection(id, index, size);
		return connection.call(method, params);
	},

	/**
	 * Gives up on a request that got no answer in time (the same `params` object that was passed to call()).
	 * The request is forgotten so a later reconnect does not send it again. If the connection has not received
	 * a single byte since `sentAt` it is dead (e.g. the network changed and the socket was never closed), so it
	 * is dropped and reopened, which also resends every other request that was waiting on it. Without `sentAt`
	 * the request is only forgotten. Resolves to true when the connection was reopened.
	 */
	async abandon(dcId, index, params, { size = 1, sentAt } = {}) {
		const connection = await getConnection(await resolveDcId(dcId), index, size);
		if (!connection) return false;
		forgetRequest(connection, params);

		const { transport } = connection;
		if (sentAt === undefined || (transport.lastReceivedAt ?? 0) > sentAt) return false;
		transport.socket?.destroy(); // the transport reconnects on 'close'
		return true;
	},

	// Copies the login from the home DC to another DC (needed when a file lives on a DC this session never used).
	importAuthorization(dcId) {
		if (!authImports.has(dcId)) {
			const promise = (async () => {
				const exported = await mtproto.call('auth.exportAuthorization', { dc_id: dcId });
				await mtproto.call('auth.importAuthorization', { id: exported.id, bytes: exported.bytes }, { dcId, syncAuth: false });
			})();
			authImports.set(dcId, promise);
			promise.catch(() => authImports.delete(dcId));
		}
		return authImports.get(dcId);
	},
};
