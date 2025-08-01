import { InstagramClient } from './instagram-client.js';
import { TelegramBridge } from '../telegram/telegram-bridge.js';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { connectDb } from '../utils/db.js';

class HyperInstaBot {
  constructor() {
    this.startTime = new Date();
    this.instagramClient = new InstagramClient();
    this.telegramBridge = config.telegram?.enabled ? new TelegramBridge() : null;
    this.moduleManager = null;
    this.messageHandler = null;
    this.isRunning = false;
  }

  async initialize() {
    try {
      this.showStartupBanner();

      // Initialize database connection
      logger.info('🗄️ Connecting to MongoDB...');
      await connectDb();
      logger.info('✅ MongoDB connected');

      // Initialize Instagram client
      logger.info('📱 Initializing Instagram client...');
      await this.instagramClient.initialize();
      logger.info('✅ Instagram client ready');

      // Initialize Telegram bridge if enabled
      if (this.telegramBridge) {
        logger.info('📨 Initializing Telegram bridge...');
        await this.telegramBridge.initialize(this.instagramClient);
        logger.info('✅ Telegram bridge ready');
      }

      // Initialize module manager
      logger.info('🔌 Loading modules...');
      this.moduleManager = new ModuleManager(this.instagramClient, this.telegramBridge);
      await this.moduleManager.loadModules();
      logger.info('✅ Modules loaded');

      // Initialize message handler
      logger.info('📨 Setting up message handler...');
      this.messageHandler = new MessageHandler(this.instagramClient, this.moduleManager, this.telegramBridge);
      
      // Connect message handler to Instagram client
      this.instagramClient.on('messageCreate', (message) => {
        this.messageHandler.handleMessage(message);
      });
      
      logger.info('✅ Message handler connected');

      // Setup error handlers
      this.setupErrorHandlers();

      this.isRunning = true;
      logger.info('🚀 Bot initialization complete!');
      this.showLiveStatus();

    } catch (error) {
      logger.error(`❌ Bot initialization failed: ${error.message}`);
      logger.debug(error.stack);
      await this.cleanup();
      process.exit(1);
    }
  }

  setupErrorHandlers() {
    // Instagram client error handlers
    this.instagramClient.on('error', (error) => {
      logger.error('Instagram client error:', error.message);
    });

    this.instagramClient.on('disconnected', () => {
      logger.warn('Instagram client disconnected');
      this.isRunning = false;
    });

    // Telegram bridge error handlers
    if (this.telegramBridge) {
      this.telegramBridge.on('error', (error) => {
        logger.error('Telegram bridge error:', error.message);
      });
    }

    // Process error handlers
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error.message);
      logger.debug(error.stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    });
  }

  showStartupBanner() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - PROFESSIONAL BOT v2.0                  ║
║                                                              ║
║    ⚡ Event-Based • 🔌 Modular • 🛡️ Enterprise Ready      ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
  }

  showLiveStatus() {
    const uptime = Date.now() - this.startTime;
    console.clear();
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - LIVE & OPERATIONAL                     ║
║                                                              ║
║    ✅ Instagram: Connected & Real-time                      ║
║    ${this.telegramBridge?.enabled ? '✅' : '❌'} Telegram: ${this.telegramBridge?.enabled ? 'Connected & Bridged' : 'Disabled'}                        ║
║    🔌 Modules: ${this.moduleManager?.modules?.length || 0} Active                                    ║
║    ⚡ Startup Time: ${Math.round(uptime)}ms                                  ║
║    🕒 Started: ${this.startTime.toLocaleTimeString()}                                ║
║                                                              ║
║    🎯 Ready for INSTANT event-based processing...          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🔥 Bot is running with PROFESSIONAL architecture!
💡 All features are EVENT-BASED (no polling)
📱 Type .help in Instagram to see all commands
    `);

    // Periodic status updates
    setInterval(() => {
      if (this.isRunning) {
        const stats = this.getStats();
        logger.info(`💓 Bot Status - Messages: ${stats.messages}, Commands: ${stats.commands}, Uptime: ${stats.uptime}`);
      }
    }, 300000); // Every 5 minutes
  }

  getStats() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const coreModule = this.moduleManager?.getModule('core');
    
    return {
      messages: coreModule?.messageCount || 0,
      commands: coreModule?.commandCount || 0,
      uptime: `${Math.floor(uptime / 60)}m ${uptime % 60}s`,
      modules: this.moduleManager?.modules?.length || 0,
      isRunning: this.isRunning
    };
  }

  async cleanup() {
    logger.info('🛑 Starting graceful shutdown...');
    
    try {
      this.isRunning = false;

      // Cleanup modules
      if (this.moduleManager) {
        await this.moduleManager.cleanup();
      }

      // Cleanup Telegram bridge
      if (this.telegramBridge) {
        await this.telegramBridge.shutdown();
      }

      // Cleanup Instagram client
      if (this.instagramClient) {
        await this.instagramClient.disconnect();
      }

      logger.info('✅ Graceful shutdown complete');
    } catch (error) {
      logger.error('❌ Error during cleanup:', error.message);
    }
  }

  async start() {
    await this.initialize();

    // Graceful shutdown handlers
    const shutdownHandler = async (signal) => {
      logger.info(`\n👋 Received ${signal}, shutting down gracefully...`);
      await this.cleanup();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdownHandler('SIGINT'));
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
  }
}

// Main execution
async function main() {
  const bot = new HyperInstaBot();
  await bot.start();
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  });
}

export { HyperInstaBot };