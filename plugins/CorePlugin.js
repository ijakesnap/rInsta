import { logger, fileUtils } from '../utils.js';
import { config } from '../config.js';
import os from 'os';
import fs from 'fs';

export class CorePlugin {
  constructor(instagramBot) {
    this.name = 'Core';
    this.instagramBot = instagramBot;
    this.startTime = new Date();
    this.commandPrefix = '!';
    this.commands = {
      'ping': {
        description: 'Check if bot is responsive',
        usage: '!ping',
        handler: this.handlePing.bind(this)
      },
      'status': {
        description: 'Show bot status and system information',
        usage: '!status',
        handler: this.handleStatus.bind(this)
      },
      'uptime': {
        description: 'Show how long the bot has been running',
        usage: '!uptime',
        handler: this.handleUptime.bind(this)
      },
      'logs': {
        description: 'Show recent bot logs',
        usage: '!logs [count]',
        handler: this.handleLogs.bind(this)
      },
      'info': {
        description: 'Show bot information',
        usage: '!info',
        handler: this.handleInfo.bind(this)
      },
      'restart': {
        description: 'Restart the bot (admin only)',
        usage: '!restart',
        handler: this.handleRestart.bind(this),
        adminOnly: true
      },
      'stats': {
        description: 'Show bot statistics',
        usage: '!stats',
        handler: this.handleStats.bind(this)
      }
    };
    this.messageCount = 0;
    this.commandCount = 0;
    this.logBuffer = [];
    this.maxLogBuffer = 100;
  }

  async process(message) {
    try {
      this.messageCount++;
      
      // Check if message starts with command prefix
      if (message.text && message.text.startsWith(this.commandPrefix)) {
        const commandText = message.text.slice(this.commandPrefix.length).trim();
        const [commandName, ...args] = commandText.split(' ');
        
        if (this.commands[commandName.toLowerCase()]) {
          this.commandCount++;
          await this.executeCommand(commandName.toLowerCase(), args, message);
          message.shouldForward = false; // Don't forward command messages
        }
      }

      // Log the message to buffer
      this.addToLogBuffer(`[${message.timestamp.toISOString()}] @${message.senderUsername}: ${message.text || '[Media]'}`);

    } catch (error) {
      logger.error('Error in Core plugin:', error);
    }

    return message;
  }

  async executeCommand(commandName, args, message) {
    try {
      const command = this.commands[commandName];
      
      // Check if command requires admin privileges
      if (command.adminOnly && !this.isAdmin(message.senderUsername)) {
        await this.sendReply(message, '❌ This command requires admin privileges.');
        return;
      }

      logger.info(`🎯 Executing command: ${commandName} by @${message.senderUsername}`);
      await command.handler(args, message);
      
    } catch (error) {
      logger.error(`Error executing command ${commandName}:`, error);
      await this.sendReply(message, `❌ Error executing command: ${error.message}`);
    }
  }

  async handlePing(args, message) {
    const startTime = Date.now();
    await this.sendReply(message, '🏓 Pong!');
    const responseTime = Date.now() - startTime;
    logger.info(`📊 Ping response time: ${responseTime}ms`);
  }

  async handleStatus(args, message) {
    const uptime = this.getUptime();
    const memoryUsage = process.memoryUsage();
    const systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      totalMemory: Math.round(os.totalmem() / 1024 / 1024),
      freeMemory: Math.round(os.freemem() / 1024 / 1024),
      cpuCount: os.cpus().length
    };

    const statusMessage = `🤖 **Bot Status**\n\n` +
      `✅ Status: Online\n` +
      `⏱️ Uptime: ${uptime}\n` +
      `📊 Messages Processed: ${this.messageCount}\n` +
      `🎯 Commands Executed: ${this.commandCount}\n` +
      `💾 Memory Usage: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB\n` +
      `🖥️ System: ${systemInfo.platform} ${systemInfo.arch}\n` +
      `🟢 Node.js: ${systemInfo.nodeVersion}\n` +
      `💻 CPU Cores: ${systemInfo.cpuCount}\n` +
      `🧠 Total RAM: ${systemInfo.totalMemory}MB\n` +
      `🆓 Free RAM: ${systemInfo.freeMemory}MB`;

    await this.sendReply(message, statusMessage);
  }

  async handleUptime(args, message) {
    const uptime = this.getUptime();
    await this.sendReply(message, `⏱️ Bot uptime: ${uptime}`);
  }

  async handleLogs(args, message) {
    const count = parseInt(args[0]) || 10;
    const logCount = Math.min(count, this.maxLogBuffer);
    const recentLogs = this.logBuffer.slice(-logCount);
    
    if (recentLogs.length === 0) {
      await this.sendReply(message, '📝 No recent logs available.');
      return;
    }

    const logsMessage = `📝 **Recent Logs (${recentLogs.length})**\n\n` +
      recentLogs.join('\n');

    await this.sendReply(message, logsMessage);
  }

  async handleInfo(args, message) {
    const packageInfo = await this.getPackageInfo();
    
    const infoMessage = `ℹ️ **Bot Information**\n\n` +
      `📱 Name: ${packageInfo.name || 'Instagram UserBot'}\n` +
      `🔢 Version: ${packageInfo.version || '1.0.0'}\n` +
      `👨‍💻 Author: ${packageInfo.author || 'Unknown'}\n` +
      `📄 Description: ${packageInfo.description || 'Instagram UserBot with plugin system'}\n` +
      `🚀 Started: ${this.startTime.toLocaleString()}\n` +
      `🔧 Prefix: ${this.commandPrefix}\n` +
      `🎯 Available Commands: ${Object.keys(this.commands).length}`;

    await this.sendReply(message, infoMessage);
  }

  async handleRestart(args, message) {
    await this.sendReply(message, '🔄 Restarting bot...');
    logger.info('🔄 Bot restart requested by admin');
    
    // Give time for the message to be sent
    setTimeout(() => {
      process.exit(0);
    }, 2000);
  }

  async handleStats(args, message) {
    const stats = {
      messagesProcessed: this.messageCount,
      commandsExecuted: this.commandCount,
      uptime: this.getUptime(),
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      logBufferSize: this.logBuffer.length
    };

    const statsMessage = `📊 **Bot Statistics**\n\n` +
      `💬 Messages Processed: ${stats.messagesProcessed}\n` +
      `🎯 Commands Executed: ${stats.commandsExecuted}\n` +
      `⏱️ Uptime: ${stats.uptime}\n` +
      `💾 Memory Usage: ${stats.memoryUsage}MB\n` +
      `📝 Log Buffer: ${stats.logBufferSize}/${this.maxLogBuffer}`;

    await this.sendReply(message, statsMessage);
  }

  async sendReply(message, text) {
    try {
      if (this.instagramBot && this.instagramBot.sendMessage) {
        await this.instagramBot.sendMessage(message.threadId, text);
      } else {
        logger.info(`🤖 Reply to @${message.senderUsername}: ${text}`);
      }
    } catch (error) {
      logger.error('Error sending reply:', error);
    }
  }

  getUptime() {
    const uptimeMs = Date.now() - this.startTime.getTime();
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((uptimeMs % (1000 * 60)) / 1000);

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m ${seconds}s`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  async getPackageInfo() {
    try {
      if (await fileUtils.pathExists('./package.json')) {
        return await fileUtils.readJson('./package.json');
      }
    } catch (error) {
      logger.warn('Could not read package.json:', error.message);
    }
    return {};
  }

  isAdmin(username) {
    // You can configure admin users in config or environment
    const adminUsers = (process.env.ADMIN_USERS || '').split(',').filter(Boolean);
    return adminUsers.includes(username.toLowerCase());
  }

  addToLogBuffer(logEntry) {
    this.logBuffer.push(logEntry);
    if (this.logBuffer.length > this.maxLogBuffer) {
      this.logBuffer.shift(); // Remove oldest entry
    }
  }

  getCommands() {
    return this.commands;
  }

  async cleanup() {
    logger.info(`🧹 Core plugin cleaned up. Processed ${this.messageCount} messages, executed ${this.commandCount} commands`);
  }
}