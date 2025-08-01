import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { connectDb } from '../utils/db.js';
import Attachment from '../functions/Attachment.js';

export class TelegramBridge extends EventEmitter {
  constructor() {
    super();
    this.bot = null;
    this.instagramClient = null;
    this.chatMappings = new Map(); // instagramThreadId -> telegramTopicId
    this.userMappings = new Map(); // instagramUserId -> userInfo
    this.profilePicCache = new Map(); // instagramId -> profilePicUrl
    this.topicCreationQueue = new Map(); // instagramThreadId -> Promise
    this.topicVerificationCache = new Map(); // topicId -> boolean
    this.db = null;
    this.collection = null;
    this.tempDir = path.join(process.cwd(), 'temp');
    this.telegramChatId = null;
    this.enabled = false;
    this.filters = new Set();
    this.creatingTopics = new Map();
  }

  async initialize(instagramClient) {
    try {
      this.instagramClient = instagramClient;
      
      const token = config.telegram?.botToken;
      this.telegramChatId = config.telegram?.chatId;

      if (!token || !this.telegramChatId || token.includes('YOUR_BOT_TOKEN') || this.telegramChatId.includes('YOUR_CHAT_ID')) {
        logger.warn('⚠️ Telegram configuration missing, bridge disabled');
        return;
      }

      await this.initializeDatabase();
      await fs.ensureDir(this.tempDir);

      this.bot = new TelegramBot(token, { polling: true });
      await this.setupTelegramHandlers();
      await this.setupInstagramHandlers();
      await this.loadMappingsFromDb();
      await this.loadFiltersFromDb();

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

    await this.collection.createIndex({ 
      type: 1, 
      'data.instagramUserId': 1 
    }, { 
      unique: true, 
      partialFilterExpression: { type: 'user' } 
    });
  }

  async loadMappingsFromDb() {
    try {
      const mappings = await this.collection.find({}).toArray();
      
      for (const mapping of mappings) {
        switch (mapping.type) {
          case 'chat':
            this.chatMappings.set(mapping.data.instagramThreadId, mapping.data.telegramTopicId);
            if (mapping.data.profilePicUrl) {
              this.profilePicCache.set(mapping.data.instagramThreadId, mapping.data.profilePicUrl);
            }
            break;
          case 'user':
            this.userMappings.set(mapping.data.instagramUserId, {
              username: mapping.data.username,
              fullName: mapping.data.fullName,
              profilePic: mapping.data.profilePic,
              firstSeen: mapping.data.firstSeen,
              messageCount: mapping.data.messageCount || 0
            });
            break;
        }
      }

      logger.info(`📊 Loaded ${this.chatMappings.size} chat mappings and ${this.userMappings.size} user mappings`);
    } catch (error) {
      logger.error('❌ Failed to load mappings:', error.message);
    }
  }

  async loadFiltersFromDb() {
    this.filters = new Set();
    if (!this.collection) return;
    
    try {
      const filterDocs = await this.collection.find({ type: 'filter' }).toArray();
      for (const doc of filterDocs) {
        this.filters.add(doc.data.word);
      }
      logger.info(`✅ Loaded ${this.filters.size} filters from DB`);
    } catch (error) {
      logger.error('❌ Failed to load filters:', error.message);
    }
  }

  async setupTelegramHandlers() {
    this.bot.on('message', this.wrapHandler(async (msg) => {
      if (
        (msg.chat.type === 'supergroup' || msg.chat.type === 'group') &&
        msg.is_topic_message &&
        msg.message_thread_id
      ) {
        await this.handleTelegramMessage(msg);
      } else if (msg.chat.type === 'private') {
        logger.info(`📩 Received private message from Telegram user ${msg.from.id}: ${msg.text}`);
        // Handle bot commands if needed
      }
    }));

    this.bot.on('polling_error', (error) => {
      logger.error('❌ Telegram polling error:', error.message);
    });

    this.bot.on('error', (error) => {
      logger.error('❌ Telegram bot error:', error.message);
    });

    logger.info('📱 Telegram handlers setup complete');
  }

  wrapHandler(handler) {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        logger.error('❌ Unhandled error in Telegram handler:', error.message);
      }
    };
  }

  async setupInstagramHandlers() {
    this.instagramClient.on('messageCreate', async (message) => {
      try {
        await this.handleInstagramMessage(message);
      } catch (error) {
        logger.error('❌ Error handling Instagram message:', error.message);
      }
    });

    // Handle new followers in real-time
    this.instagramClient.on('newFollower', async (user) => {
      try {
        await this.handleNewFollower(user);
      } catch (error) {
        logger.error('❌ Error handling new follower:', error.message);
      }
    });

    // Handle user updates
    this.instagramClient.on('userUpdate', async (user) => {
      try {
        await this.updateUserMapping(user.id, {
          username: user.username,
          fullName: user.fullName,
          profilePic: user.avatarURL
        });
      } catch (error) {
        logger.error('❌ Error handling user update:', error.message);
      }
    });

    logger.info('📱 Instagram handlers setup complete');
  }

  async handleInstagramMessage(message) {
    if (!this.enabled) return;

    try {
      // Get complete user info with proper username resolution
      const userId = message.authorID || message.senderId;
      let userInfo = await this.getCompleteUserInfo(userId);
      
      // Update user mapping with complete info
      await this.updateUserMapping(userId, {
        username: userInfo.username,
        fullName: userInfo.fullName,
        profilePic: userInfo.avatarURL,
        lastSeen: new Date(),
        messageCount: (this.userMappings.get(userId)?.messageCount || 0) + 1
      });

      // Get or create topic with complete profile details
      const topicId = await this.getOrCreateTopic(message.chatID, userInfo);
      if (!topicId) return;

      // Check filters
      const textLower = (message.content || '').toLowerCase().trim();
      for (const word of this.filters) {
        if (textLower.startsWith(word)) {
          logger.info(`🛑 Blocked Instagram ➝ Telegram message due to filter "${word}": ${message.content}`);
          return;
        }
      }

      // Send message to Telegram based on type
      await this.sendInstagramMessageToTelegram(message, topicId, userInfo);

    } catch (error) {
      logger.error('❌ Error processing Instagram message:', error.message);
    }
  }

  async getCompleteUserInfo(userId) {
    try {
      // First check cache
      let cachedUser = this.instagramClient.cache.users.get(userId);
      if (cachedUser) {
        return cachedUser;
      }

      // Fetch from Instagram API
      const userInfo = await this.instagramClient.getUserInfo(userId);
      if (userInfo) {
        // Create User instance for consistency
        const user = this.instagramClient._patchOrCreateUser(userId, userInfo);
        return user;
      }

      // Fallback
      return {
        id: userId,
        username: `user_${userId}`,
        fullName: 'Unknown User',
        avatarURL: null
      };
    } catch (error) {
      logger.error(`❌ Error getting complete user info for ${userId}:`, error.message);
      return {
        id: userId,
        username: `user_${userId}`,
        fullName: 'Unknown User',
        avatarURL: null
      };
    }
  }

  async getOrCreateTopic(instagramThreadId, userInfo) {
    // Check if topic already exists
    if (this.chatMappings.has(instagramThreadId)) {
      return this.chatMappings.get(instagramThreadId);
    }

    // Check if creation is already in progress
    if (this.creatingTopics.has(instagramThreadId)) {
      logger.debug(`⏳ Topic creation for ${instagramThreadId} already in progress, waiting...`);
      return await this.creatingTopics.get(instagramThreadId);
    }

    // Create new topic
    const creationPromise = this.createTopicWithCompleteProfile(instagramThreadId, userInfo);
    this.creatingTopics.set(instagramThreadId, creationPromise);

    try {
      const topicId = await creationPromise;
      return topicId;
    } finally {
      this.creatingTopics.delete(instagramThreadId);
    }
  }

  async createTopicWithCompleteProfile(instagramThreadId, userInfo) {
    try {
      if (!this.telegramChatId) {
        logger.error('❌ Telegram chat ID not configured');
        return null;
      }

      // Create topic name with complete info
      let topicName = `@${userInfo.username}`;
      if (userInfo.fullName && userInfo.fullName !== userInfo.username) {
        topicName = `${userInfo.fullName} (@${userInfo.username})`;
      }

      // Create topic
      const topic = await this.bot.createForumTopic(this.telegramChatId, topicName, {
        icon_color: 0x7ABA3C
      });

      const topicId = topic.message_thread_id;

      // Save mapping with profile pic
      await this.saveChatMapping(instagramThreadId, topicId, userInfo.avatarURL);

      // Send complete welcome message with profile details
      await this.sendCompleteWelcomeMessage(topicId, instagramThreadId, userInfo);

      logger.info(`🆕 Created topic "${topicName}" (${topicId}) for thread ${instagramThreadId}`);
      return topicId;

    } catch (error) {
      logger.error('❌ Failed to create topic:', error.message);
      return null;
    }
  }

  async sendCompleteWelcomeMessage(topicId, instagramThreadId, userInfo) {
    try {
      const chatId = this.telegramChatId;
      
      // Send profile picture first if available
      if (userInfo.avatarURL) {
        try {
          await this.bot.sendPhoto(chatId, userInfo.avatarURL, {
            message_thread_id: topicId,
            caption: '📸 Profile Picture'
          });
        } catch (error) {
          logger.debug('Could not send profile picture:', error.message);
        }
      }

      // Send complete profile information
      const profileInfo = this.formatCompleteProfileInfo(userInfo, instagramThreadId);
      const sentMessage = await this.bot.sendMessage(chatId, profileInfo, {
        message_thread_id: topicId,
        parse_mode: 'MarkdownV2'
      });

      // Pin the welcome message
      await this.bot.pinChatMessage(chatId, sentMessage.message_id);

      logger.info(`🎉 Complete welcome message sent for thread ${instagramThreadId}`);
    } catch (error) {
      const errorMessage = error.response?.body?.description || error.message;
      logger.error(`❌ Failed to send complete welcome message:`, errorMessage);
    }
  }

  formatCompleteProfileInfo(userInfo, instagramThreadId) {
    const escape = (text) => {
      if (!text) return 'N/A';
      return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    };

    const userMapping = this.userMappings.get(userInfo.id) || {};
    
    return `👤 *Instagram Contact Information*

📝 *Username:* @${escape(userInfo.username)}
🆔 *User ID:* ${escape(userInfo.id)}
🏷️ *Full Name:* ${escape(userInfo.fullName || 'Not available')}
✅ *Verified:* ${userInfo.isVerified ? 'Yes' : 'No'}
🔒 *Private:* ${userInfo.isPrivate ? 'Yes' : 'No'}
💼 *Business:* ${userInfo.isBusiness ? 'Yes' : 'No'}
👥 *Followers:* ${escape(userInfo.followerCount?.toLocaleString() || 'N/A')}
➡️ *Following:* ${escape(userInfo.followingCount?.toLocaleString() || 'N/A')}
📸 *Posts:* ${escape(userInfo.mediaCount?.toLocaleString() || 'N/A')}
📅 *First Contact:* ${escape(userMapping.firstSeen?.toLocaleDateString() || new Date().toLocaleDateString())}
💬 *Message Count:* ${escape(userMapping.messageCount?.toString() || '0')}
🔗 *Thread ID:* ${escape(instagramThreadId)}

📝 *Biography:*
${escape(userInfo.biography || 'No biography available')}

💬 Messages from this contact will appear here`;
  }

  async sendInstagramMessageToTelegram(message, topicId, userInfo) {
    try {
      const chatId = this.telegramChatId;

      // Check if topic still exists
      const exists = await this.verifyTopicExists(topicId);
      if (!exists) {
        logger.warn(`🗑️ Topic ${topicId} seems deleted. Recreating...`);
        this.chatMappings.delete(message.chatID);
        this.profilePicCache.delete(message.chatID);
        await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': message.chatID });
        return;
      }

      if (message.type === 'text' && message.content) {
        await this.bot.sendMessage(chatId, message.content, {
          message_thread_id: topicId
        });
      } else if (message.type === 'media' || message.type === 'animated_media') {
        await this.handleInstagramMedia(message, topicId);
      } else if (message.type === 'voice_media') {
        await this.handleInstagramVoice(message, topicId);
      } else if (message.type === 'like') {
        await this.bot.sendMessage(chatId, '❤️', {
          message_thread_id: topicId
        });
      } else if (message.type === 'story_share') {
        await this.handleInstagramStoryShare(message, topicId);
      } else {
        // Handle other message types
        const fallbackText = `[${message.type.toUpperCase()}] ${message.content || 'Media message'}`;
        await this.bot.sendMessage(chatId, fallbackText, {
          message_thread_id: topicId
        });
      }

    } catch (error) {
      logger.error('❌ Failed to send Instagram message to Telegram:', error.message);
    }
  }

  async handleInstagramMedia(message, topicId) {
    try {
      const chatId = this.telegramChatId;
      const raw = message.data;

      if (raw.media?.image_versions2?.candidates?.[0]?.url) {
        // Photo
        await this.bot.sendPhoto(chatId, raw.media.image_versions2.candidates[0].url, {
          message_thread_id: topicId,
          caption: message.content || ''
        });
      } else if (raw.media?.video_versions?.[0]?.url) {
        // Video
        await this.bot.sendVideo(chatId, raw.media.video_versions[0].url, {
          message_thread_id: topicId,
          caption: message.content || ''
        });
      } else if (raw.animated_media?.images?.fixed_height?.url) {
        // Animated media (GIF/Sticker)
        if (raw.animated_media.is_sticker) {
          await this.bot.sendAnimation(chatId, raw.animated_media.images.fixed_height.url, {
            message_thread_id: topicId,
            caption: '🎭 Sticker'
          });
        } else {
          await this.bot.sendAnimation(chatId, raw.animated_media.images.fixed_height.url, {
            message_thread_id: topicId,
            caption: message.content || ''
          });
        }
      } else {
        // Fallback
        await this.bot.sendMessage(chatId, `[MEDIA] ${message.content || 'Media content'}`, {
          message_thread_id: topicId
        });
      }

    } catch (error) {
      logger.error('❌ Failed to handle Instagram media:', error.message);
    }
  }

  async handleInstagramVoice(message, topicId) {
    try {
      const chatId = this.telegramChatId;
      const raw = message.data;

      if (raw.voice_media?.media?.audio?.audio_src) {
        await this.bot.sendVoice(chatId, raw.voice_media.media.audio.audio_src, {
          message_thread_id: topicId,
          duration: raw.voice_media.media.audio.duration / 1000
        });
      } else {
        await this.bot.sendMessage(chatId, '[VOICE MESSAGE]', {
          message_thread_id: topicId
        });
      }

    } catch (error) {
      logger.error('❌ Failed to handle Instagram voice:', error.message);
    }
  }

  async handleInstagramStoryShare(message, topicId) {
    try {
      const chatId = this.telegramChatId;
      const raw = message.data;

      let storyText = '📖 Story Share';
      if (raw.story_share?.message) {
        storyText += `\n${raw.story_share.message}`;
      }

      if (raw.story_share?.media?.image_versions2?.candidates?.[0]?.url) {
        await this.bot.sendPhoto(chatId, raw.story_share.media.image_versions2.candidates[0].url, {
          message_thread_id: topicId,
          caption: storyText
        });
      } else {
        await this.bot.sendMessage(chatId, storyText, {
          message_thread_id: topicId
        });
      }

    } catch (error) {
      logger.error('❌ Failed to handle Instagram story share:', error.message);
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

      // Check filters
      const originalText = msg.text?.trim() || '';
      const textLower = originalText.toLowerCase();
      for (const word of this.filters) {
        if (textLower.startsWith(word)) {
          logger.info(`🛑 Blocked Telegram ➝ Instagram message due to filter "${word}": ${originalText}`);
          await this.setReaction(msg.chat.id, msg.message_id, '🚫');
          return;
        }
      }

      // Set processing reaction
      await this.setReaction(msg.chat.id, msg.message_id, '🔄');

      let success = false;

      if (msg.text) {
        success = await this.instagramClient.sendMessage(instagramThreadId, originalText);
      } else if (msg.photo) {
        success = await this.handleTelegramPhoto(msg, instagramThreadId);
      } else if (msg.video) {
        success = await this.handleTelegramVideo(msg, instagramThreadId);
      } else if (msg.voice) {
        success = await this.handleTelegramVoice(msg, instagramThreadId);
      } else if (msg.document) {
        success = await this.handleTelegramDocument(msg, instagramThreadId);
      } else if (msg.sticker) {
        success = await this.handleTelegramSticker(msg, instagramThreadId);
      } else if (msg.animation) {
        success = await this.handleTelegramAnimation(msg, instagramThreadId);
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

      // Use Attachment class for proper processing
      const attachment = new Attachment(buffer);
      await this.instagramClient.sendPhoto(instagramThreadId, attachment);
      
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

  async handleTelegramSticker(msg, instagramThreadId) {
    try {
      // Convert sticker to image and send
      const fileId = msg.sticker.file_id;
      const fileLink = await this.bot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      // Use Attachment class to convert WebP to JPEG
      const attachment = new Attachment(buffer);
      await this.instagramClient.sendPhoto(instagramThreadId, attachment);
      
      return true;
    } catch (error) {
      logger.error('❌ Failed to handle Telegram sticker:', error.message);
      // Fallback to text
      await this.instagramClient.sendMessage(instagramThreadId, '🎭 Sticker');
      return true;
    }
  }

  async handleTelegramAnimation(msg, instagramThreadId) {
    try {
      const fileId = msg.animation.file_id;
      const fileLink = await this.bot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      // Try to send as video first, fallback to photo
      try {
        await this.instagramClient.sendVideo(instagramThreadId, buffer);
      } catch (videoError) {
        const attachment = new Attachment(buffer);
        await this.instagramClient.sendPhoto(instagramThreadId, attachment);
      }
      
      if (msg.caption) {
        await this.instagramClient.sendMessage(instagramThreadId, msg.caption);
      }

      return true;
    } catch (error) {
      logger.error('❌ Failed to handle Telegram animation:', error.message);
      return false;
    }
  }

  async verifyTopicExists(topicId) {
    if (this.topicVerificationCache.has(topicId)) {
      return this.topicVerificationCache.get(topicId);
    }
    
    try {
      await this.bot.getChat(`${this.telegramChatId}/${topicId}`);
      this.topicVerificationCache.set(topicId, true);
      return true;
    } catch (error) {
      if (error.response?.body?.error_code === 400 || error.message?.includes('chat not found')) {
        this.topicVerificationCache.set(topicId, false);
        return false;
      }
      return true; // Assume it exists if unsure
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

  async saveChatMapping(instagramThreadId, telegramTopicId, profilePicUrl = null) {
    try {
      const updateData = {
        type: 'chat',
        data: {
          instagramThreadId,
          telegramTopicId,
          createdAt: new Date(),
          lastActivity: new Date()
        }
      };
      
      if (profilePicUrl) {
        updateData.data.profilePicUrl = profilePicUrl;
      }

      await this.collection.updateOne(
        { type: 'chat', 'data.instagramThreadId': instagramThreadId },
        { $set: updateData },
        { upsert: true }
      );

      this.chatMappings.set(instagramThreadId, telegramTopicId);
      if (profilePicUrl) {
        this.profilePicCache.set(instagramThreadId, profilePicUrl);
      }
      this.topicVerificationCache.delete(telegramTopicId);
    } catch (error) {
      logger.error('❌ Failed to save chat mapping:', error.message);
    }
  }

  async updateUserMapping(instagramUserId, userData) {
    try {
      const existingData = this.userMappings.get(instagramUserId) || {};
      const updatedData = { 
        ...existingData, 
        ...userData,
        firstSeen: existingData.firstSeen || new Date()
      };

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

  async handleNewFollower(user) {
    try {
      // Update user mapping
      await this.updateUserMapping(user.id, {
        username: user.username,
        fullName: user.fullName,
        profilePic: user.avatarURL,
        isNewFollower: true
      });

      // Emit event for other modules
      this.emit('newFollower', user);
      
      logger.info(`👤 New follower detected: @${user.username}`);
    } catch (error) {
      logger.error('❌ Error handling new follower:', error.message);
    }
  }

  async shutdown() {
    try {
      logger.info('🛑 Shutting down Telegram bridge...');
      
      if (this.bot) {
        await this.bot.stopPolling();
        logger.info('📱 Telegram bot polling stopped');
      }
      
      await fs.emptyDir(this.tempDir);
      logger.info('🧹 Temp directory cleaned');
      
      this.enabled = false;
      logger.info('✅ Telegram bridge shutdown complete');
    } catch (error) {
      logger.error('❌ Error during shutdown:', error.message);
    }
  }
}