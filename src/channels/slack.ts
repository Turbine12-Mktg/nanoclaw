import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  botToken: string;
  appToken: string;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private connected = false;
  private opts: SlackChannelOpts;
  private botUserId: string | undefined;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  async connect(): Promise<void> {
    // Get bot user ID so we can filter our own messages
    const auth = await this.app.client.auth.test({ token: this.opts.botToken });
    this.botUserId = auth.user_id as string;
    logger.info({ botUserId: this.botUserId }, 'Slack bot identity resolved');

    // Listen to all message events
    this.app.message(async ({ message }) => {
      // Allow regular messages and file_share, skip other subtypes (edits, joins, etc.)
      if (message.subtype && message.subtype !== 'file_share') return;
      if (!('user' in message)) return;

      // Skip bot's own messages
      if (message.user === this.botUserId) return;

      const text = ('text' in message && message.text) ? message.text : '';
      const files = ('files' in message && Array.isArray(message.files)) ? message.files : [];

      // Skip if no text and no files
      if (!text && files.length === 0) return;

      const chatJid = `slack:${message.channel}`;
      const timestamp = new Date(Number(message.ts) * 1000).toISOString();

      // Resolve display name
      let senderName = message.user;
      try {
        const userInfo = await this.app.client.users.info({ user: message.user });
        senderName = userInfo.user?.real_name || userInfo.user?.name || message.user;
      } catch {
        // fallback to user ID
      }

      // Always emit metadata for chat discovery
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

      // Only deliver full message for registered groups
      const groups = this.opts.registeredGroups();
      if (groups[chatJid]) {
        // Download any image files to the group workspace
        const imagePaths = await this.downloadImages(
          files as Array<{ mimetype?: string; url_private_download?: string; name?: string; id?: string }>,
          groups[chatJid].folder,
          message.ts || '',
        );

        let content = text;
        if (imagePaths.length > 0) {
          const imageRefs = imagePaths.map(p => `[Image: ${p}]`).join('\n');
          content = content ? `${content}\n${imageRefs}` : imageRefs;
        }

        if (!content) return;

        this.opts.onMessage(chatJid, {
          id: message.ts || '',
          chat_jid: chatJid,
          sender: message.user,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        });
      }
    });

    await this.app.start();
    this.connected = true;
    logger.info('Connected to Slack (Socket Mode)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace('slack:', '');

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text,
      });
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  /**
   * Download image files from Slack to the group's workspace.
   * Returns container-relative paths so the agent can read them.
   */
  private async downloadImages(
    files: Array<{ mimetype?: string; url_private_download?: string; name?: string; id?: string }>,
    groupFolder: string,
    messageTs: string,
  ): Promise<string[]> {
    const imageFiles = files.filter(f =>
      f.mimetype?.startsWith('image/') && f.url_private_download,
    );
    if (imageFiles.length === 0) return [];

    const imagesDir = path.join(GROUPS_DIR, groupFolder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    const saved: string[] = [];
    for (const file of imageFiles) {
      try {
        const ext = file.name?.split('.').pop() || 'png';
        const filename = `${messageTs.replace('.', '-')}-${file.id || 'img'}.${ext}`;
        const hostPath = path.join(imagesDir, filename);

        const response = await fetch(file.url_private_download!, {
          headers: { Authorization: `Bearer ${this.opts.botToken}` },
        });
        if (!response.ok) {
          logger.warn({ file: file.name, status: response.status }, 'Failed to download Slack image');
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(hostPath, buffer);

        // Return the container-relative path (agent sees /workspace/group/)
        const containerPath = `/workspace/group/images/${filename}`;
        saved.push(containerPath);
        logger.info({ file: file.name, path: containerPath }, 'Slack image saved');
      } catch (err) {
        logger.warn({ file: file.name, err }, 'Failed to download Slack image');
      }
    }
    return saved;
  }
}
