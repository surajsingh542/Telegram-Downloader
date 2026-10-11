import fs from 'node:fs'
import path from 'node:path'
import { callApi, sleep, drawProgressBar } from "./helper.js";
import mtproto from './mtProto.js';
import { speedTracker, downloadsFolderPath } from './config.js';

// Fetch files from the channel
export const fetchFilesFromChannel = async (channelLink) => {
	try {
		const username = channelLink.replace('https://t.me/', '');
		const updates = await callApi('contacts.resolveUsername', { username });

		const channel = updates.chats[0];
		const channelId = channel.id;
		const accessHash = channel.access_hash;

		console.log(`Fetching files from channel: ${channel.title}`);

		let offsetId = 0;
		const limit = 100;
		let files = [];

		while (true) {
			const history = await callApi('messages.getHistory', {
				peer: {
					_: 'inputPeerChannel',
					channel_id: channelId,
					access_hash: accessHash,
				},
				offset_id: offsetId,
				limit,
			});

			const messages = history.messages;
			if (!messages || messages.length === 0) break;

			files.push(
				...messages
					.filter((msg) => msg.media && msg.media.document)
					.map((msg) => {
						// Extract filename if available from attributes
						const fileAttributes = msg.media.document.attributes || [];
						const nameAttr = fileAttributes.find(attr => attr._ === 'documentAttributeFilename');
						return {
							id: msg.media.document.id,
							access_hash: msg.media.document.access_hash,
							file_reference: msg.media.document.file_reference,
							size: msg.media.document.size,
							name: nameAttr ? nameAttr.file_name : `file_${msg.media.document.id}`
						};
					})
			);

			if (messages.length < limit) break;
			offsetId = messages[messages.length - 1].id;
		}

		console.log(`Found ${files.length} files in the channel.`);
		return files.reverse();
	} catch (error) {
		console.error('Error fetching files:', error);
		throw error;
	}
};

// Download a specific file
export const downloadFile = async (fileId, accessHash, fileReference, fileName, totalSize, dcId = null, startTime = null) => {
	const filePath = path.join(downloadsFolderPath, fileName);
	let offset = 0;
	const chunkSize = 512 * 1024;

	// 1. AUTO-RESUME CHECK: Inspect local disk for partial fragments
	if (fs.existsSync(filePath)) {
		const stat = fs.statSync(filePath);

		if (stat.size >= totalSize) {
			console.log(`\n[Skipped] ${fileName} already fully downloaded.`);
			return;
		}

		// Align Telegram's chunks (must be a multiple of 4KB). 
		// If a previous chunk broke mid-transit, roll back to the nearest safe chunk boundary.
		offset = Math.floor(stat.size / (4 * 1024)) * (4 * 1024);
		console.log(`\n[Resuming] Found partial file. Resuming from offset: ${(offset / (1024 * 1024)).toFixed(2)} MB`);
	}

	// ONLY wipe history on a brand-new file initialization (not on DC migration reroutes)
	if (!dcId) {
		speedTracker.history = [];
	}

	// 2. Open Stream in Append Mode ('a') so it doesn't overwrite existing progress
	const fileStream = fs.createWriteStream(filePath, { flags: 'a', start: offset });

	if (!startTime) {
		startTime = Date.now();
	}

	drawProgressBar(fileName, offset, totalSize, startTime);

	try {
		while (true) {
			try {
				const data = await mtproto.call('upload.getFile', {
					location: {
						_: 'inputDocumentFileLocation',
						id: fileId,
						access_hash: accessHash,
						file_reference: fileReference,
					},
					offset,
					limit: chunkSize,
				}, dcId ? { dcId } : {});

				if (!data || !data.bytes || data.bytes.length === 0) {
					drawProgressBar(fileName, totalSize, totalSize, startTime);
					console.log(`\nFinished downloading: ${fileName}`);
					break;
				}

				fileStream.write(Buffer.from(data.bytes));
				offset += data.bytes.length;

				drawProgressBar(fileName, offset, totalSize, startTime);

			} catch (error) {
				if (error.error_message && error.error_message.startsWith('FLOOD_WAIT_')) {
					const waitTime = parseInt(error.error_message.split('_').pop(), 10);
					console.log(`\nFlood wait detected. Sleeping for ${waitTime} seconds...`);
					await sleep(waitTime * 1000);
					startTime += (waitTime * 1000); // Adjust ETA clock
				} else if (error.error_message && error.error_message.startsWith('FILE_MIGRATE_')) {
					const newDcId = parseInt(error.error_message.split('_').pop(), 10);
					console.log(`\nFile is in data center ${newDcId}. Re-routing request...`);

					fileStream.end();
					// Carry the metrics over to the target DC instance safely
					return downloadFile(fileId, accessHash, fileReference, fileName, totalSize, newDcId, startTime);
				} else if (error.error_message === 'OFFSET_INVALID') {
					drawProgressBar(fileName, totalSize, totalSize, startTime);
					console.log('\nFinished stream boundaries (OFFSET_INVALID).');
					break;
				} else {
					throw error;
				}
			}
		}
	} catch (error) {
		console.error(`\nFatal failure during file download (${fileName}):`, error);
	} finally {
		fileStream.end();
	}
};