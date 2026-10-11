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
		const username = channelLink.replace('https://t.me', '').split('/')[0];
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

// Download a specific file
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const downloadFile = async (fileId, accessHash, fileReference, fileName, dcId = null) => {
	const fileStream = fs.createWriteStream(path.join(downloadsFolderPath, fileName));
	let offset = 0;
	
	// Telegram chunk limits: Must be a multiple of 4KB. Max 1MB (1024 * 1024) for big files.
	const chunkSize = 512 * 1024; 

	console.log(`Starting Download for: ${fileName}`);

	try {
		while (true) {
			try {
				// Call API directly on mtproto or use custom DC option object if dcId is provided
				const data = await mtproto.call('upload.getFile', {
					location: {
						_: 'inputDocumentFileLocation',
						id: fileId,
						access_hash: accessHash,
						file_reference: fileReference,
					},
					offset,
					limit: chunkSize,
				}, dcId ? { dcId } : {}); // Pass specific target DC option override if migrating

				if (!data || !data.bytes || data.bytes.length === 0) {
					console.log(`Finished downloading: ${fileName}`);
					break;
				}

				fileStream.write(Buffer.from(data.bytes));
				offset += data.bytes.length; // Dynamically increment by actual bytes received
			} catch (error) {
				if (error.error_message && error.error_message.startsWith('FLOOD_WAIT_')) {
					const waitTime = parseInt(error.error_message.split('_')[2], 10);
					console.log(`Flood wait detected. Sleeping for ${waitTime} seconds...`);
					await sleep(waitTime * 1000);
					// Retry happens seamlessly because loop does not increment offset yet
				} else if (error.error_message && error.error_message.startsWith('FILE_MIGRATE_')) {
					const newDcId = parseInt(error.error_message.split('_')[2], 10);
					console.log(`File is in data center ${newDcId}. Re-routing request...`);
					
					// Close stream to cleanly wipe/restart download on the correct target DC
					fileStream.end(); 
					return downloadFile(fileId, accessHash, fileReference, fileName, newDcId);
				} else if (error.error_message === 'OFFSET_INVALID') {
					console.log('Finished stream boundaries (OFFSET_INVALID).');
					break;
				} else {
					throw error;
				}
			}
		}
	} catch (error) {
		console.error(`Fatal failure during file download (${fileName}):`, error);
	} finally {
		fileStream.end();
	}
};

// Main function
const main = async () => {
	await login();

	const channelLink = await readInput("Enter the telegram channel link: ");

	const files = await fetchFilesFromChannel(channelLink);

	if(!files.length){
		console.log('No files found in the channel.');
		return;
	}

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const fileReference = file.file_reference;
		let fileName = file.attributes.find((attr) => attr._ === 'documentAttributeFilename').file_name;
		fileName = `(${i}) ${fileName}`;
		await downloadFile(file.id, file.access_hash, fileReference, fileName);
	}

};

// Call the main function
main().then(() => {
	console.log("DONE========================>")
	process.exit(0)
}).catch((error) => {
	console.log("Error CAUGHT==================+>", error)
})
