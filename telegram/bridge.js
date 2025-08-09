// telegram/bridge.js
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import { connectDb } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

class TelegramBridge {
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
            });

            await this.setupTelegramHandlers();
            await this.loadMappingsFromDb();
            await this.loadFiltersFromDb();

            this.setupInstagramHandlers();

            this.enabled = true;
            logger.info('✅ Instagram-Telegram bridge initialized');
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
            await this.collection.createIndex({ type: 1, 'data.instagramThreadId': 1 }, { unique: true, partialFilterExpression: { type: 'chat' } });
            await this.collection.createIndex({ type: 1, 'data.instagramUserId': 1 }, { unique: true, partialFilterExpression: { type: 'user' } });
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
            logger.debug(`✅ Saved chat mapping: ${instagramThreadId} -> ${telegramTopicId}${profilePicUrl ? ' (with profile pic)' : ''}`);
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
            logger.debug(`ℹ️ Profile pic update for ${instagramId} (might be user, not chat):`, error.message);
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

    async getOrCreateTopic(instagramThreadId, senderUserId) {
        // ✅ If topic already cached, return
        if (this.chatMappings.has(instagramThreadId)) {
            return this.chatMappings.get(instagramThreadId);
        }

        // ✅ If another creation is in progress, wait for it
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
                let iconColor = 0x7ABA3C; // Default green

                // Try to get better name from user mapping
                const userInfo = this.userMappings.get(senderUserId?.toString());
                if (userInfo) {
                    topicName = `@${userInfo.username || userInfo.fullName || senderUserId}`;
                } else if (senderUserId) {
                    // Create basic user mapping if not exists
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
                    // Fetch profile picture for the user (sender of the message)
                    if (senderUserId) {
                       // Use the instagramBot's ig instance to fetch user info
                       const userInfo = await this.instagramBot.ig.user.info(senderUserId);
                       if (userInfo?.hd_profile_pic_url_info?.url) {
                            profilePicUrl = userInfo.hd_profile_pic_url_info.url;
                       } else if (userInfo?.profile_pic_url) {
                            profilePicUrl = userInfo.profile_pic_url; // Fallback
                       }
                       logger.debug(`📸 Fetched profile pic URL for user ${senderUserId}: ${profilePicUrl}`);
                    }
                } catch (picError) {
                    logger.debug(`📸 Could not fetch profile pic for user ${senderUserId}:`, picError.message);
                }

                await this.saveChatMapping(instagramThreadId, topic.message_thread_id, profilePicUrl);
                logger.info(`🆕 Created Telegram topic: "${topicName}" (ID: ${topic.message_thread_id}) for Instagram thread ${instagramThreadId}`);

                // Send welcome message and profile picture
                if (config.telegram?.features?.welcomeMessage !== false) {
                    await this.sendWelcomeMessage(topic.message_thread_id, instagramThreadId, senderUserId, profilePicUrl);
                }

                return topic.message_thread_id;
            } catch (error) {
                logger.error('❌ Failed to create Telegram topic:', error.message);
                return null;
            } finally {
                this.creatingTopics.delete(instagramThreadId); // ✅ Cleanup after done
            }
        })();

        this.creatingTopics.set(instagramThreadId, creationPromise);
        return await creationPromise;
    }

escapeMarkdownV2(text) {
  // List of characters that need escaping in MarkdownV2
  // _ and * are included but handled carefully
  const specialChars = ['[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let escapedText = text;

  // Escape special characters
  specialChars.forEach(char => {
    const regex = new RegExp(`\\${char}`, 'g');
    escapedText = escapedText.replace(regex, `\\${char}`);
  });

  // Handle underscores and asterisks: If they are used for formatting, they should be paired.
  // If they appear literally in data, they should be escaped.
  // A simple approach: escape all underscores and asterisks that are not already escaped.
  // This might not be perfect for all Markdown but prevents parsing errors.
  // More sophisticated parsing is possible but complex.
  escapedText = escapedText.replace(/(?<!\\)_/g, '\\_'); // Escape unescaped underscores
  escapedText = escapedText.replace(/(?<!\\)\*/g, '\\*'); // Escape unescaped asterisks

  return escapedText;
}


async sendWelcomeMessage(topicId, instagramThreadId, senderUserId, initialProfilePicUrl = null) {
    try {
        const chatId = config.telegram?.chatId;
        if (!chatId) {
            logger.error('❌ Telegram chat ID not configured for welcome message');
            return;
        }

        let topicName = `Instagram Chat ${instagramThreadId.substring(0, 10)}...`;
        let username = 'Unknown';
        let fullName = 'Unknown User';
        let userDisplayId = senderUserId ? senderUserId.toString() : 'N/A';

        // Try to get better name from user mapping
        const userInfo = this.userMappings.get(senderUserId?.toString());
        if (userInfo) {
            username = userInfo.username || 'No Username';
            fullName = userInfo.fullName || 'No Full Name';
        } else if (senderUserId) {
            // Basic fallback if mapping wasn't created yet
            username = `user_${senderUserId}`;
        }

        // --- Escape user data for Markdown ---
        const escapedUsername = this.escapeMarkdownV2(username);
        const escapedFullName = this.escapeMarkdownV2(fullName);
        const escapedUserDisplayId = this.escapeMarkdownV2(userDisplayId);
        const escapedInstagramThreadId = this.escapeMarkdownV2(instagramThreadId);
        // --- End escaping ---

        // --- Use MarkdownV2 and escaped data ---
        // Avoid using '_' for emphasis if the data itself might contain '_'
        // Use '*' for emphasis or ensure '_' is escaped within the text.
        let welcomeText = `👤 *Instagram Contact Information*
📝 *Username:* ${escapedUsername}
🆔 *User ID:* ${escapedUserDisplayId}
🏷️ *Full Name:* ${escapedFullName}
📅 *First Contact:* ${new Date().toLocaleDateString()}
💬 Messages from this user will appear here`;

        const sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
            message_thread_id: topicId,
            parse_mode: 'MarkdownV2' // Use MarkdownV2 and ensure escaping
        });
        await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);

        // Send initial profile picture if available
        if (initialProfilePicUrl) {
            await this.sendProfilePictureWithUrl(topicId, instagramThreadId, initialProfilePicUrl, false);
        }
        logger.info(`🎉 Welcome message sent successfully for thread ${instagramThreadId}`);
    } catch (error) {
        const errorMessage = error.response?.body?.description || error.message;
        logger.error(`❌ Failed to send welcome message for thread ${instagramThreadId}:`, errorMessage);
    }}

    async sendProfilePictureWithUrl(topicId, instagramThreadId, profilePicUrl, isUpdate = false) {
        try {
            if (!config.telegram?.features?.profilePicSync) {
                logger.debug(`📸 Profile pic sync disabled for thread ${instagramThreadId}`);
                return;
            }
            if (!profilePicUrl) {
                logger.debug(`📸 No profile picture URL provided for thread ${instagramThreadId}`);
                return;
            }
            const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
            await this.telegramBot.sendPhoto(this.telegramChatId, profilePicUrl, {
                message_thread_id: topicId,
                caption: caption
            });
            // Always update DB and cache to ensure consistency
            await this.updateProfilePicUrl(instagramThreadId, profilePicUrl);
            this.profilePicCache.set(instagramThreadId, profilePicUrl);
            logger.info(`📸 ✅ Sent ${isUpdate ? 'updated' : 'initial'} profile picture for thread ${instagramThreadId}`);
        } catch (error) {
            logger.error(`📸 ❌ Could not send profile picture with URL for thread ${instagramThreadId}:`, error.message);
        }
    }

    async verifyTopicExists(topicId) {
        // Simple cache to avoid too many API calls
        if (this.topicVerificationCache.has(topicId)) {
            return this.topicVerificationCache.get(topicId);
        }
        try {
            // getChat can be used to check if a topic exists
            await this.telegramBot.getChat(`${this.telegramChatId}/${topicId}`);
            this.topicVerificationCache.set(topicId, true);
            return true;
        } catch (error) {
            if (error.response?.body?.error_code === 400 || error.message?.includes('chat not found')) {
                this.topicVerificationCache.set(topicId, false);
                return false;
            }
            // Other errors might be temporary, don't cache
            logger.debug(`⚠️ Error verifying topic ${topicId}:`, error.message);
            return true; // Assume it exists if unsure
        }
    }
    // Instagram -> Telegram message forwarding
    async sendToTelegram(message) {
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

            // Handle different message types based on raw Instagram data
            await this.handleInstagramMessage(message, topicId);

        } catch (error) {
            logger.error('❌ Error forwarding message to Telegram:', error.message);
        }
    }

    async handleInstagramMessage(message, topicId) {
        try {
            const rawMessage = message.raw;
            
            // Handle text messages
            if (message.type === 'text' || rawMessage.item_type === 'text') {
                await this.sendSimpleMessage(topicId, message.text || '', message.threadId);
                return;
            }

            // Handle link messages
            if (rawMessage.item_type === 'link') {
                const linkText = rawMessage.link?.text || message.text || '';
                const linkUrl = rawMessage.link?.link_context?.link_url || '';
                const messageText = linkUrl ? `${linkText}\n🔗 ${linkUrl}` : linkText;
                await this.sendSimpleMessage(topicId, messageText, message.threadId);
                return;
            }

            // Handle media messages (photos)
            if (rawMessage.item_type === 'media' && rawMessage.media) {
                const media = rawMessage.media;
                let mediaUrl = null;
                
                // Get the best quality image
                if (media.image_versions2?.candidates?.length > 0) {
                    mediaUrl = media.image_versions2.candidates[0].url;
                } else if (media.carousel_media?.length > 0) {
                    // Handle carousel (multiple images)
                    for (const carouselItem of media.carousel_media) {
                        if (carouselItem.image_versions2?.candidates?.length > 0) {
                            const itemUrl = carouselItem.image_versions2.candidates[0].url;
                            await this.sendInstagramPhoto(topicId, itemUrl, message.text || '');
                        }
                    }
                    return;
                }

                if (mediaUrl) {
                    await this.sendInstagramPhoto(topicId, mediaUrl, message.text || '');
                }
                return;
            }

            // Handle video messages
            if (rawMessage.item_type === 'media' && rawMessage.media?.video_versions?.length > 0) {
                const videoUrl = rawMessage.media.video_versions[0].url;
                await this.sendInstagramVideo(topicId, videoUrl, message.text || '');
                return;
            }

            // Handle voice messages
            if (rawMessage.item_type === 'voice_media' && rawMessage.voice_media?.media?.audio) {
                const voiceUrl = rawMessage.voice_media.media.audio.audio_src;
                const duration = rawMessage.voice_media.media.audio.duration || 0;
                await this.sendInstagramVoice(topicId, voiceUrl, duration);
                return;
            }

            // Handle animated media (GIFs/stickers)
            if (rawMessage.item_type === 'animated_media' && rawMessage.animated_media) {
                const animatedMedia = rawMessage.animated_media;
                let mediaUrl = null;
                
                if (animatedMedia.images?.fixed_height?.url) {
                    mediaUrl = animatedMedia.images.fixed_height.url;
                } else if (animatedMedia.images?.fixed_width?.url) {
                    mediaUrl = animatedMedia.images.fixed_width.url;
                }

                if (mediaUrl) {
                    if (animatedMedia.is_sticker) {
                        await this.sendInstagramSticker(topicId, mediaUrl);
                    } else {
                        await this.sendInstagramAnimation(topicId, mediaUrl);
                    }
                }
                return;
            }

            // Handle story shares
            if (rawMessage.item_type === 'story_share' && rawMessage.story_share) {
                const storyShare = rawMessage.story_share;
                let storyText = storyShare.message || 'Shared a story';
                
                if (storyShare.media?.image_versions2?.candidates?.length > 0) {
                    const storyImageUrl = storyShare.media.image_versions2.candidates[0].url;
                    await this.sendInstagramPhoto(topicId, storyImageUrl, `📖 Story: ${storyText}`);
                } else {
                    await this.sendSimpleMessage(topicId, `📖 Story: ${storyText}`, message.threadId);
                }
                return;
            }

            // Handle likes
            if (rawMessage.item_type === 'like') {
                await this.sendSimpleMessage(topicId, '❤️ Liked your message', message.threadId);
                return;
            }

            // Handle reel shares
            if (rawMessage.item_type === 'reel_share' && rawMessage.reel_share) {
                const reelShare = rawMessage.reel_share;
                const reelText = reelShare.text || 'Shared a reel';
                
                if (reelShare.media?.video_versions?.length > 0) {
                    const reelVideoUrl = reelShare.media.video_versions[0].url;
                    await this.sendInstagramVideo(topicId, reelVideoUrl, `🎬 Reel: ${reelText}`);
                } else if (reelShare.media?.image_versions2?.candidates?.length > 0) {
                    const reelImageUrl = reelShare.media.image_versions2.candidates[0].url;
                    await this.sendInstagramPhoto(topicId, reelImageUrl, `🎬 Reel: ${reelText}`);
                } else {
                    await this.sendSimpleMessage(topicId, `🎬 Reel: ${reelText}`, message.threadId);
                }
                return;
            }

            // Fallback for unknown message types
            const fallbackText = `[${message.type || rawMessage.item_type || 'Unknown'}] ${message.text || 'Unsupported message type'}`;
            await this.sendSimpleMessage(topicId, fallbackText, message.threadId);

        } catch (error) {
            logger.error('❌ Error handling Instagram message:', error.message);
            await this.sendSimpleMessage(topicId, `[Error processing message: ${message.type}]`, message.threadId);
        }
    }

    async sendInstagramPhoto(topicId, photoUrl, caption = '') {
        try {
            await this.telegramBot.sendPhoto(this.telegramChatId, photoUrl, {
                message_thread_id: topicId,
                caption: caption || undefined
            });
            logger.debug(`📷 Sent Instagram photo to topic ${topicId}`);
        } catch (error) {
            logger.error(`❌ Failed to send Instagram photo:`, error.message);
            await this.sendSimpleMessage(topicId, `📷 [Photo] ${caption}`, null);
        }
    }

    async sendInstagramVideo(topicId, videoUrl, caption = '') {
        try {
            await this.telegramBot.sendVideo(this.telegramChatId, videoUrl, {
                message_thread_id: topicId,
                caption: caption || undefined
            });
            logger.debug(`🎥 Sent Instagram video to topic ${topicId}`);
        } catch (error) {
            logger.error(`❌ Failed to send Instagram video:`, error.message);
            await this.sendSimpleMessage(topicId, `🎥 [Video] ${caption}`, null);
        }
    }

    async sendInstagramVoice(topicId, voiceUrl, duration = 0) {
        try {
            // Download voice file and send as voice message
            const response = await axios.get(voiceUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            await this.telegramBot.sendVoice(this.telegramChatId, buffer, {
                message_thread_id: topicId,
                duration: duration
            });
            logger.debug(`🎤 Sent Instagram voice message to topic ${topicId}`);
        } catch (error) {
            logger.error(`❌ Failed to send Instagram voice:`, error.message);
            await this.sendSimpleMessage(topicId, `🎤 [Voice Message]`, null);
        }
    }

    async sendInstagramAnimation(topicId, animationUrl) {
        try {
            await this.telegramBot.sendAnimation(this.telegramChatId, animationUrl, {
                message_thread_id: topicId
            });
            logger.debug(`🎬 Sent Instagram animation to topic ${topicId}`);
        } catch (error) {
            logger.error(`❌ Failed to send Instagram animation:`, error.message);
            await this.sendSimpleMessage(topicId, `🎬 [Animation/GIF]`, null);
        }
    }

    async sendInstagramSticker(topicId, stickerUrl) {
        try {
            // Try to send as sticker, fallback to photo
            await this.telegramBot.sendPhoto(this.telegramChatId, stickerUrl, {
                message_thread_id: topicId,
                caption: '🎭 Sticker'
            });
            logger.debug(`🎭 Sent Instagram sticker to topic ${topicId}`);
        } catch (error) {
            logger.error(`❌ Failed to send Instagram sticker:`, error.message);
            await this.sendSimpleMessage(topicId, `🎭 [Sticker]`, null);
        }
    }

    async sendSimpleMessage(topicId, text, instagramThreadId) {
        try {
            if (instagramThreadId) {
                const exists = await this.verifyTopicExists(topicId);
                if (!exists) {
                    logger.warn(`🗑️ Topic ${topicId} for Instagram thread ${instagramThreadId} seems deleted. Recreating...`);
                    this.chatMappings.delete(instagramThreadId);
                    this.profilePicCache.delete(instagramThreadId);
                    await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
                    return null;
                }
            }

            const sentMessage = await this.telegramBot.sendMessage(this.telegramChatId, text, {
                message_thread_id: topicId
            });
            return sentMessage.message_id;
        } catch (error) {
            const desc = error.response?.body?.description || error.message;
            if (desc.includes('message thread not found') || desc.includes('Bad Request: group chat was deactivated')) {
                if (instagramThreadId) {
                    logger.warn(`🗑️ Topic ID ${topicId} for Instagram thread ${instagramThreadId} is missing. Marking for recreation.`);
                    this.chatMappings.delete(instagramThreadId);
                    this.profilePicCache.delete(instagramThreadId);
                    await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
                }
            } else {
                logger.error('❌ Failed to send message to Telegram:', desc);
            }
            return null;
        }
    }

    // Telegram -> Instagram handlers
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

            // Filter check
            const originalText = msg.text?.trim() || '';
            const textLower = originalText.toLowerCase();
            for (const word of this.filters) {
                if (textLower.startsWith(word)) {
                    logger.info(`🛑 Blocked Telegram ➝ Instagram message due to filter "${word}": ${originalText}`);
                    await this.setReaction(msg.chat.id, msg.message_id, '🚫');
                    return;
                }
            }

            // Handle different message types
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
            } else if (msg.video_note) {
                await this.handleTelegramMedia(msg, 'video_note', instagramThreadId);
            } else if (msg.audio) {
                await this.handleTelegramMedia(msg, 'audio', instagramThreadId);
            } else if (msg.sticker) {
                await this.handleTelegramMedia(msg, 'sticker', instagramThreadId);
            } else if (msg.animation) {
                await this.handleTelegramMedia(msg, 'animation', instagramThreadId);
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
                case 'video_note':
                    fileId = msg.video_note.file_id;
                    fileName = `video_note_${Date.now()}.mp4`;
                    break;
                case 'document':
                    fileId = msg.document.file_id;
                    fileName = msg.document.file_name || `document_${Date.now()}`;
                    break;
                case 'voice':
                    fileId = msg.voice.file_id;
                    fileName = `voice_${Date.now()}.ogg`;
                    break;
                case 'audio':
                    fileId = msg.audio.file_id;
                    fileName = `audio_${Date.now()}.mp3`;
                    break;
                case 'sticker':
                    fileId = msg.sticker.file_id;
                    fileName = `sticker_${Date.now()}.webp`;
                    break;
                case 'animation':
                    fileId = msg.animation.file_id;
                    fileName = `animation_${Date.now()}.gif`;
                    break;
                default:
                    throw new Error(`Unsupported media type: ${mediaType}`);
            }

            logger.info(`📥 Downloading ${mediaType} from Telegram: ${fileName}`);
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            // Save to temp file
            const tempFilePath = path.join(this.tempDir, fileName);
            await fs.writeFile(tempFilePath, buffer);

            let sendResult;
            switch (mediaType) {
                case 'photo':
                case 'sticker':  // Treat stickers as photos
                case 'animation': // Treat animations as photos for Instagram
                    sendResult = await this.instagramBot.sendPhoto(instagramThreadId, tempFilePath, caption);
                    break;
                case 'video':
                case 'video_note':
                    sendResult = await this.instagramBot.sendVideo(instagramThreadId, tempFilePath, caption);
                    break;
                case 'voice':
                    // Instagram supports voice messages
                    sendResult = await this.instagramBot.sendVoice(instagramThreadId, tempFilePath);
                    break;
                case 'audio':
                    // Instagram doesn't support audio files directly, send description instead
                    const audioInfo = `🎵 Audio: ${msg.audio?.title || 'Audio File'} ${caption ? `\n${caption}` : ''}`;
                    sendResult = await this.instagramBot.sendMessage(instagramThreadId, audioInfo);
                    break;
                case 'document':
                    // Send document info as text since Instagram doesn't support file uploads in DMs
                    const docInfo = `📎 Document: ${msg.document.file_name || 'File'} (${(msg.document.file_size / 1024).toFixed(2)} KB)${caption ? `\n${caption}` : ''}`;
                    sendResult = await this.instagramBot.sendMessage(instagramThreadId, docInfo);
                    break;
                default:
                    throw new Error(`Send logic not implemented for: ${mediaType}`);
            }

            // Clean up temp file
            try {
                await fs.unlink(tempFilePath);
            } catch (cleanupError) {
                logger.debug('Could not clean up temp file:', cleanupError.message);
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
            
            // Send error message to Telegram as fallback
            try {
                const errorMsg = `❌ Failed to send ${mediaType} to Instagram: ${error.message}`;
                await this.telegramBot.sendMessage(this.telegramChatId, errorMsg, {
                    message_thread_id: msg.message_thread_id,
                    reply_to_message_id: msg.message_id
                });
            } catch (errorSendFail) {
                logger.error('❌ Failed to send error message back to Telegram:', errorSendFail.message);
            }
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
        if (!this.instagramBot || !this.instagramBot.ig) {
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

export { TelegramBridge };
