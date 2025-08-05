import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export class MessageHandler {
  constructor(instagramClient, moduleManager, telegramBridge) {
    this.instagramClient = instagramClient;
    this.moduleManager = moduleManager;
    this.telegramBridge = telegramBridge;
    this.commandPrefix = '.';
  }

  async handleMessage(message) {
    try {
      // Process through modules for stats/logging
      const processedMessage = await this.moduleManager.processMessage(message);

      // Handle commands
      if (processedMessage.content?.startsWith(this.commandPrefix)) {
        await this.handleCommand(processedMessage);
        return;
      }

      // Forward to Telegram if enabled
      if (this.telegramBridge?.enabled && config.telegram?.enabled) {
        await this.telegramBridge.handleInstagramMessage(processedMessage);
      }

    } catch (error) {
      logger.error('Message handling error:', error.message);
    }
  }

  async handleCommand(message) {
    try {
      const commandText = message.text.slice(this.commandPrefix.length).trim();
      const [commandName, ...args] = commandText.split(' ');
      
      if (!commandName) return;

      const command = this.moduleManager.getCommand(commandName);
      if (!command) {
        await this.sendReply(message, `❌ Unknown command: ${commandName}\nUse .help to see available commands`);
        return;
      }

      // Admin check
      if (command.adminOnly && !this.isAdmin(message.senderUsername)) {
        await this.sendReply(message, '❌ This command requires admin privileges');
        return;
      }

      // Log command execution
      logger.info(`Command executed: .${commandName} by @${message.senderUsername || 'unknown'}`);
      
      // Execute command with proper message format
      const commandMessage = {
        threadId: message.threadId,
        senderUsername: message.senderUsername,
        text: message.text,
        ...message
      };
      
      await command.handler(args, commandMessage);
      
    } catch (error) {
      logger.error(`Command execution error:`, error.message);
      await this.sendReply(message, `❌ Command error: ${error.message}`);
    }
  }

  async sendReply(message, text) {
    try {
      await this.instagramClient.sendMessage(message.threadId, text);
    } catch (error) {
      logger.error('Error sending reply:', error.message);
    }
  }

  isAdmin(username) {
    if (!username) return false;
    return config.admin.users.includes(username.toLowerCase());
  }

  setCommandPrefix(prefix) {
    this.commandPrefix = prefix;
    logger.info(`Command prefix changed to: ${prefix}`);
  }
}