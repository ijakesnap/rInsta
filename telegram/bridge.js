import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import mime from 'mime-types';
import { connectDb } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export class TelegramBridge {
  constructor() {
    this.instagramBot = null;
    this.telegramBot = null;
    this.chatMappings = new Map();
    this.userMappings = new Map();
    this.profilePicCache = new Map();
    this.tempDir = path.join(process.cwd(), 'temp');
    this.db = null;
    this.collection = null;
    this.telegramChatId = null;
    this.creatingTopics = new Map();
    this.topicVerificationCache = new Map();
    this.enabled = false;
    this.filters = new Set();
  }

  async initialize(instagramBotInstance) {
    this.instagramBot = instagramBotInstance;

    const token = config.telegram?.botToken;
    this.telegramChatId = config.telegram?.chatId;

    if (!token || token.includes('YOUR_BOT_TOKEN') || !this.telegramChatId || this.telegramChatId.includes('YOUR_CHAT_ID')) {
      logger.warn('⚠️ Telegram bot token or chat ID not configured for Instagram bridge');
      return;
    }

    try {
      await this.initializeDatabase();
      await fs.ensureDir(this.tempDir);
      
      this.telegramBot = new TelegramBot(token, {
        polling: true,
        onlyFirstMatch: true
      });

      await this.setupTelegramHandlers();
      await this.loadMappingsFromDb();
      await this.loadFiltersFromDb();

      this.setupInstagramHandlers();

      this.enabled = true;
      logger.info('✅ Instagram-Telegram bridge initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize Instagram-Telegram bridge:', error.message);
      this.enabled = false;
    }
  }

  async initializeDatabase() {
    try {
      this.db = await connectDb();
      await this.db.command({ ping: 1 });
      logger.info('✅ MongoDB connection successful for Instagram bridge');
      
      this.collection = this.db.collection('bridge');
      
      await this.collection.createIndex(
        { type: 1, 'data.instagramThreadId': 1 }, 
        { unique: true, partialFilterExpression: { type: 'chat' } }
      );
      await this.collection.createIndex(
        { type: 1, 'data.instagramUserId': 1 }, 
        { unique: true, partialFilterExpression: { type: 'user' } }
      );
      
      logger.info('📊 Database initialized for Instagram bridge');
    } catch (error) {
      logger.error('❌ Failed to initialize database for Instagram bridge:', error.message);
      throw error;
    }
  }

  async loadMappingsFromDb() {
    if (!this.collection) {
      logger.warn('⚠️ Database collection not available, skipping mapping load');
      return;
    }
    
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
              firstSeen: mapping.data.firstSeen,
              messageCount: mapping.data.messageCount || 0
            });
            break;
        }
      }
      
      logger.info(`📊 Loaded Instagram mappings: ${this.chatMappings.size} chats, ${this.userMappings.size} users`);
    } catch (error) {
      logger.error('❌ Failed to load Instagram mappings:', error.message);
    }
  }

  async saveChatMapping(instagramThreadId, telegramTopicId, profilePicUrl = null) {
    if (!this.collection) return;
    
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
      
      this.topicVerificationCache.delete(instagramThreadId);
      logger.debug(`✅ Saved chat mapping: ${instagramThreadId} -> ${telegramTopicId}`);
    } catch (error) {
      logger.error('❌ Failed to save Instagram chat mapping:', error.message);
    }
  }

  async saveUserMapping(instagramUserId, userData) {
    if (!this.collection) return;
    
    try {
      await this.collection.updateOne(
        { type: 'user', 'data.instagramUserId': instagramUserId },
        {
          $set: {
            type: 'user',
            data: {
              instagramUserId,
              username: userData.username,
              fullName: userData.fullName,
              firstSeen: userData.firstSeen,
              messageCount: userData.messageCount || 0,
              lastSeen: new Date()
            }
          }
        },
        { upsert: true }
      );
      
      this.userMappings.set(instagramUserId, userData);
      logger.debug(`✅ Saved Instagram user mapping: ${instagramUserId} (@${userData.username || 'unknown'})`);
    } catch (error) {
      logger.error('❌ Failed to save Instagram user mapping:', error.message);
    }
  }

  async loadFiltersFromDb() {
    this.filters = new Set();
    if (!this.collection) return;
    
    try {
      const filterDocs = await this.collection.find({ type: 'filter' }).toArray();
      for (const doc of filterDocs) {
        this.filters.add(doc.word);
      }
      logger.info(`✅ Loaded ${this.filters.size} filters from DB`);
    } catch (error) {
      logger.error('❌ Failed to load filters:', error.message);
    }
  }

  // Topic Management
  async getOrCreateTopic(instagramThreadId, senderUserId) {
    if (this.chatMappings.has(instagramThreadId)) {
      return this.chatMappings.get(instagramThreadId);
    }

    if (this.creatingTopics.has(instagramThreadId)) {
      logger.debug(`⏳ Topic creation for ${instagramThreadId} already in progress, waiting...`);
      return await this.creatingTopics.get(instagramThreadId);
    }

    const creationPromise = (async () => {
      if (!this.telegramChatId) {
        logger.error('❌ Telegram chat ID not configured');
        return null;
      }

      try {
        let topicName = `Instagram Chat ${instagramThreadId.substring(0, 10)}...`;
        let iconColor = 0x7ABA3C;

        const userInfo = this.userMappings.get(senderUserId?.toString());
        if (userInfo) {
          topicName = `@${userInfo.username || userInfo.fullName || senderUserId}`;
        } else if (senderUserId) {
          topicName = `User ${senderUserId}`;
          await this.saveUserMapping(senderUserId.toString(), {
            username: null,
            fullName: null,
            firstSeen: new Date(),
            messageCount: 0
          });
        }

        const topic = await this.telegramBot.createForumTopic(this.telegramChatId, topicName, {
          icon_color: iconColor
        });

        let profilePicUrl = null;
        try {
          if (senderUserId) {
            const userInfo = await this.instagramBot.getUserInfo(senderUserId);
            if (userInfo?.hd_profile_pic_url_info?.url) {
              profilePicUrl = userInfo.hd_profile_pic_url_info.url;
            } else if (userInfo?.profile_pic_url) {
              profilePicUrl = userInfo.profile_pic_url;
            }
            logger.debug(`📸 Fetched profile pic URL for user ${senderUserId}: ${profilePicUrl}`);
          }
        } catch (picError) {
          logger.debug(`📸 Could not fetch profile pic for user ${senderUserId}:`, picError.message);
        }

        await this.saveChatMapping(instagramThreadId, topic.message_thread_id, profilePicUrl);
        logger.info(`🆕 Created Telegram topic: "${topicName}" (ID: ${topic.message_thread_id}) for Instagram thread ${instagramThreadId}`);

        await this.sendWelcomeMessage(topic.message_thread_id, instagramThreadId, senderUserId, profilePicUrl);

        return topic.message_thread_id;
      } catch (error) {
        logger.error('❌ Failed to create Telegram topic:', error.message);
        return null;
      } finally {
        this.creatingTopics.delete(instagramThreadId);
      }
    })();

    this.creatingTopics.set(instagramThreadId, creationPromise);
    return await creationPromise;
  }

  escapeMarkdownV2(text) {
    const specialChars = ['[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    let escapedText = text;

    specialChars.forEach(char => {
      const regex = new RegExp(`\\${char}`, 'g');
      escapedText = escapedText.replace(regex, `\\${char}`);
    });

    escapedText = escapedText.replace(/(?<!\\)_/g, '\\_');
    escapedText = escapedText.replace(/(?<!\\)\*/g, '\\*');

    return escapedText;
  }

  async sendWelcomeMessage(topicId, instagramThreadId, senderUserId, initialProfilePicUrl = null) {
    try {
      const chatId = config.telegram?.chatId;
      if (!chatId) {
        logger.error('❌ Telegram chat ID not configured for welcome message');
        return;
      }

      let username = 'Unknown';
      let fullName = 'Unknown User';
      let userDisplayId = senderUserId ? senderUserId.toString() : 'N/A';

      const userInfo = this.userMappings.get(senderUserId?.toString());
      if (userInfo) {
        username = userInfo.username || 'No Username';
        fullName = userInfo.fullName || 'No Full Name';
      } else if (senderUserId) {
        username = `user_${senderUserId}`;
      }

      const escapedUsername = this.escapeMarkdownV2(username);
      const escapedFullName = this.escapeMarkdownV2(fullName);
      const escapedUserDisplayId = this.escapeMarkdownV2(userDisplayId);

      let welcomeText = `👤 *Instagram Contact Information*
📝 *Username:* ${escapedUsername}
🆔 *User ID:* ${escapedUserDisplayId}
🏷️ *Full Name:* ${escapedFullName}
📅 *First Contact:* ${new Date().toLocaleDateString()}
💬 Messages from this user will appear here`;

      const sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
        message_thread_id: topicId,
        parse_mode: 'MarkdownV2'
      });
      
      await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);

      if (initialProfilePicUrl) {
        await this.sendProfilePictureWithUrl(topicId, instagramThreadId, initialProfilePicUrl, false);
      }
      
      logger.info(`🎉 Welcome message sent successfully for thread ${instagramThreadId}`);
    } catch (error) {
      const errorMessage = error.response?.body?.description || error.message;
      logger.error(`❌ Failed to send welcome message for thread ${instagramThreadId}:`, errorMessage);
    }
  }

  async sendProfilePictureWithUrl(topicId, instagramThreadId, profilePicUrl, isUpdate = false) {
    try {
      if (!profilePicUrl) {
        logger.debug(`📸 No profile picture URL provided for thread ${instagramThreadId}`);
        return;
      }
      
      const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
      await this.telegramBot.sendPhoto(this.telegramChatId, profilePicUrl, {
        message_thread_id: topicId,
        caption: caption
      });
      
      await this.updateProfilePicUrl(instagramThreadId, profilePicUrl);
      this.profilePicCache.set(instagramThreadId, profilePicUrl);
      
      logger.info(`📸 ✅ Sent ${isUpdate ? 'updated' : 'initial'} profile picture for thread ${instagramThreadId}`);
    } catch (error) {
      logger.error(`📸 ❌ Could not send profile picture with URL for thread ${instagramThreadId}:`, error.message);
    }
  }

  async updateProfilePicUrl(instagramId, profilePicUrl) {
    if (!this.collection) return;
    
    try {
      await this.collection.updateOne(
        { type: 'chat', 'data.instagramThreadId': instagramId },
        { $set: { 'data.profilePicUrl': profilePicUrl, 'data.lastProfilePicUpdate': new Date() } }
      );
      
      this.profilePicCache.set(instagramId, profilePicUrl);
      logger.debug(`✅ Updated profile pic URL for ${instagramId}: ${profilePicUrl}`);
    } catch (error) {
      logger.debug(`ℹ️ Profile pic update for ${instagramId}:`, error.message);
    }
  }

  // Message Forwarding - Instagram to Telegram
  async handleInstagramMessage(message) {
    if (!this.telegramBot || !this.enabled) return;

    try {
      const instagramThreadId = message.threadId;
      const senderUserId = message.senderId;

      // Ensure user mapping exists
      if (!this.userMappings.has(senderUserId.toString())) {
        await this.saveUserMapping(senderUserId.toString(), {
          username: message.senderUsername,
          fullName: null,
          firstSeen: new Date(),
          messageCount: 0
        });
      } else {
        const userData = this.userMappings.get(senderUserId.toString());
        userData.messageCount = (userData.messageCount || 0) + 1;
        userData.lastSeen = new Date();
        await this.saveUserMapping(senderUserId.toString(), userData);
      }

      const topicId = await this.getOrCreateTopic(instagramThreadId, senderUserId);
      if (!topicId) {
        logger.error(`❌ Could not get/create Telegram topic for Instagram thread ${instagramThreadId}`);
        return;
      }

      // Check filters
      const textLower = (message.text || '').toLowerCase().trim();
      for (const word of this.filters) {
        if (textLower.startsWith(word)) {
          logger.info(`🛑 Blocked Instagram ➝ Telegram message due to filter "${word}": ${message.text}`);
          return;
        }
      }

      // Handle different message types
      if (message.type === 'text' || message.type === 'link') {
        await this.sendSimpleMessage(topicId, message.text || '', instagramThreadId);
      } else if (message.mediaData?.hasMedia) {
        await this.handleInstagramMedia(message, topicId);
      } else if (message.type === 'like') {
        await this.sendSimpleMessage(topicId, '❤️', instagramThreadId);
      } else {
        let fallbackText = `[${message.type.toUpperCase()}]`;
        if (message.text) {
          fallbackText += `\n${message.text}`;
        }
        await this.sendSimpleMessage(topicId, fallbackText, instagramThreadId);
      }

    } catch (error) {
      logger.error('❌ Error forwarding Instagram message to Telegram:', error.message);
    }
  }

  async handleInstagramMedia(message, topicId) {
    try {
      const mediaData = message.mediaData;
      
      if (!mediaData.mediaUrl) {
        await this.sendSimpleMessage(topicId, `[${mediaData.mediaType?.toUpperCase() || 'MEDIA'}]`, message.threadId);
        return;
      }

      const caption = message.text || '';

      switch (mediaData.mediaType) {
        case 'photo':
          await this.telegramBot.sendPhoto(this.telegramChatId, mediaData.mediaUrl, {
            message_thread_id: topicId,
            caption: caption
          });
          break;
          
        case 'video':
          await this.telegramBot.sendVideo(this.telegramChatId, mediaData.mediaUrl, {
            message_thread_id: topicId,
            caption: caption,
            thumb: mediaData.thumbnailUrl
          });
          break;
          
        case 'voice':
          // Download and send as voice
          const voiceResponse = await axios.get(mediaData.mediaUrl, { responseType: 'arraybuffer' });
          const voiceBuffer = Buffer.from(voiceResponse.data);
          
          await this.telegramBot.sendVoice(this.telegramChatId, voiceBuffer, {
            message_thread_id: topicId,
            duration: mediaData.duration
          });
          break;
          
        case 'gif':
          await this.telegramBot.sendAnimation(this.telegramChatId, mediaData.mediaUrl, {
            message_thread_id: topicId,
            caption: caption
          });
          break;
          
        default:
          await this.sendSimpleMessage(topicId, `[${mediaData.mediaType?.toUpperCase() || 'MEDIA'}] ${caption}`, message.threadId);
      }

      logger.info(`📤 Sent ${mediaData.mediaType} from Instagram to Telegram topic ${topicId}`);
    } catch (error) {
      logger.error(`❌ Error handling Instagram media:`, error.message);
      await this.sendSimpleMessage(topicId, `[Media: ${message.type}] ${message.text || 'No caption'}`, message.threadId);
    }
  }

  async sendSimpleMessage(topicId, text, instagramThreadId) {
    try {
      const exists = await this.verifyTopicExists(topicId);
      if (!exists) {
        logger.warn(`🗑️ Topic ${topicId} for Instagram thread ${instagramThreadId} seems deleted. Recreating...`);
        this.chatMappings.delete(instagramThreadId);
        this.profilePicCache.delete(instagramThreadId);
        await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
        return null;
      }

      const sentMessage = await this.telegramBot.sendMessage(this.telegramChatId, text, {
        message_thread_id: topicId
      });
      
      return sentMessage.message_id;
    } catch (error) {
      const desc = error.response?.body?.description || error.message;
      if (desc.includes('message thread not found') || desc.includes('Bad Request: group chat was deactivated')) {
        logger.warn(`🗑️ Topic ID ${topicId} for Instagram thread ${instagramThreadId} is missing. Marking for recreation.`);
        this.chatMappings.delete(instagramThreadId);
        this.profilePicCache.delete(instagramThreadId);
        await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
      } else {
        logger.error('❌ Failed to send message to Telegram:', desc);
      }
      return null;
    }
  }

  async verifyTopicExists(topicId) {
    if (this.topicVerificationCache.has(topicId)) {
      return this.topicVerificationCache.get(topicId);
    }
    
    try {
      await this.telegramBot.getChat(`${this.telegramChatId}/${topicId}`);
      this.topicVerificationCache.set(topicId, true);
      return true;
    } catch (error) {
      if (error.response?.body?.error_code === 400 || error.message?.includes('chat not found')) {
        this.topicVerificationCache.set(topicId, false);
        return false;
      }
      logger.debug(`⚠️ Error verifying topic ${topicId}:`, error.message);
      return true;
    }
  }

  // Telegram Handlers
  async setupTelegramHandlers() {
    if (!this.telegramBot) return;

    this.telegramBot.on('message', this.wrapHandler(async (msg) => {
      if (
        (msg.chat.type === 'supergroup' || msg.chat.type === 'group') &&
        msg.is_topic_message &&
        msg.message_thread_id
      ) {
        await this.handleTelegramMessage(msg);
      } else if (msg.chat.type === 'private') {
        logger.info(`📩 Received private message from Telegram user ${msg.from.id}: ${msg.text}`);
      }
    }));

    this.telegramBot.on('polling_error', (error) => {
      logger.error('Instagram-Telegram polling error:', error.message);
    });

    this.telegramBot.on('error', (error) => {
      logger.error('Instagram-Telegram bot error:', error.message);
    });

    logger.info('📱 Instagram-Telegram message handlers set up');
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

  async handleTelegramMessage(msg) {
    try {
      const topicId = msg.message_thread_id;
      const instagramThreadId = this.findInstagramThreadIdByTopic(topicId);

      if (!instagramThreadId) {
        logger.warn('⚠️ Could not find Instagram thread for Telegram message');
        await this.setReaction(msg.chat.id, msg.message_id, '❓');
        return;
      }

      const originalText = msg.text?.trim() || '';
      const textLower = originalText.toLowerCase();
      
      // Filter check
      for (const word of this.filters) {
        if (textLower.startsWith(word)) {
          logger.info(`🛑 Blocked Telegram ➝ Instagram message due to filter "${word}": ${originalText}`);
          await this.setReaction(msg.chat.id, msg.message_id, '🚫');
          return;
        }
      }

      if (msg.text) {
        const sendResult = await this.instagramBot.sendMessage(instagramThreadId, originalText);
        if (sendResult) {
          await this.setReaction(msg.chat.id, msg.message_id, '👍');
        } else {
          throw new Error('Instagram send failed');
        }
      } else if (msg.photo) {
        await this.handleTelegramMedia(msg, 'photo', instagramThreadId);
      } else if (msg.video) {
        await this.handleTelegramMedia(msg, 'video', instagramThreadId);
      } else if (msg.document) {
        await this.handleTelegramMedia(msg, 'document', instagramThreadId);
      } else if (msg.voice) {
        await this.handleTelegramMedia(msg, 'voice', instagramThreadId);
      } else if (msg.sticker) {
        await this.handleTelegramMedia(msg, 'sticker', instagramThreadId);
      } else {
        logger.warn(`⚠️ Unsupported Telegram media type received in topic ${topicId}`);
        const fallbackText = "[Unsupported Telegram Media Received]";
        const sendResult = await this.instagramBot.sendMessage(instagramThreadId, fallbackText);
        if (sendResult) {
          await this.setReaction(msg.chat.id, msg.message_id, '👍');
        } else {
          await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
      }

    } catch (error) {
      logger.error('❌ Failed to handle Telegram message:', error.message);
      await this.setReaction(msg.chat.id, msg.message_id, '❌');
    }
  }

  async handleTelegramMedia(msg, mediaType, instagramThreadId) {
    try {
      await this.setReaction(msg.chat.id, msg.message_id, '🔄');

      let fileId, fileName, caption = msg.caption || '';

      switch (mediaType) {
        case 'photo':
          fileId = msg.photo[msg.photo.length - 1].file_id;
          fileName = `photo_${Date.now()}.jpg`;
          break;
        case 'video':
          fileId = msg.video.file_id;
          fileName = `video_${Date.now()}.mp4`;
          break;
        case 'document':
          fileId = msg.document.file_id;
          fileName = msg.document.file_name || `document_${Date.now()}`;
          break;
        case 'voice':
          fileId = msg.voice.file_id;
          fileName = `voice_${Date.now()}.ogg`;
          break;
        case 'sticker':
          fileId = msg.sticker.file_id;
          fileName = `sticker_${Date.now()}.webp`;
          break;
        default:
          throw new Error(`Unsupported media type for sending to Instagram: ${mediaType}`);
      }

      logger.info(`📥 Downloading ${mediaType} from Telegram: ${fileName}`);
      const fileLink = await this.telegramBot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      let sendResult;
      switch (mediaType) {
        case 'photo':
          sendResult = await this.instagramBot.sendPhoto(instagramThreadId, buffer, caption);
          break;
          
        case 'video':
          sendResult = await this.instagramBot.sendVideo(instagramThreadId, buffer, caption);
          break;
          
        case 'document':
          const fileInfo = `📎 Document: ${msg.document.file_name || 'Unnamed File'} (${(msg.document.file_size / 1024).toFixed(2)} KB)`;
          sendResult = await this.instagramBot.sendMessage(instagramThreadId, `${fileInfo}\n${caption}`);
          break;
          
        case 'voice':
          sendResult = await this.instagramBot.sendVoice(instagramThreadId, buffer);
          if (caption) {
            await this.instagramBot.sendMessage(instagramThreadId, caption);
          }
          break;
          
        case 'sticker':
          logger.warn("Sticker sending to Instagram not implemented. Requires .webp conversion.");
          sendResult = await this.instagramBot.sendMessage(instagramThreadId, "[Sticker Received - Conversion Needed]");
          break;
          
        default:
          throw new Error(`Send logic not implemented for media type: ${mediaType}`);
      }

      if (sendResult) {
        logger.info(`✅ Successfully sent ${mediaType} to Instagram thread ${instagramThreadId}`);
        await this.setReaction(msg.chat.id, msg.message_id, '👍');
      } else {
        throw new Error(`Instagram send failed for ${mediaType}`);
      }
    } catch (error) {
      logger.error(`❌ Failed to handle/send Telegram ${mediaType} to Instagram:`, error.message);
      await this.setReaction(msg.chat.id, msg.message_id, '❌');
    }
  }

  async setReaction(chatId, messageId, emoji) {
    try {
      const token = config.telegram?.botToken;
      if (!token) return;
      
      await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: emoji }]
      });
    } catch (err) {
      logger.debug('❌ Failed to set reaction:', err?.response?.data?.description || err.message);
    }
  }

  findInstagramThreadIdByTopic(topicId) {
    for (const [threadId, topic] of this.chatMappings.entries()) {
      if (topic === topicId) {
        return threadId;
      }
    }
    return null;
  }

  setupInstagramHandlers() {
    if (!this.instagramBot) {
      logger.warn('⚠️ Instagram bot instance not linked, cannot set up Instagram handlers');
      return;
    }

    logger.info('📱 Instagram event handlers set up for Telegram bridge');
  }

  async shutdown() {
    logger.info('🛑 Shutting down Instagram-Telegram bridge...');
    
    if (this.telegramBot) {
      try {
        await this.telegramBot.stopPolling();
        logger.info('📱 Instagram-Telegram bot polling stopped.');
      } catch (error) {
        logger.debug('Error stopping Telegram polling:', error.message);
      }
    }
    
    try {
      await fs.emptyDir(this.tempDir);
      logger.info('🧹 Temp directory cleaned.');
    } catch (error) {
      logger.debug('Could not clean temp directory:', error.message);
    }
    
    logger.info('✅ Instagram-Telegram bridge shutdown complete.');
  }
}