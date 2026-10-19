import MTProto from '@mtproto/core';
import './mtprotoPatches.js'; // native crypto + fast framing, see mtprotoPatches.js
import path from 'node:path'

// Initialize MTProto
const mtproto = new MTProto({
	api_id: process.env.api_id,
	api_hash: process.env.api_hash,
	storageOptions: {
		path: path.resolve('./session.json'),
	}
});

export default mtproto;