
import { InstagramBot } from './core/bot.js';
import { TelegramBridge } from './telegram/bridge.js';
import { ModuleManager } from './core/module-manager.js';
import { MessageHandler } from './core/message-handler.js';
import { logger } from './utils/logger.js'; 
import { config } from './config.js';
import { connectDb } from './utils/db.js';

class HyperInsta {
  constructor() {
    this.startTime = new Date();
    this.instagramBot = new InstagramBot();
    this.telegramBridge = config.telegram?.enabled ? new TelegramBridge() : null;
    this.moduleManager = null;
    this.messageHandler = null;
    this.isShuttingDown = false;
  }

  async initialize() {
    try {
      this.showStartupBanner();

      // Initialize database connection
      logger.info('Connecting to MongoDB...');
      await connectDb();
      logger.info('MongoDB connected successfully');

      // Initialize Instagram bot
      logger.info('Connecting to Instagram...');
      await this.instagramBot.login();
      logger.info('Instagram connected successfully');

      // Initialize Telegram bridge if enabled
      if (this.telegramBridge) {
        logger.info('Initializing Telegram bridge...');
        await this.telegramBridge.initialize(this.instagramBot);
        if (this.telegramBridge.enabled) {
          logger.info('Telegram bridge connected successfully');
        } else {
          logger.warn('Telegram bridge failed to initialize');
        }
      }

      // Initialize module manager
      logger.info('Loading modules...');
      this.moduleManager = new ModuleManager(this.instagramBot, this.telegramBridge);
      await this.moduleManager.loadModules();
      logger.info('Modules loaded successfully');

      // Initialize message handler
      logger.info('Setting up message handler...');
      this.messageHandler = new MessageHandler(
        this.instagramBot, 
        this.moduleManager, 
        this.telegramBridge
      );

      // Connect message handler to Instagram bot
      this.instagramBot.on('message', (message) => {
        this.messageHandler.handleMessage(message);
      });

      // Setup error handlers
      this.setupErrorHandlers();

      logger.info('Bot initialization complete');
      this.showLiveStatus();

      return true;

    } catch (error) {
      logger.error(`Startup failed: ${error.message}`);
      await this.cleanup();
      throw error;
    }
  }

  setupErrorHandlers() {
    // Instagram bot error handler
    this.instagramBot.on('error', async (error) => {
      logger.error('Instagram bot error:', error.message);
      if (!this.isShuttingDown) {
        // Attempt to restart after a delay
        setTimeout(async () => {
          try {
            logger.info('Attempting to restart Instagram connection...');
            await this.instagramBot.login();
          } catch (restartError) {
            logger.error('Failed to restart Instagram connection:', restartError.message);
          }
        }, 30000); // 30 second delay
      }
    });

    // Process error handlers
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error.message);
      logger.error('Stack:', error.stack);
      this.gracefulShutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      this.gracefulShutdown();
    });

    // Graceful shutdown handlers
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      this.gracefulShutdown();
    });

    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      this.gracefulShutdown();
    });
  }

  async gracefulShutdown() {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress...');
      return;
    }

    this.isShuttingDown = true;
    logger.info('Starting graceful shutdown...');

    try {
      // Cleanup modules
      if (this.moduleManager) {
        await this.moduleManager.cleanup();
      }

      // Shutdown Telegram bridge
      if (this.telegramBridge) {
        await this.telegramBridge.shutdown();
      }

      // Disconnect Instagram bot
      if (this.instagramBot) {
        await this.instagramBot.disconnect();
      }

      logger.info('Graceful shutdown complete');
      process.exit(0);

    } catch (error) {
      logger.error('Error during shutdown:', error.message);
      process.exit(1);
    }
  }

  async cleanup() {
    try {
      if (this.instagramBot) {
        await this.instagramBot.disconnect();
      }
      if (this.telegramBridge) {
        await this.telegramBridge.shutdown();
      }
      if (this.moduleManager) {
        await this.moduleManager.cleanup();
      }
    } catch (error) {
      logger.error('Error during cleanup:', error.message);
    }
  }

  showStartupBanner() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - PROFESSIONAL EDITION                   ║
║                                                              ║
║    ⚡ Lightning Fast • 🔌 Modular • 🛡️ Enterprise Ready    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
  }

  showLiveStatus() {
    const uptime = Date.now() - this.startTime;
    const moduleStats = this.moduleManager?.getModuleStats();
    
    console.clear();
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - LIVE & OPERATIONAL                     ║
║                                                              ║
║    ✅ Instagram: Connected & Active                         ║
║    ${this.telegramBridge?.enabled ? '✅' : '❌'} Telegram: ${this.telegramBridge?.enabled ? 'Connected & Bridged' : 'Disabled'}                        ║
║    🔌 Modules: ${moduleStats?.totalModules || 0} loaded (${moduleStats?.totalCommands || 0} commands)                    ║
║    ⚡ Startup Time: ${Math.round(uptime)}ms                                  ║
║    🕒 Started: ${this.startTime.toLocaleTimeString()}                                ║
║                                                              ║
║    🎯 Ready for commands and automation...                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🔥 Bot is running at maximum performance!
💡 Type .help in Instagram to see all commands
📊 Environment: ${config.app.environment}
🔧 Log Level: ${config.app.logLevel}
    `);
  }

  async start() {
    try {
      await this.initialize();
      
      // Keep the process alive
      setInterval(() => {
        if (!this.isShuttingDown) {
          logger.debug(`Bot heartbeat - Uptime: ${Math.round((Date.now() - this.startTime) / 1000)}s`);
        }
      }, 300000); // Every 5 minutes

    } catch (error) {
      logger.error('Failed to start bot:', error.message);
      process.exit(1);
    }
  }
}

// Start the bot
const bot = new HyperInsta();
bot.start().catch((error) => {
  logger.error('Unhandled startup error:', error.message);
  process.exit(1);
});
