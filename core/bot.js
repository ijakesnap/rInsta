import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export class InstagramBot {
  constructor() {
    this.ig = withRealtime(new IgApiClient());
    this.messageHandlers = [];
    this.isRunning = false;
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
    this.currentUser = null;
    this.eventEmitter = null;
  }

  setEventEmitter(emitter) {
    this.eventEmitter = emitter;
  }

  emit(event, ...args) {
    if (this.eventEmitter) {
      this.eventEmitter.emit(event, ...args);
    }
  }

  async login() {
    try {
      const username = config.instagram?.username;
      if (!username) {
        throw new Error('❌ INSTAGRAM_USERNAME is missing');
      }

      this.ig.state.generateDevice(username);
      let loginSuccess = false;

      // Try session.json first
      try {
        await fs.access('./session.json');
        logger.info('📂 Found session.json, attempting login...');
        const sessionData = JSON.parse(await fs.readFile('./session.json', 'utf-8'));
        await this.ig.state.deserialize(sessionData);
        
        this.currentUser = await this.ig.account.currentUser();
        logger.info(`✅ Logged in from session as @${this.currentUser.username}`);
        loginSuccess = true;
      } catch (sessionError) {
        logger.info('📂 Session login failed, trying cookies...');
      }

      // Fallback to cookies.json
      if (!loginSuccess) {
        try {
          await this.loadCookiesFromJson('./cookies.json');
          this.currentUser = await this.ig.account.currentUser();
          logger.info(`✅ Logged in with cookies as @${this.currentUser.username}`);
          
          // Save session after successful cookie login
          const session = await this.ig.state.serialize();
          delete session.constants;
          await fs.writeFile('./session.json', JSON.stringify(session, null, 2));
          logger.info('💾 Session saved from cookie login');
          loginSuccess = true;
        } catch (cookieError) {
          throw new Error(`Cookie login failed: ${cookieError.message}`);
        }
      }

      if (loginSuccess) {
        await this.setupRealtimeConnection();
        this.isRunning = true;
        logger.info('🚀 Instagram bot is now running');
      }

    } catch (error) {
      logger.error('❌ Failed to initialize bot:', error.message);
      throw error;
    }
  }

  async loadCookiesFromJson(path = './cookies.json') {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const cookies = JSON.parse(raw);

      for (const cookie of cookies) {
        const toughCookie = new tough.Cookie({
          key: cookie.name,
          value: cookie.value,
          domain: cookie.domain.replace(/^\./, ''),
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly !== false,
        });

        await this.ig.state.cookieJar.setCookie(
          toughCookie.toString(),
          `https://${toughCookie.domain}${toughCookie.path}`
        );
      }

      logger.info(`🍪 Successfully loaded ${cookies.length} cookies`);
    } catch (error) {
      logger.error(`❌ Error loading cookies:`, error.message);
      throw error;
    }
  }

  async setupRealtimeConnection() {
    this.registerRealtimeHandlers();

    await this.ig.realtime.connect({
      graphQlSubs: [
        GraphQLSubscriptions.getAppPresenceSubscription(),
        GraphQLSubscriptions.getZeroProvisionSubscription(this.ig.state.phoneId),
        GraphQLSubscriptions.getDirectStatusSubscription(),
        GraphQLSubscriptions.getDirectTypingSubscription(this.ig.state.cookieUserId),
        GraphQLSubscriptions.getAsyncAdSubscription(this.ig.state.cookieUserId),
      ],
      skywalkerSubs: [
        SkywalkerSubscriptions.directSub(this.ig.state.cookieUserId),
        SkywalkerSubscriptions.liveSub(this.ig.state.cookieUserId),
      ],
      irisData: await this.ig.feed.directInbox().request(),
    });
  }

  registerRealtimeHandlers() {
    logger.info('📡 Registering real-time event handlers...');

    // Main message handler
    this.ig.realtime.on('message', async (data) => {
      try {
        if (!data.message || !this.isNewMessageById(data.message.item_id)) {
          return;
        }

        await this.handleMessage(data.message, data);
      } catch (err) {
        logger.error('❌ Error in message handler:', err.message);
      }
    });

    // Direct message handler
    this.ig.realtime.on('direct', async (data) => {
      try {
        if (data.message && this.isNewMessageById(data.message.item_id)) {
          await this.handleMessage(data.message, data);
        }
      } catch (err) {
        logger.error('❌ Error in direct handler:', err.message);
      }
    });

    // Connection events
    this.ig.realtime.on('connect', () => {
      logger.info('🔗 Realtime connection established');
      this.isRunning = true;
    });

    this.ig.realtime.on('close', () => {
      logger.warn('🔌 Realtime connection closed');
      this.isRunning = false;
    });

    this.ig.realtime.on('error', (err) => {
      logger.error('🚨 Realtime connection error:', err.message);
    });
  }

  isNewMessageById(messageId) {
    if (!messageId || this.processedMessageIds.has(messageId)) {
      return false;
    }

    this.processedMessageIds.add(messageId);

    if (this.processedMessageIds.size > this.maxProcessedMessageIds) {
      const first = this.processedMessageIds.values().next().value;
      if (first !== undefined) {
        this.processedMessageIds.delete(first);
      }
    }

    return true;
  }

  async handleMessage(message, eventData) {
    try {
      if (!message || !message.user_id || !message.item_id) {
        return;
      }

      // Get sender info
      let senderInfo = null;
      if (eventData.thread?.users) {
        senderInfo = eventData.thread.users.find(u => u.pk?.toString() === message.user_id?.toString());
      }

      // If no sender info from thread, fetch it
      if (!senderInfo) {
        try {
          senderInfo = await this.ig.user.info(message.user_id);
        } catch (error) {
          logger.warn(`Could not fetch user info for ${message.user_id}`);
          senderInfo = { pk: message.user_id, username: `user_${message.user_id}` };
        }
      }

      const processedMessage = {
        id: message.item_id,
        text: message.text || '',
        senderId: message.user_id,
        senderUsername: senderInfo.username,
        senderFullName: senderInfo.full_name,
        senderProfilePic: senderInfo.profile_pic_url || senderInfo.hd_profile_pic_url_info?.url,
        timestamp: new Date(parseInt(message.timestamp, 10) / 1000),
        threadId: eventData.thread?.thread_id || message.thread_id,
        threadTitle: eventData.thread?.thread_title || 'Direct Message',
        type: message.item_type || 'text',
        raw: message,
        thread: eventData.thread
      };

      logger.info(`💬 [${processedMessage.threadTitle}] @${processedMessage.senderUsername}: "${processedMessage.text}"`);

      // Execute message handlers
      for (const handler of this.messageHandlers) {
        try {
          await handler(processedMessage);
        } catch (handlerError) {
          logger.error(`❌ Error in message handler:`, handlerError.message);
        }
      }

      // Emit events for modules
      this.emit('message', processedMessage);
      this.emit('userActivity', {
        userId: processedMessage.senderId,
        username: processedMessage.senderUsername,
        activity: 'message',
        timestamp: processedMessage.timestamp
      });

    } catch (error) {
      logger.error('❌ Critical error handling message:', error.message);
    }
  }

  onMessage(handler) {
    if (typeof handler === 'function') {
      this.messageHandlers.push(handler);
      logger.info(`📝 Added message handler (total: ${this.messageHandlers.length})`);
    }
  }

  async sendMessage(threadId, text) {
    if (!threadId || !text) {
      throw new Error('Thread ID and text are required');
    }

    try {
      await this.ig.entity.directThread(threadId).broadcastText(text);
      logger.info(`📤 Message sent to thread ${threadId}`);
      return true;
    } catch (error) {
      logger.error(`❌ Error sending message:`, error.message);
      throw error;
    }
  }

  async sendPhoto(threadId, photoBuffer, caption = '') {
    try {
      const result = await this.ig.entity.directThread(threadId).broadcastPhoto({
        file: photoBuffer
      });
      
      if (caption) {
        await this.sendMessage(threadId, caption);
      }
      
      logger.info(`📸 Photo sent to thread ${threadId}`);
      return result;
    } catch (error) {
      logger.error(`❌ Error sending photo:`, error.message);
      throw error;
    }
  }

  async sendVoice(threadId, voiceBuffer) {
    try {
      const result = await this.ig.entity.directThread(threadId).broadcastVoice({
        file: voiceBuffer
      });
      logger.info(`🎵 Voice message sent to thread ${threadId}`);
      return result;
    } catch (error) {
      logger.error(`❌ Error sending voice:`, error.message);
      throw error;
    }
  }

  // User management methods
  async getUserInfo(userId) {
    try {
      return await this.ig.user.info(userId);
    } catch (error) {
      logger.error(`❌ Error getting user info for ${userId}:`, error.message);
      return null;
    }
  }

  async followUser(userId) {
    try {
      await this.ig.friendship.create(userId);
      logger.info(`✅ Followed user ${userId}`);
      
      // Emit follow event
      this.emit('userFollowed', { userId, timestamp: new Date() });
      return true;
    } catch (error) {
      logger.error(`❌ Error following user ${userId}:`, error.message);
      return false;
    }
  }

  async unfollowUser(userId) {
    try {
      await this.ig.friendship.destroy(userId);
      logger.info(`❌ Unfollowed user ${userId}`);
      
      // Emit unfollow event
      this.emit('userUnfollowed', { userId, timestamp: new Date() });
      return true;
    } catch (error) {
      logger.error(`❌ Error unfollowing user ${userId}:`, error.message);
      return false;
    }
  }

  async getFollowers() {
    try {
      const followers = await this.ig.feed.accountFollowers(this.ig.state.cookieUserId).items();
      return followers;
    } catch (error) {
      logger.error('❌ Error getting followers:', error.message);
      return [];
    }
  }

  async getFollowing() {
    try {
      const following = await this.ig.feed.accountFollowing(this.ig.state.cookieUserId).items();
      return following;
    } catch (error) {
      logger.error('❌ Error getting following:', error.message);
      return [];
    }
  }

  async getPendingFollowRequests() {
    try {
      const requests = await this.ig.feed.pendingFriendships().items();
      return requests;
    } catch (error) {
      logger.error('❌ Error getting follow requests:', error.message);
      return [];
    }
  }

  async approveFollowRequest(userId) {
    try {
      await this.ig.friendship.approve(userId);
      logger.info(`✅ Approved follow request from ${userId}`);
      
      // Emit event
      this.emit('followRequestApproved', { userId, timestamp: new Date() });
      return true;
    } catch (error) {
      logger.error(`❌ Error approving follow request:`, error.message);
      return false;
    }
  }

  async getMessageRequests() {
    try {
      const pendingResponse = await this.ig.feed.directPending().request();
      return pendingResponse.inbox?.threads || [];
    } catch (error) {
      logger.error('❌ Error getting message requests:', error.message);
      return [];
    }
  }

  async approveMessageRequest(threadId) {
    try {
      await this.ig.directThread.approve(threadId);
      logger.info(`✅ Approved message request: ${threadId}`);
      
      // Emit event
      this.emit('messageRequestApproved', { threadId, timestamp: new Date() });
      return true;
    } catch (error) {
      logger.error(`❌ Error approving message request:`, error.message);
      return false;
    }
  }

  async disconnect() {
    logger.info('🔌 Disconnecting from Instagram...');
    this.isRunning = false;

    try {
      if (this.ig.realtime && typeof this.ig.realtime.disconnect === 'function') {
        await this.ig.realtime.disconnect();
        logger.info('✅ Disconnected successfully');
      }
    } catch (error) {
      logger.warn('⚠️ Error during disconnect:', error.message);
    }
  }
}
