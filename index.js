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
  }

  async initialize() {
    try {
      this.showStartupBanner();

      logger.info('🗄️ Connecting to MongoDB...');
      await connectDb();
      logger.info('✅ MongoDB connected');

      logger.info('📱 Connecting to Instagram...');
      await this.instagramBot.login();
      logger.info('✅ Instagram connected');

      if (this.telegramBridge) {
        logger.info('📨 Initializing Telegram bridge...');
        await this.telegramBridge.initialize(this.instagramBot);
        logger.info('✅ Telegram bridge connected');
      }

      logger.info('🔌 Loading modules...');
      const moduleManager = new ModuleManager(this.instagramBot);
      await moduleManager.loadModules();
      logger.info('✅ Modules loaded');

      logger.info('📨 Initializing message handler...');
      const messageHandler = new MessageHandler(this.instagramBot, moduleManager, this.telegramBridge);
      this.instagramBot.onMessage((message) => messageHandler.handleMessage(message));
      logger.info('✅ Message handler connected');

      await this.instagramBot.startMessageRequestsMonitor(config.messageRequestInterval || 300000);
      logger.info('🕒 Message request monitor started');

      logger.info('✅ Bot is now LIVE and ready!');
      this.showLiveStatus();

    } catch (error) {
      logger.error(`❌ Startup failed: ${error.message}`);
      logger.debug('Error stack:', error.stack);
      // Attempt cleanup
      if (this.instagramBot) {
        try {
          await this.instagramBot.disconnect();
        } catch (disconnectError) {
          logger.error('❌ Error during cleanup disconnect:', disconnectError.message);
        }
      }
      process.exit(1);
    }
  }

  showStartupBanner() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - INITIALIZING                           ║
║                                                              ║
║    ⚡ Ultra Fast • 🔌 Modular • 🛡️ Robust                  ║
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
║    ✅ Instagram: Connected & Active                         ║
║    ${this.telegramBridge ? '✅' : '❌'} Telegram: ${this.telegramBridge ? 'Connected & Bridged' : 'Disabled'}                        ║
║    ⚡ Startup Time: ${Math.round(uptime)}ms                                  ║
║    🕒 Started: ${this.startTime.toLocaleTimeString()}                                ║
║                                                              ║
║    🎯 Ready for INSTANT commands...                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🔥 Bot is running at MAXIMUM PERFORMANCE!
💡 Type .help in Instagram to see all commands
    `);
  }

  async start() {
    await this.initialize();

    process.on('SIGINT', async () => {
      logger.info('\n🛑 Shutting down gracefully...');
      
      if (this.telegramBridge) {
        await this.telegramBridge.shutdown();
      }
      
      await this.instagramBot.disconnect();
      logger.info('✅ Hyper Insta stopped');
      process.exit(0);
    });
  }
}

const bot = new HyperInsta();
bot.start().catch((error) => {
  logger.error('❌ Fatal error:', error.message);
  process.exit(1);
});
