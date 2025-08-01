import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { connectDb } from '../utils/db.js';

export class TelegramBridge extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.instagramClient = null;
    this.chatMappings = new Map(); // instagramThreadId -> telegramTopicId
    this.userMappings = new Map(); // instagramUserId -> userInfo
    this.topicCreationQueue = new Map(); // instagramThreadId -> Promise
    this.db = null;
    this.collection = null;
    this.tempDir = path.join(process.cwd(), 'temp');
    this.enabled = false;
  }

  async initialize(instagramClient) {
    try {
      this.instagramClient = instagramClient;
      
      const token = config.telegram?.botToken;
      const chatId = config.telegram?.chatId;

      if (!token || !chatId) {
        logger.warn('⚠️ Telegram configuration missing, bridge disabled');
        return;
      }

      await this.initializeDatabase();
      await fs.ensureDir(this.tempDir);

      this.bot = new TelegramBot(token, { polling: true });
      await this.setupTelegramHandlers();
      await this.setupInstagramHandlers();
      await this.loadMappingsFromDb();

      this.enabled = true;
      logger.info('✅ Telegram bridge initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize Telegram bridge:', error.message);
      this.enabled = false;
    }
  }

  async initializeDatabase() {
    this.db = await connectDb();
    this.collection = this.db.collection('telegram_bridge');
    
    // Create indexes
    await this.collection.createIndex({ 
      type: 1, 
      'data.instagramThreadId': 1 
    }, { 
      unique: true, 
      partialFilterExpression: { type: 'chat' } 
    });
  }

  async loadMappingsFromDb() {
    try {
      const mappings = await this.collection.find({}).toArray();
      
      for (const mapping of mappings) {
        if (mapping.type === 'chat') {
          this.chatMappings.set(mapping.data.instagramThreadId, mapping.data.telegramTopicId);
        } else if (mapping.type === 'user') {
          this.userMappings.set(mapping.data.instagramUserId, mapping.data);
        }
      }

      logger.info(`📊 Loaded ${this.chatMappings.size} chat mappings and ${this.userMappings.size} user mappings`);
    } catch (error) {
      logger.error('❌ Failed to load mappings:', error.message);
    }
  }

  async setupTelegramHandlers() {
    this.bot.on('message', async (msg) => {
      try {
        if (msg.chat.type === 'supergroup' && msg.is_topic_message && msg.message_thread_id) {
          await this.handleTelegramMessage(msg);
        }
      } catch (error) {
        logger.error('❌ Error handling Telegram message:', error.message);
      }
    });

    this.bot.on('polling_error', (error) => {
      logger.error('❌ Telegram polling error:', error.message);
    });

    logger.info('📱 Telegram handlers setup complete');
  }

  async setupInstagramHandlers() {
    this.instagramClient.on('message', async (message) => {
      try {
        await this.handleInstagramMessage(message);
      } catch (error) {
        logger.error('❌ Error handling Instagram message:', error.message);
      }
    });

    logger.info('📱 Instagram handlers setup complete');
  }

  async handleInstagramMessage(message) {
    if (!this.enabled) return;

    try {
      // Update user mapping
      await this.updateUserMapping(message.senderId, {
        username: message.senderUsername,
        fullName: message.senderFullName,
        profilePic: message.senderProfilePic,
        lastSeen: new Date()
      });

      // Get or create topic
      const topicId = await this.getOrCreateTopic(message.threadId, message);
      if (!topicId) return;

      // Send message to Telegram
      await this.sendToTelegram(message, topicId);

    } catch (error) {
      logger.error('❌ Error processing Instagram message:', error.message);
    }
  }

  async getOrCreateTopic(instagramThreadId, message) {
    // Check if topic already exists
    if (this.chatMappings.has(instagramThreadId)) {
      return this.chatMappings.get(instagramThreadId);
    }

    // Check if creation is already in progress
    if (this.topicCreationQueue.has(instagramThreadId)) {
      return await this.topicCreationQueue.get(instagramThreadId);
    }

    // Create new topic
    const creationPromise = this.createTopic(instagramThreadId, message);
    this.topicCreationQueue.set(instagramThreadId, creationPromise);

    try {
      const topicId = await creationPromise;
      return topicId;
    } finally {
      this.topicCreationQueue.delete(instagramThreadId);
    }
  }

  async createTopic(instagramThreadId, message) {
    try {
      const chatId = config.telegram.chatId;
      
      // Get user info for topic name
      let topicName = `@${message.senderUsername}`;
      if (message.senderFullName) {
        topicName = `${message.senderFullName} (@${message.senderUsername})`;
      }

      // Create topic
      const topic = await this.bot.createForumTopic(chatId, topicName, {
        icon_color: 0x7ABA3C
      });

      const topicId = topic.message_thread_id;

      // Save mapping
      await this.saveChatMapping(instagramThreadId, topicId);

      // Send welcome message with complete profile details
      await this.sendWelcomeMessage(topicId, message);

      logger.info(`🆕 Created topic "${topicName}" (${topicId}) for thread ${instagramThreadId}`);
      return topicId;

    } catch (error) {
      logger.error('❌ Failed to create topic:', error.message);
      return null;
    }
  }

  async sendWelcomeMessage(topicId, message) {
    try {
      const chatId = config.telegram.chatId;
      
      // Send profile picture first if available
      if (message.senderProfilePic) {
        try {
          await this.bot.sendPhoto(chatId, message.senderProfilePic, {
            message_thread_id: topicId,
            caption: '📸 Profile Picture'
          });
        } catch (error) {
          logger.debug('Could not send profile picture:', error.message);
        }
      }

      // Send detailed profile information
      const profileInfo = this.formatProfileInfo(message);
      const sentMessage = await this.bot.sendMessage(chatId, profileInfo, {
        message_thread_id: topicId,
        parse_mode: 'MarkdownV2'
      });

      // Pin the welcome message
      await this.bot.pinChatMessage(chatId, sentMessage.message_id);

    } catch (error) {
      logger.error('❌ Failed to send welcome message:', error.message);
    }
  }

  formatProfileInfo(message) {
    const escape = (text) => {
      if (!text) return 'N/A';
      return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    };

    return `👤 *Instagram Contact*

📝 *Username:* @${escape(message.senderUsername)}
🆔 *User ID:* ${escape(message.senderId)}
🏷️ *Full Name:* ${escape(message.senderFullName || 'Not available')}
📅 *First Contact:* ${escape(new Date().toLocaleDateString())}
🔗 *Thread ID:* ${escape(message.threadId)}
📱 *Thread Type:* ${message.isGroup ? 'Group' : 'Direct Message'}

💬 Messages from this contact will appear here`;
  }

  async sendToTelegram(message, topicId) {
    try {
      const chatId = config.telegram.chatId;

      if (message.type === 'text' && message.text) {
        await this.bot.sendMessage(chatId, message.text, {
          message_thread_id: topicId
        });
      } else if (message.type === 'media' && message.raw) {
        await this.handleInstagramMedia(message, topicId);
      } else {
        // Handle other message types
        const fallbackText = `[${message.type.toUpperCase()}] ${message.text || 'Media message'}`;
        await this.bot.sendMessage(chatId, fallbackText, {
          message_thread_id: topicId
        });
      }

    } catch (error) {
      logger.error('❌ Failed to send message to Telegram:', error.message);
    }
  }

  async handleInstagramMedia(message, topicId) {
    try {
      const chatId = config.telegram.chatId;
      const raw = message.raw;

      if (raw.media?.image_versions2?.candidates?.[0]?.url) {
        // Photo
        await this.bot.sendPhoto(chatId, raw.media.image_versions2.candidates[0].url, {
          message_thread_id: topicId,
          caption: message.text || ''
        });
      } else if (raw.media?.video_versions?.[0]?.url) {
        // Video
        await this.bot.sendVideo(chatId, raw.media.video_versions[0].url, {
          message_thread_id: topicId,
          caption: message.text || ''
        });
      } else if (raw.voice_media?.media?.audio?.audio_src) {
        // Voice message
        await this.bot.sendVoice(chatId, raw.voice_media.media.audio.audio_src, {
          message_thread_id: topicId
        });
      } else {
        // Fallback for unknown media
        await this.bot.sendMessage(chatId, `[MEDIA] ${message.text || 'Media content'}`, {
          message_thread_id: topicId
        });
      }

    } catch (error) {
      logger.error('❌ Failed to handle Instagram media:', error.message);
    }
  }

  async handleTelegramMessage(msg) {
    try {
      const topicId = msg.message_thread_id;
      const instagramThreadId = this.findInstagramThreadId(topicId);

      if (!instagramThreadId) {
        await this.setReaction(msg.chat.id, msg.message_id, '❓');
        return;
      }

      // Set processing reaction
      await this.setReaction(msg.chat.id, msg.message_id, '🔄');

      let success = false;

      if (msg.text) {
        success = await this.instagramClient.sendMessage(instagramThreadId, msg.text);
      } else if (msg.photo) {
        success = await this.handleTelegramPhoto(msg, instagramThreadId);
      } else if (msg.video) {
        success = await this.handleTelegramVideo(msg, instagramThreadId);
      } else if (msg.voice) {
        success = await this.handleTelegramVoice(msg, instagramThreadId);
      } else if (msg.document) {
        success = await this.handleTelegramDocument(msg, instagramThreadId);
      }

      // Set result reaction
      await this.setReaction(msg.chat.id, msg.message_id, success ? '✅' : '❌');

    } catch (error) {
      logger.error('❌ Failed to handle Telegram message:', error.message);
      await this.setReaction(msg.chat.id, msg.message_id, '❌');
    }
  }

  async handleTelegramPhoto(msg, instagramThreadId) {
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await this.bot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      await this.instagramClient.sendPhoto(instagramThreadId, buffer);
      
      // Send caption as separate message if exists
      if (msg.caption) {
        await this.instagramClient.sendMessage(instagramThreadId, msg.caption);
      }

      return true;
    } catch (error) {
      logger.error('❌ Failed to handle Telegram photo:', error.message);
      return false;
    }
  }

  async handleTelegramVideo(msg, instagramThreadId) {
    try {
      const fileId = msg.video.file_id;
      const fileLink = await this.bot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      await this.instagramClient.sendVideo(instagramThreadId, buffer);
      
      if (msg.caption) {
        await this.instagramClient.sendMessage(instagramThreadId, msg.caption);
      }

      return true;
    } catch (error) {
      logger.error('❌ Failed to handle Telegram video:', error.message);
      return false;
    }
  }

  async handleTelegramVoice(msg, instagramThreadId) {
    try {
      const fileId = msg.voice.file_id;
      const fileLink = await this.bot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      await this.instagramClient.sendVoice(instagramThreadId, buffer);
      return true;
    } catch (error) {
      logger.error('❌ Failed to handle Telegram voice:', error.message);
      return false;
    }
  }

  async handleTelegramDocument(msg, instagramThreadId) {
    try {
      // For documents, send as text with file info since Instagram doesn't support arbitrary files
      const fileInfo = `📎 Document: ${msg.document.file_name || 'Unnamed File'} (${(msg.document.file_size / 1024).toFixed(2)} KB)`;
      const message = msg.caption ? `${fileInfo}\n${msg.caption}` : fileInfo;
      
      await this.instagramClient.sendMessage(instagramThreadId, message);
      return true;
    } catch (error) {
      logger.error('❌ Failed to handle Telegram document:', error.message);
      return false;
    }
  }

  async setReaction(chatId, messageId, emoji) {
    try {
      const token = config.telegram.botToken;
      await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: emoji }]
      });
    } catch (error) {
      logger.debug('Failed to set reaction:', error.message);
    }
  }

  findInstagramThreadId(topicId) {
    for (const [threadId, topic] of this.chatMappings.entries()) {
      if (topic === topicId) {
        return threadId;
      }
    }
    return null;
  }

  async saveChatMapping(instagramThreadId, telegramTopicId) {
    try {
      await this.collection.updateOne(
        { type: 'chat', 'data.instagramThreadId': instagramThreadId },
        {
          $set: {
            type: 'chat',
            data: {
              instagramThreadId,
              telegramTopicId,
              createdAt: new Date(),
              lastActivity: new Date()
            }
          }
        },
        { upsert: true }
      );

      this.chatMappings.set(instagramThreadId, telegramTopicId);
    } catch (error) {
      logger.error('❌ Failed to save chat mapping:', error.message);
    }
  }

  async updateUserMapping(instagramUserId, userData) {
    try {
      const existingData = this.userMappings.get(instagramUserId) || {};
      const updatedData = { ...existingData, ...userData };

      await this.collection.updateOne(
        { type: 'user', 'data.instagramUserId': instagramUserId },
        {
          $set: {
            type: 'user',
            data: {
              instagramUserId,
              ...updatedData,
              updatedAt: new Date()
            }
          }
        },
        { upsert: true }
      );

      this.userMappings.set(instagramUserId, updatedData);
    } catch (error) {
      logger.error('❌ Failed to update user mapping:', error.message);
    }
  }

  async shutdown() {
    try {
      if (this.bot) {
        await this.bot.stopPolling();
      }
      await fs.emptyDir(this.tempDir);
      logger.info('✅ Telegram bridge shutdown complete');
    } catch (error) {
      logger.error('❌ Error during shutdown:', error.message);
    }
  }
}