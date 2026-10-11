import 'dotenv/config'
import fs from 'node:fs'
import { downloadsFolderPath } from "./config.js";
import login from './login.js'
import { readInput } from './helper.js';
import { fetchFilesFromChannel, downloadFile } from './downloader.js';

// check if downloads directory exists, otherwise create it
if (!fs.existsSync(downloadsFolderPath)) {
	fs.mkdirSync(downloadsFolderPath);
}

const startDownloader = async () => {
	await login(); // Authenticate first

	const channelLink = await readInput("Enter the telegram channel link: ");

	const files = await fetchFilesFromChannel(channelLink);

	if (!files.length) {
		console.log('No files found in the channel.');
		return;
	}

	console.log(`Starting batch download of ${files.length} files sequentially...`);
	let i = 1;
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
	process.exit(0)
}).catch((error) => {
	console.log("Error CAUGHT==================+>", error)
	process.exit(1)
})
