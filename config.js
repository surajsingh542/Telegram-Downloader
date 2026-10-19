import path from 'node:path'

// Global tracking object for rolling speeds
export const speedTracker = {
	history: [], // Stores snapshots of { timestamp, bytes }
	windowMs: 5000 // Look back at the last 5 seconds of activity
};

// Override with DOWNLOADS_DIR in .env to save files somewhere else
export const downloadsFolderPath = path.resolve(process.env.DOWNLOADS_DIR || "./downloads");

const readIntSetting = (name, fallback, min, max) => {
	const value = parseInt(process.env[name], 10);
	return Number.isNaN(value) ? fallback : Math.min(max, Math.max(min, value));
};

// Each file is split into this many parts that download in parallel, then get merged (DOWNLOAD_PARTS, 1-32).
// This is also the most requests that are ever in flight at once.
export const downloadParts = readIntSetting('DOWNLOAD_PARTS', 8, 1, 32);

// Network connections the parts are spread over (DOWNLOAD_CONNECTIONS, 1-16).
export const downloadConnections = readIntSetting('DOWNLOAD_CONNECTIONS', 4, 1, 16);
