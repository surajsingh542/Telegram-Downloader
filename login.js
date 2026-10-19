import { callApi, readInput } from './helper.js';
import mtproto from './mtProto.js'

// Login implementation
const login = async () => {
	try {
		// Check if session exists
		const user = await callApi('users.getFullUser', {
			id: { _: 'inputUserSelf' },
		});
		const self = user.users?.[0];
		const displayName = [self?.first_name, self?.last_name].filter(Boolean).join(' ') || self?.username || 'unknown user';
		console.info(`Already logged in as ${displayName}${self?.username ? ` (@${self.username})` : ''}.`);
		return;
	} catch (error) {
		if (error.error_message !== 'AUTH_KEY_UNREGISTERED') {
			console.error("Error checking session:", error);
			throw error;
		}
	}
	// Proceed with login if session is not found
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
		throw error;
	}
};

export default login;