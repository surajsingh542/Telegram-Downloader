# Telegram File Downloader

A Node.js application that downloads files from Telegram channels using the MTProto API. This tool can fetch and download all media files from a specified Telegram channel.

## Features

- **Authentication**: Supports phone number + SMS code login with 2FA support
- **Channel Scraping**: Fetches all media files from a Telegram channel
- **Bulk Download**: Downloads multiple files sequentially with progress tracking
- **Error Handling**: Handles rate limiting, data center migration, and network errors
- **Session Management**: Saves authentication sessions for reuse
- **Large File Support**: Downloads files in chunks to handle large media files

## Prerequisites

- Node.js (v14 or higher)
- Telegram account
- Telegram API credentials (api_id and api_hash)

## Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the project root with your Telegram API credentials:
```env
api_id=YOUR_API_ID
api_hash=YOUR_API_HASH
```

## Getting Telegram API Credentials

1. Go to [my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Go to "API development tools"
4. Create a new application
5. Copy the `api_id` and `api_hash` values

## Usage

1. Run the application:
```bash
node downloader.js
```

2. Follow the prompts:
   - Enter your phone number (with country code)
   - Enter the SMS verification code
   - If 2FA is enabled, enter your password
   - Enter the Telegram channel link (e.g., `https://t.me/channelname`)

3. The application will:
   - Fetch all media files from the channel
   - Download them to the `./downloads` folder
   - Display progress for each file

## How It Works

### Authentication Flow
1. **Session Check**: First checks if a valid session exists
2. **Phone Verification**: Sends SMS code to your phone number
3. **Code Verification**: Verifies the SMS code
4. **2FA Support**: If enabled, handles password-based 2FA using SRP protocol

### File Fetching
1. **Channel Resolution**: Resolves the channel username to get channel details
2. **Message History**: Fetches message history in batches of 100
3. **Media Extraction**: Filters messages to find those with media attachments
4. **File Collection**: Collects all document/media files from the channel

### Download Process
1. **Chunked Download**: Downloads files in 1MB chunks
2. **Error Recovery**: Handles rate limiting and data center migration
3. **Progress Tracking**: Shows download progress for each file
4. **File Naming**: Prefixes files with index numbers to avoid conflicts

## File Structure

```
telegram-downloader/
├── downloader.js          # Main application file
├── .env                   # Environment variables (create this)
├── session.json          # Authentication session (auto-generated)
├── downloads/            # Downloaded files folder (auto-created)
└── README.md            # This file
```

## Error Handling

The application handles several types of errors:

- **FLOOD_WAIT**: Automatically waits for the specified time before retrying
- **FILE_MIGRATE**: Switches to the correct data center for file downloads
- **OFFSET_INVALID**: Handles invalid download offsets gracefully
- **PHONE_MIGRATE/USER_MIGRATE**: Redirects to the correct data center

## Security Features

- **SRP Authentication**: Uses Secure Remote Password protocol for 2FA
- **Session Persistence**: Stores encrypted sessions locally
- **No Password Storage**: Passwords are never stored, only used for authentication

## Limitations

- **Rate Limiting**: Subject to Telegram's API rate limits
- **File Size**: Large files may take time to download
- **Channel Access**: Only works with public channels or channels you have access to
- **API Limits**: Subject to Telegram's API usage policies

## Troubleshooting

### Common Issues

1. **"AUTH_KEY_UNREGISTERED"**: Delete `session.json` and re-authenticate
2. **"FLOOD_WAIT"**: Wait for the specified time or reduce request frequency
3. **"FILE_MIGRATE"**: The app automatically handles this, but may need manual intervention
4. **"OFFSET_INVALID"**: Usually indicates the file download is complete

### Performance Tips

- Use a stable internet connection
- Avoid downloading from channels with very large files during peak hours
- Consider implementing delays between downloads for large channels

## Dependencies

- `@mtproto/core`: MTProto protocol implementation for Telegram
- `dotenv`: Environment variable management
- `crypto`: Built-in Node.js crypto module for hashing
- `fs`: File system operations
- `path`: Path manipulation utilities

## License

This project is for educational and personal use. Please respect Telegram's Terms of Service and API usage policies.

## Disclaimer

This tool is provided as-is. Use responsibly and in accordance with Telegram's Terms of Service. The developers are not responsible for any misuse or violations of Telegram's policies. 