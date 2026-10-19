# Telegram File Downloader

A Node.js application that downloads files from Telegram channels using the MTProto API. Download a whole channel, pick individual files from a list (optionally filtered by date), or grab a single file straight from its message link.

## Features

- **Authentication**: Supports phone number + SMS code login with 2FA support
- **Interactive Menu**: Choose between four download modes every time you run it
  1. Download every file in a channel
  2. List a channel's files (optionally only from a specific date or date range) and download just the ones you select
  3. Download a single file from its message link (e.g. `https://t.me/channelname/123`)
  4. List every file between two message links (both included) and download the ones you select
- **Checkbox Selection**: Pick files from a scrollable checkbox list with the arrow keys and space bar
- **Flexible Channel Links**: Public links, `@username`, private `t.me/c/...` links and invite links (`t.me/+...`) of channels you have joined
- **Bulk Download**: Downloads multiple files sequentially with progress tracking and a summary at the end
- **Fast Downloads**: Each file is split into parts (8 by default) that download in parallel and are merged at the end, Telegram rate limits are respected automatically, and the MTProto library's slow receive path is replaced with native crypto (see [Download Speed](#download-speed))
- **Auto Resume**: Interrupted downloads continue where they stopped; finished files are skipped, whichever mode downloaded them
- **Error Handling**: Handles rate limiting, data center migration, and network errors
- **Session Management**: Saves authentication sessions for reuse
- **Large File Support**: Downloads files in chunks to handle large media files

## Prerequisites

- Node.js (v20.17 or higher)
- Telegram account
- Telegram API credentials (api_id and api_hash)

## Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the project root with your Telegram API credentials (see `.env.example`):
```env
api_id=YOUR_API_ID
api_hash=YOUR_API_HASH
# Optional: where files are saved (defaults to ./downloads)
DOWNLOADS_DIR=
# Optional: parts each file is split into and downloaded in parallel, 1-32 (defaults to 8)
DOWNLOAD_PARTS=
# Optional: network connections the parts are spread over, 1-16 (defaults to 4)
DOWNLOAD_CONNECTIONS=
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
npm run start
```

2. Log in (only needed the first time; the session is saved to `session.json`):
   - Enter your phone number (with country code)
   - Enter the verification code
   - If 2FA is enabled, enter your password

3. Pick an option from the menu. After each option finishes you return to the menu; choose `0` to exit.

```
What would you like to do?
  1. Download all files from a channel
  2. List files from a channel (optionally from a specific date) and download the selected ones
  3. Download a single file from its message link (e.g. https://t.me/channel/123)
  4. List files between two message links (both included) and download the selected ones
  0. Exit
```

### 1. Download all files from a channel

Enter the channel link. The app lists how many files it found and their total size, asks for confirmation, then downloads them oldest first.

### 2. List files and download only the selected ones

1. Enter the channel link.
2. Optionally enter a date filter (dates are in your local timezone):

   | Input | Lists files posted |
   |---|---|
   | *(press Enter)* | at any time |
   | `2026-10-19` | on that day |
   | `2026-10-01..2026-10-19` or `2026-10-01 to 2026-10-19` | between those days (inclusive) |
   | `2026-10-01..` | on or after that day |
   | `..2026-10-19` | on or before that day |

   With a date filter only that part of the channel history is fetched, so it is fast even for huge channels.

3. Tick the files you want in the checkbox list (see [Selecting files](#selecting-files)).
4. Confirm, and only the selected files are downloaded.

### 3. Download a single file from its link

In Telegram, right-click (or long-press) the message with the file and choose **Copy Message Link**, then paste it. Supported formats:

- `https://t.me/channelname/123` (public channel)
- `https://t.me/c/1234567890/123` (private channel you have joined)
- `https://t.me/channelname/45/123` (message inside a topic)
- Links with `?single` or other query strings

### 4. Files between two message links

1. Paste the link of the **first** message of the range (Copy Message Link in Telegram).
2. Paste the link of the **last** message of the range. Both must be from the same channel; the order doesn't matter.
3. Every file posted from the first message up to and including the last one is listed. Only that slice of the channel history is fetched, so it's quick even in huge channels.
4. Tick the files you want (see [Selecting files](#selecting-files)), confirm, and they are downloaded.

### Selecting files

Options 2 and 4 show a checkbox list:

```
? Select files to download (5 listed, 15.0 MB in total)
 ◉ 1. 2026-10-18 12:00     3.0 MB  Lecture 106.pdf
❯◯ 2. 2026-10-18 13:00     3.0 MB  Lecture 107.pdf
 ◯ 3. 2026-10-18 15:00     3.0 MB  Lecture 109.pdf
↑↓ navigate • space select • a all • i invert • ⏎ submit
```

| Key | Action |
|---|---|
| ↑ / ↓ | Move (the list scrolls for long channels) |
| Space | Tick / untick the file |
| `a` | Tick / untick everything |
| `i` | Invert the selection |
| Enter | Confirm |
| Ctrl+C | Cancel and go back to the menu |

When the app is not running in an interactive terminal (for example input is piped from a script), it falls back to a numbered list where you type the files you want: `1,3,5-8`, `2 4 6` or `all`.

### Channel link formats

Wherever a channel is asked for you can enter `https://t.me/channelname`, `t.me/channelname`, `@channelname`, `https://t.me/c/1234567890` (private channel you are a member of) or an invite link such as `https://t.me/+AbCdEf` (you must already have joined).

### Where files are saved

Files go to `./downloads` (or `DOWNLOADS_DIR`) and are named `(<message id>) <original file name>`, e.g. `(1523) Lecture 3.pdf`. The message id keeps names unique and stable, so a file you downloaded with one option is recognised and skipped (or resumed) by every other option.

## How It Works

### Authentication Flow
1. **Session Check**: First checks if a valid session exists
2. **Phone Verification**: Sends SMS code to your phone number
3. **Code Verification**: Verifies the SMS code
4. **2FA Support**: If enabled, handles password-based 2FA using SRP protocol

### File Fetching
1. **Channel Resolution**: Resolves the username / invite link, or finds a private channel in your chat list
2. **Message History**: Fetches message history in batches of 100. With a date filter, paging starts at the end of the range and stops as soon as it passes the start
3. **Media Extraction**: Keeps messages that carry a document (files, videos, audio, etc.)
4. **Single Message**: For message links, only that one message is fetched with `channels.getMessages`

### Download Process
1. **Split Into Parts**: Each file is divided into `DOWNLOAD_PARTS` byte ranges (aligned to 1MB, the largest chunk Telegram serves). The layout is saved in `downloads/.parts/<file>/manifest.json`
2. **Parallel Parts**: Every part downloads at the same time into its own file (`part-000`, `part-001`, ...) over connections to the data center that stores the file. Within a part, 1MB chunks are written in order and flushed to disk
3. **Reconciliation**: When every part is complete and the right size, the parts are appended onto the first one in order (each deleted right after, so extra disk use stays at one part), the total size is checked, and the result is renamed to the final file name. The final file only appears once it is complete
4. **Resume**: Each part's size says exactly how much of it is done, so a re-run only fetches what is missing. A torn final chunk is discarded. The saved layout is reused even if you change `DOWNLOAD_PARTS`, and an interrupted merge continues from its last checkpoint. Partial files from older versions of this app are imported into parts automatically
4. **Error Recovery**: Handles rate limiting, data center migration, expired file references and lost requests (timed out and retried)
5. **Progress Tracking**: Shows speed, ETA and progress for each file, average speed when done, and a summary at the end
6. **File Naming**: Prefixes files with the Telegram message id to avoid conflicts

## File Structure

```
telegram-downloader/
├── index.js          # Entry point: login, then the menu
├── menu.js           # Interactive menu, the four download modes and checkbox file selection
├── downloader.js     # Channel resolution, file fetching and download functions
├── parsers.js        # Link, date filter and selection parsing; formatting helpers
├── partedDownload.js # Parts plan, parallel part downloads, merge, adaptive rate limiter
├── connectionPool.js # Extra MTProto connections per data center
├── mtprotoPatches.js # Speed (native crypto, fast framing) and reconnect fixes for @mtproto/core
├── helper.js         # API call wrapper, input and progress bar utilities
├── config.js         # Shared configuration (downloads folder, speed tracking)
├── login.js          # Telegram user login and session management
├── mtProto.js        # The MTProto client for Telegram APIs
├── test/             # Unit tests (node:test)
├── .env                   # Environment variables (create this)
├── session.json          # Authentication session (auto-generated)
├── downloads/            # Downloaded files folder (auto-created)
└── README.md            # This file
```

## Download Speed

Download speed is limited by three things. This app removes the first two:

1. **The MTProto library itself (fixed).** `@mtproto/core` 6.3.0 rebuilds its receive buffer byte by byte on every network packet and does all AES encryption in pure JavaScript. Together that costs about 800ms of CPU per MB, which caps any download at roughly **1.2 MB/s** no matter how fast your connection is. [mtprotoPatches.js](mtprotoPatches.js) replaces those parts with Node's native OpenSSL AES and a linear-time frame parser, raising the ceiling to roughly **50 MB/s**.
   The patches are verified byte for byte against the original implementation in the tests. They only apply to the pinned library version (6.3.0); with any other version the app warns and runs unpatched.
2. **Waiting on one request at a time (fixed).** Each file is split into `DOWNLOAD_PARTS` parts (default 8) that download at the same time over `DOWNLOAD_CONNECTIONS` connections (default 4), in 1MB chunks. Network latency is overlapped instead of paid once per chunk.
3. **Telegram's own limits (cannot be bypassed).** Telegram limits download speed on its servers for accounts without Telegram Premium. No client can go faster than the speed Telegram serves; this app just makes sure it is not the bottleneck. Premium accounts get noticeably faster downloads.

### Connection reliability (fixed)

`@mtproto/core` 6.3.0 also loses requests when a connection drops. It sends data on the new socket before the connection handshake (so Telegram closes that one too), and after reconnecting it only resends requests Telegram has not acknowledged yet. Telegram acknowledges a chunk request long before the 1MB answer arrives, so an in-flight chunk was never resent and waited forever. That showed up as `No response from Telegram within 60s. Retrying (1/5)...` repeating, usually for two parts at once (the two parts sharing the broken connection), until the file failed. [mtprotoPatches.js](mtprotoPatches.js) fixes the reconnect path and the acknowledgement handling. [connectionPool.js](connectionPool.js) replaces connections that go silent.

### Staying under Telegram's rate limits

You don't need to tune anything to avoid rate limits. Every request goes through an adaptive limiter. When Telegram replies with `FLOOD_WAIT`, all parts pause for the time Telegram asks and the number of parallel requests is halved. After a run of successful requests it grows back by one at a time. The download settles just below the level Telegram tolerates instead of hitting the limit repeatedly. The learned level is kept for the rest of the session, so later files start from it.

### Tuning

| Setting | Default | When to change |
|---|---|---|
| `DOWNLOAD_PARTS` | 8 | Raise (e.g. `12`-`16`) for big files on a fast line; the limiter backs off if it is too much. `1` downloads a file as a single stream. |
| `DOWNLOAD_CONNECTIONS` | 4 | Raise (up to `DOWNLOAD_PARTS`) to give each part its own connection; lower on unstable networks. |

Files smaller than `DOWNLOAD_PARTS` MB use fewer parts (one per MB).

## Error Handling

The application handles several types of errors:

- **FLOOD_WAIT**: Automatically waits for the specified time before retrying
- **FILE_MIGRATE**: Switches to the correct data center for file downloads
- **AUTH_KEY_UNREGISTERED** (on the file's data center): Copies your login to that data center and retries
- **Dropped connections**: The connection is reopened (immediately, then backing off up to 10s while the network is down) and every request still waiting for an answer is sent again, so a drop costs a moment instead of a timeout
- **Silent connections**: A request with no answer in 60 seconds is retried (up to 5 times). If its connection has not received a single byte since the request was sent (e.g. after a Wi-Fi change or sleep, where the socket never reports an error), that connection is replaced first, so the retry does not go back into a dead socket
- **Telegram's `-503 Timeout`**: Telegram's own "an internal server did not answer" error is retried like a timeout
- **One part fails for good**: The other parts of that file stop right away (instead of finishing their own retries) and the batch moves on; progress is kept for the next run
- **FILE_REFERENCE_EXPIRED**: Re-fetches the message to get a fresh file reference (common when you take a while choosing files)
- **OFFSET_INVALID**: Handles invalid download offsets gracefully
- **PHONE_MIGRATE/USER_MIGRATE**: Redirects to the correct data center

## Security Features

- **SRP Authentication**: Uses Secure Remote Password protocol for 2FA
- **Session Persistence**: Stores encrypted sessions locally
- **No Password Storage**: Passwords are never stored, only used for authentication

## Limitations

- **Rate Limiting**: Subject to Telegram's API rate limits
- **File Size**: Large files may take time to download
- **Channel Access**: Only works with public channels or channels you have joined
- **Photos**: Only documents (files, videos, audio, etc.) are downloaded; compressed photos are skipped
- **API Limits**: Subject to Telegram's API usage policies

## Troubleshooting

### Common Issues

1. **"AUTH_KEY_UNREGISTERED"**: Delete `session.json` and re-authenticate
2. **"FLOOD_WAIT"**: Wait for the specified time or reduce request frequency
3. **"FILE_MIGRATE"**: The app automatically handles this, but may need manual intervention
4. **"OFFSET_INVALID"**: Usually indicates the file download is complete

5. **`No response from Telegram within 60s`** now and then: The connection went quiet. It is replaced and the request is retried automatically. If it happens constantly, lower `DOWNLOAD_CONNECTIONS` / `DOWNLOAD_PARTS`.

### Performance Tips

- Use a stable internet connection
- Tune `DOWNLOAD_PARTS` / `DOWNLOAD_CONNECTIONS` (see [Download Speed](#download-speed))

## Running Tests

```bash
npm test
```

The tests use Node's built-in test runner and a fake Telegram API, so they need no credentials or network. They cover link/date/selection/message-range parsing, channel resolution, date- and message-range history paging, the checkbox selection, part planning, parallel part downloads, resume after interruption (including torn chunks, changed part counts, interrupted merges and partial files from older versions), the adaptive rate limiter, data center migration, auth import, expired file references and flood waits. They also check that the native crypto patches match the original library byte for byte and that frame parsing works across any packet split.

## Dependencies

- `@mtproto/core`: MTProto protocol implementation for Telegram
- `dotenv`: Environment variable management
- `@inquirer/checkbox`: Checkbox list for selecting files
- `crypto`: Built-in Node.js crypto module for hashing
- `fs`: File system operations
- `path`: Path manipulation utilities

## License

This project is for educational and personal use. Please respect Telegram's Terms of Service and API usage policies.

## Disclaimer

This tool is provided as-is. Use responsibly and in accordance with Telegram's Terms of Service. The developers are not responsible for any misuse or violations of Telegram's policies. 