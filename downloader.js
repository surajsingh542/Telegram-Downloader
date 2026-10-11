require("dotenv").config();
const MTProto = require('@mtproto/core');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

let downloadsFolderPath = path.join(__dirname, "./downloads");

// check if downloads directory exists, otherwise create it
if (!fs.existsSync(downloadsFolderPath)) {
	fs.mkdirSync(downloadsFolderPath);
}

// Initialize MTProto
const mtproto = new MTProto({
	api_id: process.env.api_id,
	api_hash: process.env.api_hash,
	storageOptions: {
		path: path.resolve(__dirname, './session.json'),
	}
});

// Helper function to call MTProto methods
const callApi = async (method, params) => {
	try {
		return await mtproto.call(method, params);
	} catch (error) {
		if (error.error_message && error.error_message.startsWith('PHONE_MIGRATE')) {
			const dcId = parseInt(error.error_message.split('_').pop(), 10);
			console.log(`Redirecting to data center ${dcId}`);
			mtproto.setDefaultDc(dcId); // Switch to the correct data center
			return callApi(method, params); // Retry the API call
		}
		if (error.error_message && error.error_message.startsWith('USER_MIGRATE')) {
			const dcId = parseInt(error.error_message.split('_').pop(), 10);
			console.log(`User data is located in data center ${dcId}. Switching...`);
			mtproto.setDefaultDc(dcId); // Switch to the correct DC
			return callApi(method, params); // Retry the API call
		}
		console.error(`Error calling ${method}:`, error);
		throw error;
	}
};

// Read input from the user
const readInput = (question) => {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => rl.question(question, (answer) => {
		rl.close();
		resolve(answer);
	}));
};

// Login implementation
const login = async () => {
	try {
		// Check if session exists
		const user = await callApi('users.getFullUser', {
			id: { _: 'inputUserSelf' },
		});
		console.log("Already logged in:", user);
		return;
	} catch (error) {
		if (error.error_message !== 'AUTH_KEY_UNREGISTERED') {
			console.error("Error checking session:", error);
			throw error;
		}
		// Proceed with login if session is not found
	}
	try {
		const phoneNumber = await readInput("Enter your phone number (with country code): ");
		const sendCodeResult = await callApi('auth.sendCode', {
			phone_number: phoneNumber,
			settings: { _: 'codeSettings' },
		});

		const code = await readInput("Enter the code you received: ");
		try {
			const signInResult = await callApi('auth.signIn', {
				phone_number: phoneNumber,
				phone_code_hash: sendCodeResult.phone_code_hash,
				phone_code: code,
			});
			console.log("Login successful!", signInResult);
		} catch (error) {
			if (error.error_message === 'SESSION_PASSWORD_NEEDED') {
				const password = await readInput("2FA is enabled. Enter your password: ");
				
				// 1. Fetch current 2FA password settings from Telegram
				const passwordInfo = await callApi('account.getPassword');
				
				const { srp_id, current_algo, srp_B } = passwordInfo;
				const { g, p, salt1, salt2 } = current_algo;
				
				// 2. Use MTProto's native crypto module to generate correct A and M1 values
				const { A, M1 } = await mtproto.crypto.getSRPParams({
					g,
					p,
					salt1,
					salt2,
					gB: srp_B,
					password,
				});

				// 3. Submit calculated challenges back to the server
				const checkPasswordResult = await callApi('auth.checkPassword', {
					password: {
						_: 'inputCheckPasswordSRP',
						srp_id: srp_id,
						A: A,
						M1: M1,
					},
				});

				console.log("Login successful with 2FA!", checkPasswordResult);
			} else {
				throw error;
			}
		}
	} catch (error) {
		console.error("Login failed:", error);
	}
};

// Fetch files from the channel
const fetchFilesFromChannel = async (channelLink) => {
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
		return [];
	}
};

// Global tracking object for rolling speeds (place this outside your functions)
const speedTracker = {
	history: [], // Stores snapshots of { timestamp, bytes }
	windowMs: 5000 // Look back at the last 5 seconds of activity
};

const drawProgressBar = (fileName, currentBytes, totalBytes, startTime) => {
	const percentage = totalBytes > 0 ? Math.min(100, Math.floor((currentBytes / totalBytes) * 100)) : 0;
	
	const barWidth = 15; 
	const filledWidth = Math.round((percentage / 100) * barWidth);
	const bar = '█'.repeat(filledWidth) + '░'.repeat(barWidth - filledWidth);
	
	const currentMB = (currentBytes / (1024 * 1024)).toFixed(1);
	const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);

	// 1. Record the current progress snapshot
	const now = Date.now();
	speedTracker.history.push({ timestamp: now, bytes: currentBytes });

	// 2. Clear out snapshots older than 5 seconds to keep the window moving
	const cutoff = now - speedTracker.windowMs;
	while (speedTracker.history.length > 0 && speedTracker.history[0].timestamp < cutoff) {
		speedTracker.history.shift();
	}

	let speedText = "0.0 MB/s";
	let etaText = "--:--";

	// 3. Calculate speed based ONLY on the 5-second window
	if (speedTracker.history.length > 1) {
		const oldest = speedTracker.history[0];
		const newest = speedTracker.history[speedTracker.history.length - 1];
		
		const timeDifferenceSec = (newest.timestamp - oldest.timestamp) / 1000;
		const bytesDifference = newest.bytes - oldest.bytes;

		if (timeDifferenceSec > 0.2 && bytesDifference > 0) {
			const bytesPerSecond = bytesDifference / timeDifferenceSec;
			const mbPerSecond = bytesPerSecond / (1024 * 1024);
			speedText = `${mbPerSecond.toFixed(1)} MB/s`;

			// Calculate a highly realistic ETA based on active performance
			const remainingBytes = totalBytes - currentBytes;
			if (remainingBytes > 0) {
				const remainingSeconds = remainingBytes / bytesPerSecond;
				const mins = Math.floor(remainingSeconds / 60);
				const secs = Math.floor(remainingSeconds % 60).toString().padStart(2, '0');
				etaText = `${mins}:${secs}`;
			} else {
				etaText = "00:00";
			}
		}
	}

	// Truncate long filenames cleanly
	const maxNameLength = 50;
	const shortName = fileName.length > maxNameLength 
		? fileName.substring(0, maxNameLength - 3) + '...' 
		: fileName;

	// Render layout clearly in a single compressed line string
	process.stdout.clearLine(0);
	process.stdout.cursorTo(0);
	process.stdout.write(`DL: ${shortName} [${bar}] ${percentage}% (${currentMB}/${totalMB}MB) | ${speedText} | ETA: ${etaText}`);
};



// Download a specific file
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const downloadFile = async (fileId, accessHash, fileReference, fileName, totalSize, dcId = null, startTime = null) => {
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


// Add this below your login validation step
const startDownloader = async () => {
    await login(); // Authenticate first
    
	const channelLink = await readInput("Enter the telegram channel link: ");

	const files = await fetchFilesFromChannel(channelLink);

	if(!files.length){
		console.log('No files found in the channel.');
		return;
	}
    
    console.log(`Starting batch download of ${files.length} files sequentially...`);
    let i=1;
	for (const file of files) {
		await downloadFile(file.id, file.access_hash, file.file_reference, `(${i}) ${file.name}`, file.size);
		i++;
		console.log(`--- Pausing briefly before starting next file ---`);
		await sleep(1000); 
	}

    console.log("All downloads completed successfully!");
};

// Call the main function
startDownloader().then(() => {
	console.log("DONE========================>")
	process.exit(0)
}).catch((error) => {
	console.log("Error CAUGHT==================+>", error)
	process.exit(1)
})
