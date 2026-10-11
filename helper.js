import readline from 'readline';
import mtproto from './mtProto.js';
import { speedTracker } from './config.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to call MTProto methods
export const callApi = async (method, params) => {
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
export const readInput = (question) => {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => rl.question(question, (answer) => {
		rl.close();
		resolve(answer);
	}));
};

export const drawProgressBar = (fileName, currentBytes, totalBytes, startTime) => {
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