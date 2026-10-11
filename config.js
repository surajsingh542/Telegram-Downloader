import path from 'node:path'

// Global tracking object for rolling speeds
export const speedTracker = {
	history: [], // Stores snapshots of { timestamp, bytes }
	windowMs: 5000 // Look back at the last 5 seconds of activity
};

export const downloadsFolderPath = path.resolve("./downloads");
