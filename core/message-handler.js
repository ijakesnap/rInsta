import { logger } from '../utils/utils.js';
import { config } from '../config.js';

export class MessageHandler {
  constructor(instagramBot, moduleManager, telegramBridge) {
    this.instagramBot = instagramBot;
    this.moduleManager = moduleManager;
    this.telegramBridge = telegramBridge;
  }

  async handleMessage(message) {
    try {
      // Process through modules for stats/logging
      message = await this.moduleManager.processMessage(message);

      // Handle commands INSTANTLY
      if (message.text?.startsWith('.')) {
        await this.handleCommand(message);
        return;
      }

      // Forward to Telegram if enabled
      if (this.telegramBridge?.enabled && config.telegram.enabled) {
        await this.telegramBridge.sendToTelegram(message);
      }

    } catch (error) {
      logger.error('Message handling error:', error.message);
    }
  }

  async handleCommand(message) {
    const commandText = message.text.slice(1).trim();
    const [commandName, ...args] = commandText.split(' ');
    const command = this.moduleManager.getCommand(commandName);

    if (!command) return;

    // Admin check
    if (command.adminOnly && !this.isAdmin(message.senderUsername)) {
      await this.instagramBot.sendMessage(message.threadId, '❌ Admin only');
      return;
    }

    try {
      // Log command execution
      logger.info(`⚡ Command executed: .${commandName} by @${message.senderUsername}`);
      
      // Execute command INSTANTLY
      await command.handler(args, message);
      
    } catch (error) {
      logger.error(`Command ${commandName} error:`, error.message);
      await this.instagramBot.sendMessage(message.threadId, `❌ Error: ${error.message}`);
    }
  }

  isAdmin(username) {
    return config.admin.users.includes(username.toLowerCase());
  }
}
