import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export class InstagramClient extends EventEmitter {
  constructor() {
    super();
    this.ig = withRealtime(new IgApiClient());
    this.isConnected = false;
    this.currentUser = null;
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
  }

  async initialize() {
    try {
      const username = config.instagram?.username;
      if (!username) {
        throw new Error('Instagram username is required');
      }

      this.ig.state.generateDevice(username);
      await this.login();
      await this.setupRealtimeConnection();
      
      this.isConnected = true;
      this.emit('ready');
      logger.info('✅ Instagram client initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize Instagram client:', error.message);
      throw error;
    }
  }

  async login() {
    let loginSuccess = false;

    // Try session.json first
    try {
      await fs.access('./session.json');
      const sessionData = JSON.parse(await fs.readFile('./session.json', 'utf-8'));
      await this.ig.state.deserialize(sessionData);
      
      this.currentUser = await this.ig.account.currentUser();
      logger.info('✅ Logged in from session.json');
      loginSuccess = true;
    } catch (error) {
      logger.debug('Session login failed, trying cookies...');
    }

    // Fallback to cookies.json
    if (!loginSuccess) {
      try {
        await this.loadCookiesFromJson('./cookies.json');
        this.currentUser = await this.ig.account.currentUser();
        
        // Save session after successful cookie login
        const session = await this.ig.state.serialize();
        delete session.constants;
        await fs.writeFile('./session.json', JSON.stringify(session, null, 2));
        
        logger.info(`✅ Logged in using cookies as @${this.currentUser.username}`);
        loginSuccess = true;
      } catch (error) {
        logger.error('❌ Cookie login failed:', error.message);
        throw error;
      }
    }

    if (!loginSuccess) {
      throw new Error('All login methods failed');
    }
  }

  async loadCookiesFromJson(path = './cookies.json') {
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
    // Main message handler
    this.ig.realtime.on('message', async (data) => {
      try {
        if (!data.message || !this.isNewMessageById(data.message.item_id)) {
          return;
        }

        const processedMessage = await this.processMessage(data.message, data);
        this.emit('message', processedMessage);
      } catch (error) {
        logger.error('❌ Error in message handler:', error.message);
      }
    });

    // Direct message handler
    this.ig.realtime.on('direct', async (data) => {
      try {
        if (data.message && this.isNewMessageById(data.message.item_id)) {
          const processedMessage = await this.processMessage(data.message, data);
          this.emit('message', processedMessage);
        }
      } catch (error) {
        logger.error('❌ Error in direct handler:', error.message);
      }
    });

    // Connection events
    this.ig.realtime.on('connect', () => {
      logger.info('🔗 Realtime connection established');
      this.emit('connected');
    });

    this.ig.realtime.on('error', (error) => {
      logger.error('🚨 Realtime connection error:', error.message);
      this.emit('error', error);
    });

    this.ig.realtime.on('close', () => {
      logger.warn('🔌 Realtime connection closed');
      this.isConnected = false;
      this.emit('disconnected');
    });
  }

  async processMessage(message, eventData) {
    // Get sender info
    let senderInfo = null;
    if (eventData.thread?.users) {
      senderInfo = eventData.thread.users.find(u => u.pk?.toString() === message.user_id?.toString());
    }

    // If not found in thread, fetch user info
    if (!senderInfo && message.user_id) {
      try {
        senderInfo = await this.ig.user.info(message.user_id);
      } catch (error) {
        logger.debug('Could not fetch user info:', error.message);
      }
    }

    return {
      id: message.item_id,
      text: message.text || '',
      senderId: message.user_id,
      senderUsername: senderInfo?.username || `user_${message.user_id}`,
      senderFullName: senderInfo?.full_name || null,
      senderProfilePic: senderInfo?.profile_pic_url || senderInfo?.hd_profile_pic_url_info?.url || null,
      timestamp: new Date(parseInt(message.timestamp, 10) / 1000),
      threadId: eventData.thread?.thread_id || message.thread_id || 'unknown_thread',
      threadTitle: eventData.thread?.thread_title || 'Direct Message',
      type: message.item_type || 'text',
      isGroup: eventData.thread?.is_group || false,
      raw: message
    };
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

  async sendMessage(threadId, text) {
    try {
      await this.ig.entity.directThread(threadId).broadcastText(text);
      return true;
    } catch (error) {
      logger.error(`❌ Error sending message to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  async sendPhoto(threadId, photoBuffer) {
    try {
      await this.ig.entity.directThread(threadId).broadcastPhoto({ file: photoBuffer });
      return true;
    } catch (error) {
      logger.error(`❌ Error sending photo to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  async sendVideo(threadId, videoBuffer) {
    try {
      await this.ig.entity.directThread(threadId).broadcastVideo({ video: videoBuffer });
      return true;
    } catch (error) {
      logger.error(`❌ Error sending video to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  async sendVoice(threadId, voiceBuffer) {
    try {
      await this.ig.entity.directThread(threadId).broadcastVoice({ file: voiceBuffer });
      return true;
    } catch (error) {
      logger.error(`❌ Error sending voice to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  async getUserInfo(userId) {
    try {
      return await this.ig.user.info(userId);
    } catch (error) {
      logger.error(`❌ Error getting user info for ${userId}:`, error.message);
      return null;
    }
  }

  async searchUser(username) {
    try {
      return await this.ig.user.searchExact(username);
    } catch (error) {
      logger.error(`❌ Error searching user ${username}:`, error.message);
      return null;
    }
  }

  async getFollowers() {
    try {
      return await this.ig.feed.accountFollowers(this.currentUser.pk).items();
    } catch (error) {
      logger.error('❌ Error getting followers:', error.message);
      return [];
    }
  }

  async getFollowing() {
    try {
      return await this.ig.feed.accountFollowing(this.currentUser.pk).items();
    } catch (error) {
      logger.error('❌ Error getting following:', error.message);
      return [];
    }
  }

  async followUser(userId) {
    try {
      await this.ig.friendship.create(userId);
      this.emit('userFollowed', userId);
      return true;
    } catch (error) {
      logger.error(`❌ Error following user ${userId}:`, error.message);
      return false;
    }
  }

  async unfollowUser(userId) {
    try {
      await this.ig.friendship.destroy(userId);
      this.emit('userUnfollowed', userId);
      return true;
    } catch (error) {
      logger.error(`❌ Error unfollowing user ${userId}:`, error.message);
      return false;
    }
  }

  async getPendingFollowRequests() {
    try {
      const response = await this.ig.feed.pendingFriendships().items();
      return response;
    } catch (error) {
      logger.error('❌ Error getting pending follow requests:', error.message);
      return [];
    }
  }

  async approveFollowRequest(userId) {
    try {
      await this.ig.friendship.approve(userId);
      this.emit('followRequestApproved', userId);
      return true;
    } catch (error) {
      logger.error(`❌ Error approving follow request ${userId}:`, error.message);
      return false;
    }
  }

  async getMessageRequests() {
    try {
      const response = await this.ig.feed.directPending().request();
      return response.inbox?.threads || [];
    } catch (error) {
      logger.error('❌ Error getting message requests:', error.message);
      return [];
    }
  }

  async approveMessageRequest(threadId) {
    try {
      await this.ig.directThread.approve(threadId);
      this.emit('messageRequestApproved', threadId);
      return true;
    } catch (error) {
      logger.error(`❌ Error approving message request ${threadId}:`, error.message);
      return false;
    }
  }

  async disconnect() {
    try {
      if (this.ig.realtime) {
        await this.ig.realtime.disconnect();
      }
      this.isConnected = false;
      this.emit('disconnected');
      logger.info('✅ Instagram client disconnected');
    } catch (error) {
      logger.error('❌ Error disconnecting:', error.message);
    }
  }
}