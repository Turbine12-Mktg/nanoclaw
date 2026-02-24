# NanoClaw: Slack + Gmail + GitHub + GCS Setup Guide

Replication guide for setting up NanoClaw with Slack as the primary channel, Gmail (tool mode), GitHub MCP, and GCS credentials. Based on a working deployment.

## Prerequisites

- macOS or Linux
- Node.js 20+ (`node --version`)
- Docker installed and running (`docker info`)
- Claude Pro/Max subscription or Anthropic API key

## 1. Clone and Bootstrap

```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
bash setup.sh
```

Verify output shows `NODE_OK: true`, `DEPS_OK: true`, `NATIVE_OK: true`.

## 2. Build the Agent Container

```bash
npx tsx setup/index.ts --step container -- --runtime docker
```

Verify `BUILD_OK: true` and `TEST_OK: true`.

## 3. Claude Authentication

Choose one:

**Subscription (Pro/Max):**
```bash
# In another terminal:
claude setup-token
# Copy the token
```

**API key:** Get one from https://console.anthropic.com

Create `.env` in the project root:

```env
# Choose one:
CLAUDE_CODE_OAUTH_TOKEN=your-token-here
# or:
# ANTHROPIC_API_KEY=sk-ant-...

ASSISTANT_NAME="your-bot-name"
```

## 4. Create Slack App

1. Go to https://api.slack.com/apps > **Create New App** > **From scratch**
2. Name it (e.g. your bot name), select your workspace

### Enable Socket Mode

3. Sidebar: **Socket Mode** > toggle **On**
4. Generate an App-Level Token named `socket` with scope `connections:write`
5. Copy the token (starts with `xapp-`)

### Bot Token Scopes

6. Sidebar: **OAuth & Permissions** > **Bot Token Scopes**, add:
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `im:write`
   - `users:read`
   - `files:read` (for image support)
   - `app_mentions:read`

### Event Subscriptions

7. Sidebar: **Event Subscriptions** > toggle **On**
8. **Subscribe to bot events**, add:
   - `message.channels`
   - `message.groups`
   - `message.im`

### Install

9. Sidebar: **Install App** > **Install to Workspace**
10. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### Add Tokens to .env

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

### Invite Bot to Channel

Create a channel for the bot (e.g. `#your-bot-name`), then `/invite @YourBotName` in that channel. Copy the **Channel ID** from channel details (bottom of the panel).

## 5. Register Channels

### Main channel

```bash
npx tsx setup/index.ts --step register \
  -- --jid "slack:CHANNEL_ID" \
  --name "main" \
  --trigger "@your-bot-name" \
  --folder "main" \
  --no-trigger-required \
  --assistant-name "your-bot-name"
```

### Additional channels (optional)

Register more channels the same way. Each gets its own isolated folder. Invite the bot first (`/invite @BotName`), then:

```bash
npx tsx setup/index.ts --step register \
  -- --jid "slack:CHANNEL_ID" \
  --name "channel-name" \
  --trigger "@your-bot-name" \
  --folder "channel-name" \
  --no-trigger-required \
  --assistant-name "your-bot-name"
```

- `--no-trigger-required` means the bot responds to all messages. Omit it if you want the bot to only respond when mentioned with `@bot-name`.
- Each channel gets its own workspace at `groups/<folder-name>/` with isolated files and session history.
- All channels share `groups/global/CLAUDE.md` for common instructions.

Restart after adding channels: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

## 6. Configure Mounts

```bash
npx tsx setup/index.ts --step mounts -- --empty
```

## 7. Gmail Integration (Optional)

### GCP OAuth Setup

1. Go to https://console.cloud.google.com
2. Create/select a project
3. **APIs & Services > Library** > search "Gmail API" > **Enable**
4. **APIs & Services > Credentials** > **+ CREATE CREDENTIALS** > **OAuth client ID**
   - If prompted for consent screen: choose External, fill in app name and email
   - Application type: **Desktop app**
   - Click **Create**, then **Download JSON**
5. Place the credentials:
   ```bash
   mkdir -p ~/.gmail-mcp
   cp ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json
   ```

### Authorize

Make sure port 3000 is free (`lsof -i :3000`), then:

```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

Complete the Google sign-in in the browser. Verify:

```bash
ls ~/.gmail-mcp/credentials.json  # Should exist
```

### Wire into Agent

Gmail is already configured in the agent-runner source. No additional steps needed if you're using this repo as-is.

## 8. GitHub Integration (Optional)

### Create a Personal Access Token

1. Go to https://github.com/settings/tokens
2. **Generate new token** > **Classic** (for multi-org access) or **Fine-grained**
   - Classic: select `repo` scope
   - Fine-grained: grant Contents (R/W), Issues (R/W), Pull requests (R/W), Metadata (Read)
3. Add to `.env`:

```env
GITHUB_TOKEN=github_pat_your-token
```

GitHub MCP is already configured in the agent-runner source. No additional steps needed.

## 9. GCS Credentials (Optional)

If the agent needs access to Google Cloud Storage:

1. Create a service account in your GCP project with the necessary GCS permissions
2. Download the JSON key file
3. Place it in the Gmail MCP credentials directory (already mounted into containers):

```bash
cp ~/Downloads/your-project-key.json ~/.gmail-mcp/gcs-service-account.json
chmod 600 ~/.gmail-mcp/gcs-service-account.json
```

The agent can then use it by setting the environment variable before `gsutil` commands:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/home/node/.gmail-mcp/gcs-service-account.json gsutil ls gs://your-bucket
```

The `~/.gmail-mcp/` directory is mounted at `/home/node/.gmail-mcp/` inside the container. The Gmail MCP only reads its own files (`gcp-oauth.keys.json` and `credentials.json`) and ignores other files in the directory.

## 10. Start the Service

```bash
npm run build
npx tsx setup/index.ts --step service
```

Verify:

```bash
# macOS
launchctl list | grep nanoclaw

# Linux
systemctl --user status nanoclaw
```

Check logs:

```bash
tail -f logs/nanoclaw.log
```

You should see `Connected to Slack (Socket Mode)` and `NanoClaw running`.

## 11. Test

Send a message in your Slack channel. The bot should respond.

Test integrations:
- **Gmail:** "check my recent emails"
- **GitHub:** "list open PRs on owner/repo"
- **Images:** share an image and ask the bot to describe it

## Service Management

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # restart
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # stop

# Linux
systemctl --user restart nanoclaw
systemctl --user stop nanoclaw
```

## File Layout

```
.env                          # Secrets (never committed)
groups/global/CLAUDE.md       # Shared bot memory (all groups)
groups/main/CLAUDE.md         # Main channel memory + admin config
groups/main/images/           # Downloaded Slack images
groups/<name>/CLAUDE.md       # Per-channel memory (one per registered channel)
~/.gmail-mcp/                 # Gmail OAuth + GCS service account creds
store/messages.db             # SQLite database
logs/nanoclaw.log             # Application logs
data/sessions/main/           # Agent session data
```

## Customizing the Bot

Edit `groups/global/CLAUDE.md` for behavior that applies everywhere. Edit `groups/main/CLAUDE.md` for main-channel-specific instructions. The bot can also update its own memory through conversation.

## Troubleshooting

**Service won't start:** Check `logs/nanoclaw.error.log`. Common causes: wrong Node path, missing `.env`, Docker not running.

**No response to messages:** Verify the channel ID is correct and the bot is invited to the channel. Check `logs/nanoclaw.log`.

**Gmail auth fails:** Ensure port 3000 is free. Delete `~/.gmail-mcp/credentials.json` and re-run auth.

**Image processing errors:** Clear the session: `sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = 'main';"` then restart.

**Container agent fails:** Ensure Docker is running (`docker info`). Check container logs in `groups/main/logs/container-*.log`.
