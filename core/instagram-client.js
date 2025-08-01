import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// Import our custom functions
import Chat from '../functions/Chat.js';
import User from '../functions/User.js';
import Message from '../functions/Message.js';
import ClientUser from '../functions/ClientUser.js';
import Attachment from '../functions/Attachment.js';

export class InstagramClient extends EventEmitter {
  constructor() {
    super();
    this.ig = withRealtime(new IgApiClient());
    this.isConnected = false;
    this.ready = false;
    this.user = null; // ClientUser instance
    this.currentUser = null; // Raw user data
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
    
    // Cache system using our custom classes
    this.cache = {
      messages: new Map(),
      users: new Map(),
      chats: new Map(),
      pendingChats: new Map()
    };

    this.eventsToReplay = [];
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
      this.ready = true;
      this.emit('ready');
      this.emit('connected');
      
      // Replay any events that occurred before ready
      this.eventsToReplay.forEach((event) => {
        const eventType = event.shift();
        if (eventType === 'realtime') {
          this.handleRealtimeReceive(...event);
        }
      });
      this.eventsToReplay = [];
      
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
      this.user = new ClientUser(this, this.currentUser);
      logger.info(`✅ Logged in from session.json as @${this.currentUser.username}`);
      loginSuccess = true;
    } catch (error) {
      logger.debug('Session login failed, trying cookies...');
    }

    // Fallback to cookies.json
    if (!loginSuccess) {
      try {
        await this.loadCookiesFromJson('./cookies.json');
        this.currentUser = await this.ig.account.currentUser();
        this.user = new ClientUser(this, this.currentUser);
        
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

    let cookiesLoaded = 0;
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
      cookiesLoaded++;
    }

    logger.info(`🍪 Successfully loaded ${cookiesLoaded}/${cookies.length} cookies from file`);
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

        await this.handleMessage(data.message, data);
      } catch (error) {
        logger.error('❌ Error in message handler:', error.message);
      }
    });

    // Direct message handler
    this.ig.realtime.on('direct', async (data) => {
      try {
        if (data.message && this.isNewMessageById(data.message.item_id)) {
          await this.handleMessage(data.message, data);
        }
      } catch (error) {
        logger.error('❌ Error in direct handler:', error.message);
      }
    });

    // Handle realtime receive for advanced features
    this.ig.realtime.on('receive', (topic, messages) => {
      if (!this.ready) {
        this.eventsToReplay.push(['realtime', topic, messages]);
        return;
      }
      this.handleRealtimeReceive(topic, messages);
    });

    // Connection events
    this.ig.realtime.on('connect', () => {
      logger.info('🔗 Realtime connection established');
      this.isConnected = true;
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

    // Typing indicators
    this.ig.realtime.on('typing', (data) => {
      this.emit('typing', data);
    });

    // Presence updates
    this.ig.realtime.on('presence', (data) => {
      this.emit('presence', data);
    });

    // Message status updates
    this.ig.realtime.on('messageStatus', (data) => {
      this.emit('messageStatus', data);
    });
  }

  async handleMessage(message, eventData) {
    try {
      // Get or create chat
      const threadId = eventData.thread?.thread_id || message.thread_id;
      let chat = this.cache.chats.get(threadId);
      
      if (!chat) {
        chat = new Chat(this, threadId, eventData.thread || { thread_id: threadId });
        this.cache.chats.set(threadId, chat);
      } else {
        chat._patch(eventData.thread || {});
      }

      // Create message instance
      const messageInstance = new Message(this, threadId, message);
      chat.messages.set(messageInstance.id, messageInstance);
      this.cache.messages.set(messageInstance.id, messageInstance);

      // Get or create user
      const userId = message.user_id;
      let user = this.cache.users.get(userId);
      
      if (!user) {
        // Try to get user from thread data first
        let userData = null;
        if (eventData.thread?.users) {
          userData = eventData.thread.users.find(u => u.pk?.toString() === userId?.toString());
        }
        
        // If not found, fetch user info
        if (!userData) {
          try {
            userData = await this.ig.user.info(userId);
          } catch (error) {
            logger.debug('Could not fetch user info:', error.message);
            userData = { pk: userId, username: `user_${userId}` };
          }
        }
        
        user = new User(this, userData);
        this.cache.users.set(userId, user);
      }

      // Emit events
      this.emit('messageCreate', messageInstance);
      
      // Check if it's a new follower (real-time detection)
      if (!this.cache.users.has(userId)) {
        this.emit('newFollower', user);
      }

    } catch (error) {
      logger.error('❌ Error handling message:', error.message);
    }
  }

  handleRealtimeReceive(topic, payload) {
    this.emit('rawRealtime', topic, payload);
    
    if (topic.id === '146') {
      const rawMessages = JSON.parse(payload);
      rawMessages.forEach(async (rawMessage) => {
        rawMessage.data.forEach((data) => {
          switch (data.op) {
            case 'replace': {
              this.handleRealtimeReplace(data);
              break;
            }
            case 'add': {
              this.handleRealtimeAdd(data);
              break;
            }
            case 'remove': {
              this.handleRealtimeRemove(data);
              break;
            }
          }
        });
      });
    }
  }

  handleRealtimeReplace(data) {
    // Handle thread updates, user updates, etc.
    const isInboxThreadPath = /\/direct_v2\/inbox\/threads\/(\d+)/.test(data.path);
    if (isInboxThreadPath) {
      const [threadId] = data.path.match(/\/direct_v2\/inbox\/threads\/(\d+)/).slice(1);
      const chat = this.cache.chats.get(threadId);
      if (chat) {
        const oldChat = Object.assign(Object.create(chat), chat);
        chat._patch(JSON.parse(data.value));
        
        // Emit specific events
        if (oldChat.name !== chat.name) {
          this.emit('chatNameUpdate', chat, oldChat.name, chat.name);
        }
        
        if (oldChat.users.size < chat.users.size) {
          const userAdded = chat.users.find((u) => !oldChat.users.has(u.id));
          if (userAdded) this.emit('chatUserAdd', chat, userAdded);
        } else if (oldChat.users.size > chat.users.size) {
          const userRemoved = oldChat.users.find((u) => !chat.users.has(u.id));
          if (userRemoved) this.emit('chatUserRemove', chat, userRemoved);
        }
      }
    }
  }

  handleRealtimeAdd(data) {
    // Handle new messages, new followers, etc.
    const isMessagePath = /\/direct_v2\/threads\/(\d+)\/items\/(\d+)/.test(data.path);
    if (isMessagePath) {
      const [threadId] = data.path.match(/\/direct_v2\/threads\/(\d+)\/items\/(\d+)/).slice(1);
      this.fetchChat(threadId).then((chat) => {
        const messagePayload = JSON.parse(data.value);
        if (messagePayload.item_type === 'action_log' || messagePayload.item_type === 'video_call_event') return;
        
        const message = new Message(this, threadId, messagePayload);
        chat.messages.set(message.id, message);
        this.emit('messageCreate', message);
      });
    }
  }

  handleRealtimeRemove(data) {
    // Handle message deletions, user removals, etc.
    const isMessagePath = /\/direct_v2\/threads\/(\d+)\/items\/(\d+)/.test(data.path);
    if (isMessagePath) {
      const [threadId] = data.path.match(/\/direct_v2\/threads\/(\d+)\/items\/(\d+)/).slice(1);
      this.fetchChat(threadId).then((chat) => {
        const messageId = data.value;
        const existing = chat.messages.get(messageId);
        if (existing) this.emit('messageDelete', existing);
      });
    }
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

  // Create or patch user in cache
  _patchOrCreateUser(userID, userPayload) {
    if (this.cache.users.has(userID)) {
      this.cache.users.get(userID)._patch(userPayload);
    } else {
      this.cache.users.set(userID, new User(this, userPayload));
    }
    return this.cache.users.get(userID);
  }

  // Fetch chat and cache it
  async fetchChat(chatID, force = false) {
    if (!this.cache.chats.has(chatID) || force) {
      const { thread: chatPayload } = await this.ig.feed.directThread({ thread_id: chatID }).request();
      const chat = new Chat(this, chatID, chatPayload);
      this.cache.chats.set(chatID, chat);
    }
    return this.cache.chats.get(chatID);
  }

  // Fetch user and cache it
  async fetchUser(query, force = false) {
    const userID = /^\d+$/.test(query) ? query : await this.ig.user.getIdByUsername(query);
    
    if (!this.cache.users.has(userID) || force) {
      const userPayload = await this.ig.user.info(userID);
      const user = new User(this, userPayload);
      this.cache.users.set(userID, user);
    }
    return this.cache.users.get(userID);
  }

  // Create chat between users
  async createChat(userIDs) {
    const threadPayload = await this.ig.direct.createGroupThread(userIDs);
    const chat = new Chat(this, threadPayload.thread_id, threadPayload);
    this.cache.chats.set(chat.id, chat);
    return chat;
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

  async sendPhoto(threadId, attachment) {
    try {
      if (!(attachment instanceof Attachment)) {
        attachment = new Attachment(attachment);
      }
      await attachment._verify();
      await this.ig.entity.directThread(threadId).broadcastPhoto({ file: attachment.file });
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
      this.ready = false;
      this.emit('disconnected');
      logger.info('✅ Instagram client disconnected');
    } catch (error) {
      logger.error('❌ Error disconnecting:', error.message);
    }
  }

  toJSON() {
    return {
      ready: this.ready,
      isConnected: this.isConnected,
      id: this.user?.id
    };
  }
}