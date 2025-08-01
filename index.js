import { HyperInstaBot } from './core/bot.js';

// Create and start the bot
const bot = new HyperInstaBot();
bot.start().catch((error) => {
  console.error('❌ Failed to start bot:', error.message);
  process.exit(1);
});