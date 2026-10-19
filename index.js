import 'dotenv/config'
import login from './login.js'
import { runMenu } from './menu.js';

const startDownloader = async () => {
	await login(); // Authenticate first
	await runMenu();
	console.info('Bye!');
};

// Call the main function
startDownloader().then(() => {
	process.exit(0)
}).catch((error) => {
	console.error("Error CAUGHT==================+>", error)
	process.exit(1)
})
