
import { IgApiClient } from 'instagram-private-api';
import { withFbnsAndRealtime, GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { writeFile, readFile, exists } from 'fs';
import tough from 'tough-cookie';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';
import camelcaseKeys from 'camelcase-keys';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';

const writeFileAsync = promisify(writeFile);
const readFileAsync = promisify(readFile);
const existsAsync = promisify(exists);

export class InstagramBot extends EventEmitter {
  constructor() {
    super();
    this.ig = withFbnsAndRealtime(new IgApiClient());
    this.isRunning = false;
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
    this.pushContext = {};
    this.connectionRetries = 0;
    this.maxRetries = config.app?.maxRetries || 5;
    this.messageHandlers = [];
    this.lastMessageCheck = new Date(Date.now() - 60000); // Initialize to 1 min ago
    this.messageRequestsMonitorInterval = null;
  }

  log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;
    switch (level.toUpperCase()) {
      case 'INFO':
        logger.info(formattedMessage, ...args);
        break;
      case 'DEBUG':
        logger.debug(formattedMessage, ...args);
        break;
      case 'WARN':
        logger.warn(formattedMessage, ...args);
        break;
      case 'ERROR':
        logger.error(formattedMessage, ...args);
        break;
      case 'TRACE':
        logger.trace(formattedMessage, ...args);
        break;
      default:
        logger.info(formattedMessage, ...args);
    }
  }

  async login() {
    try {
      const username = config.instagram?.username || process.env.IG_USERNAME || '';
      if (!username) {
        throw new Error('❌ INSTAGRAM_USERNAME is missing');
      }

      this.ig.state.generateDevice(username);
      let loginSuccess = false;

      // Try reading FBNS/Realtime state first
      await this.readState();

      // Try session login
      if (await this.trySessionLogin()) {
        loginSuccess = true;
      }
      // Try cookies if session failed
      else if (await this.tryCookieLogin()) {
        loginSuccess = true;
      }
      // Try fresh login if both failed
      else if ((config.instagram?.password || process.env.IG_PASSWORD) && await this.tryFreshLogin()) {
        loginSuccess = true;
      }

      if (!loginSuccess) {
        throw new Error('❌ No valid login method succeeded (session, cookies, or credentials)');
      }

      // Subscribe to request end for saving state
      this.ig.request.end$.subscribe(() => this.saveState());

      // Setup FBNS and Realtime connections
      await this.setupConnections();
      this.isRunning = true;
      this.log('INFO', '🚀 Instagram bot is now running with FBNS and Realtime support');
      this.emit('ready');
      return true;

    } catch (error) {
      this.log('ERROR', `❌ Failed to initialize bot: ${error.message}`);
      this.log('DEBUG', 'Initialization error stack:', error.stack);
      throw error;
    }
  }

  async trySessionLogin() {
    try {
      await fs.access(config.instagram.sessionPath || './session.json');
      const sessionData = JSON.parse(await fs.readFile(config.instagram.sessionPath || './session.json', 'utf-8'));
      await this.ig.state.deserialize(sessionData);
      await this.ig.account.currentUser();
      this.log('INFO', '✅ Logged in from session.json');
      return true;
    } catch (error) {
      this.log('DEBUG', `⚠️ Session login failed: ${error.message}`);
      return false;
    }
  }

  async tryCookieLogin() {
    try {
      await this.loadCookiesFromJson(config.instagram.cookiesPath || './cookies.json');
      const currentUserResponse = await this.ig.account.currentUser();
      await this.saveSession();
      this.log('INFO', `✅ Logged in using cookies.json as @${currentUserResponse.username}`);
      return true;
    } catch (error) {
      this.log('DEBUG', `⚠️ Cookie login failed: ${error.message}`);
      return false;
    }
  }

  async tryFreshLogin() {
    try {
      const password = config.instagram.password || process.env.IG_PASSWORD || '';
      await this.ig.account.login(config.instagram.username || process.env.IG_USERNAME, password);
      await this.saveSession();
      this.log('INFO', '✅ Fresh login successful');
      return true;
    } catch (error) {
      this.log('DEBUG', `⚠️ Fresh login failed: ${error.message}`);
      return false;
    }
  }

  async loadCookiesFromJson(path) {
    try {
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
      this.log('INFO', `🍪 Successfully loaded ${cookiesLoaded}/${cookies.length} cookies from ${path}`);
    } catch (error) {
      this.log('ERROR', `❌ Failed to load cookies from ${path}: ${error.message}`);
      throw error;
    }
  }

  async saveSession() {
    try {
      const session = await this.ig.state.serialize();
      delete session.constants;
      await fs.writeFile(config.instagram.sessionPath || './session.json', JSON.stringify(session, null, 2));
      this.log('DEBUG', '💾 Session saved successfully');
    } catch (error) {
      this.log('ERROR', `❌ Failed to save session: ${error.message}`);
    }
  }

  async saveState() {
    try {
      await writeFileAsync('state.json', await this.ig.exportState(), { encoding: 'utf8' });
      this.log('DEBUG', '💾 FBNS/Realtime state saved successfully');
    } catch (error) {
      this.log('ERROR', `❌ Failed to save FBNS/Realtime state: ${error.message}`);
    }
  }

  async readState() {
    try {
      if (!(await existsAsync('state.json'))) return;
      await this.ig.importState(await readFileAsync('state.json', { encoding: 'utf8' }));
      this.log('DEBUG', '📂 FBNS/Realtime state loaded successfully');
    } catch (error) {
      this.log('ERROR', `❌ Failed to load FBNS/Realtime state: ${error.message}`);
    }
  }

  async setupConnections() {
    this.registerHandlers();
    
    try {
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
        connectOverrides: {},
        socksOptions: config.proxy ? {
          type: config.proxy.type || 5,
          host: config.proxy.host,
          port: config.proxy.port,
          userId: config.proxy.username,
          password: config.proxy.password,
        } : undefined,
      });

      await this.ig.fbns.connect();
      this.log('INFO', '🔗 FBNS and Realtime connections established');
    } catch (error) {
      this.log('ERROR', `❌ Failed to establish connections: ${error.message}`);
      throw error;
    }
  }

  registerHandlers() {
    this.log('INFO', '📡 Registering Realtime and FBNS event handlers...');

    // Realtime (MQTT) Handlers
    this.ig.realtime.on('message', async (data) => {
      try {
        if (!data.message || !this.isNewMessageById(data.message.item_id, data.message.thread_id)) {
          this.log('DEBUG', `⚠️ Message ${data.message.item_id} filtered as duplicate`);
          return;
        }
        this.log('INFO', '✅ Processing new message (by ID)...');
        await this.handleMessage(data.message, data);
      } catch (error) {
        this.log('ERROR', `❌ Error in message handler: ${error.message}`);
      }
    });

    this.ig.realtime.on('direct', async (data) => {
      try {
        if (data.message && this.isNewMessageById(data.message.item_id, data.message.thread_id)) {
          this.log('INFO', '✅ Processing new direct message (by ID)...');
          await this.handleMessage(data.message, data);
        } else {
          this.log('INFO', 'ℹ️ Received non-message direct event');
          this.log('DEBUG', 'Direct event details:', JSON.stringify(data, null, 2));
        }
      } catch (error) {
        this.log('ERROR', `❌ Error in direct handler: ${error.message}`);
      }
    });

    this.ig.realtime.on('push', async (data) => {
      try {
        const { collapseKey, payload } = camelcaseKeys(data, { deep: true });
        this.log('INFO', `🔔 Push notification received, collapseKey: ${collapseKey}`);
        if (collapseKey === 'direct_v2_message') {
          const threadIdMatch = payload?.match?.(/thread_id=(\d+)/);
          const itemIdMatch = payload?.match?.(/item_id=([^&]+)/);
          
          if (threadIdMatch?.[1] && itemIdMatch?.[1]) {
            const threadId = threadIdMatch[1];
            const itemId = itemIdMatch[1];
            
            if (!this.pushContext[threadId]) {
              this.pushContext[threadId] = new Set();
            }
            this.pushContext[threadId].add(itemId);
            
            this.log('INFO', `🔔 Push notification - Thread ID: ${threadId}, Item ID: ${itemId}`);
            this.emit('push', { threadId, itemId, payload });
            
            if (Object.keys(this.pushContext).length > 100) {
              this.pushContext = {};
              this.log('DEBUG', '🧹 Cleared push context cache (size limit)');
            }
          } else {
            this.log('WARN', '🔔 Could not extract thread_id or item_id from payload');
          }
        } else if (collapseKey === 'consolidated_notification_ig' || collapseKey?.startsWith('notification')) {
          this.ig.realtime.emit('activity', data);
          this.log('INFO', '🔔 Forwarded activity notification');
        }
      } catch (error) {
        this.log('ERROR', `❌ Error processing push notification: ${error.message}`);
      }
    });

    this.ig.realtime.on('connect', () => {
      this.log('INFO', '🔗 Realtime connection established');
      this.connectionRetries = 0;
      this.isRunning = true;
    });

    this.ig.realtime.on('error', (error) => {
      this.log('ERROR', `🚨 Realtime connection error: ${error.message}`);
      this.handleConnectionError();
    });

    this.ig.realtime.on('close', () => {
      this.log('WARN', '🔌 Realtime connection closed');
      this.isRunning = false;
      this.handleConnectionError();
    });

    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message') || topicStr.includes('iris')) {
        this.log('DEBUG', `📥 Received on topic: ${topicStr}`);
      } else {
        this.log('TRACE', `📥 Received on other topic: ${topicStr}`);
      }
    });

    this.ig.realtime.on('threadUpdate', (data) => {
      this.log('INFO', '🧵 Thread update event received');
      this.log('DEBUG', 'Thread update details:', JSON.stringify(data, null, 2));
    });

    this.ig.realtime.on('realtimeSub', (data) => {
      this.log('INFO', '🔄 Generic realtime subscription event received');
      this.log('DEBUG', 'RealtimeSub details:', JSON.stringify(data, null, 2));
    });

    this.ig.realtime.on('presence', (data) => {
      this.log('INFO', '👤 Presence update event received');
      this.log('DEBUG', 'Presence details:', JSON.stringify(data, null, 2));
    });

    this.ig.realtime.on('typing', (data) => {
      this.log('INFO', '⌨️ Typing indicator event received');
      this.log('DEBUG', 'Typing details:', JSON.stringify(data, null, 2));
    });

    this.ig.realtime.on('messageStatus', (data) => {
      this.log('INFO', '📊 Message status update event received');
      this.log('DEBUG', 'MessageStatus details:', JSON.stringify(data, null, 2));
    });

    this.ig.realtime.on('liveNotification', (data) => {
      this.log('INFO', '📺 Live stream notification event received');
      this.log('DEBUG', 'LiveNotification details:', JSON.stringify(data, null, 2));
    });

    this.ig.realtime.on('activity', (data) => {
      this.log('INFO', '⚡ Activity notification event received');
      this.log('DEBUG', 'Activity details:', JSON.stringify(data, null, 2));
    });

    this.ig.realtime.on('reconnect', () => {
      this.log('INFO', '🔁 Realtime client is attempting to reconnect');
    });

    this.ig.realtime.on('debug', (data) => {
      this.log('TRACE', `🐛 Realtime debug info: ${data}`);
    });

    // FBNS Handlers
    this.ig.fbns.on('push', (data) => {
      this.log('INFO', '🔔 FBNS push notification received');
      this.log('DEBUG', 'FBNS push details:', JSON.stringify(data, null, 2));
      this.emit('fbnsPush', data);
    });

    this.ig.fbns.on('auth', async (auth) => {
      this.log('INFO', '🔑 FBNS auth received');
      this.log('DEBUG', 'FBNS auth details:', JSON.stringify(auth, null, 2));
      await this.saveState();
      this.emit('fbnsAuth', auth);
    });

    this.ig.fbns.on('error', (error) => {
      this.log('ERROR', `❌ FBNS error: ${error.message}`);
      this.emit('fbnsError', error);
    });

    this.ig.fbns.on('warning', (warning) => {
      this.log('WARN', `⚠️ FBNS warning: ${warning.message}`);
      this.emit('fbnsWarning', warning);
    });
  }

  async handleConnectionError() {
    if (this.connectionRetries < this.maxRetries) {
      this.connectionRetries++;
      this.log('INFO', `🔁 Attempting to reconnect (${this.connectionRetries}/${this.maxRetries})...`);
      
      setTimeout(async () => {
        try {
          await this.setupConnections();
        } catch (error) {
          this.log('ERROR', `❌ Reconnection failed: ${error.message}`);
          this.handleConnectionError();
        }
      }, config.app?.retryDelay || 5000);
    } else {
      this.log('ERROR', '❌ Max reconnection attempts reached');
      this.emit('error', new Error('Connection lost and max retries exceeded'));
    }
  }

  isNewMessageById(messageId, threadId = null) {
    if (!messageId) {
      this.log('WARN', '⚠️ Attempted to check message ID, but ID was missing');
      return true;
    }
    
    if (this.processedMessageIds.has(messageId)) {
      this.log('DEBUG', `⚠️ Message ${messageId} filtered as duplicate (by ID)`);
      return false;
    }

    if (threadId && this.pushContext[threadId]?.has(messageId)) {
      this.log('DEBUG', `⚠️ Message ${messageId} filtered as duplicate (by Push Context for thread ${threadId})`);
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
        this.log('WARN', '⚠️ Received message with missing essential fields');
        return;
      }

      let senderUsername = `user_${message.user_id}`;
      if (eventData.thread?.users) {
        const sender = eventData.thread.users.find(u => u.pk?.toString() === message.user_id?.toString());
        if (sender?.username) {
          senderUsername = sender.username;
        }
      }

      const processedMessage = {
        id: message.item_id,
        text: message.text || '',
        senderId: message.user_id,
        senderUsername: senderUsername,
        timestamp: new Date(parseInt(message.timestamp, 10) / 1000),
        threadId: eventData.thread?.thread_id || message.thread_id || 'unknown_thread',
        threadTitle: eventData.thread?.thread_title || message.thread_title || 'Direct Message',
        type: message.item_type || 'text',
        media: message.media || null,
        raw: message
      };

      this.log('INFO', `💬 [${processedMessage.threadTitle}] New message from @${senderUsername}: "${processedMessage.text}"`);
      for (const handler of this.messageHandlers) {
        try {
          await handler(processedMessage);
        } catch (handlerError) {
          this.log('ERROR', `❌ Error in message handler (${handler.name || 'anonymous'}): ${handlerError.message}`);
        }
      }
      this.emit('message', processedMessage);
      
    } catch (error) {
      this.log('ERROR', `❌ Error handling message: ${error.message}`);
    }
  }

  onMessage(handler) {
    if (typeof handler === 'function') {
      this.messageHandlers.push(handler);
      this.log('INFO', `📝 Added message handler (total: ${this.messageHandlers.length})`);
    } else {
      this.log('WARN', '⚠️ Attempted to add non-function as message handler');
    }
  }

  async sendMessage(threadId, text) {
    if (!threadId || !text) {
      this.log('WARN', '⚠️ sendMessage called with missing threadId or text');
      throw new Error('Thread ID and text are required');
    }

    try {
      await this.ig.entity.directThread(threadId).broadcastText(text);
      this.log('INFO', `📤 Message sent to thread ${threadId}: "${text}"`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error sending message to thread ${threadId}: ${error.message}`);
      throw error;
    }
  }

  async sendPhoto(threadId, photoPath, caption = '') {
    try {
      await this.ig.entity.directThread(threadId).broadcastPhoto({
        file: photoPath,
        caption: caption
      });
      this.log('INFO', `📷 Photo sent to thread ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error sending photo to thread ${threadId}: ${error.message}`);
      throw error;
    }
  }

  async sendVideo(threadId, videoPath, caption = '') {
    try {
      await this.ig.entity.directThread(threadId).broadcastVideo({
        video: videoPath,
        caption: caption
      });
      this.log('INFO', `🎥 Video sent to thread ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error sending video to thread ${threadId}: ${error.message}`);
      throw error;
    }
  }

  async getThreadInfo(threadId) {
    try {
      const thread = await this.ig.entity.directThread(threadId).info();
      return {
        id: thread.thread_id,
        title: thread.thread_title,
        users: thread.users,
        isGroup: thread.thread_type === 'group'
      };
    } catch (error) {
      this.log('ERROR', `❌ Error getting thread info for ${threadId}: ${error.message}`);
      return null;
    }
  }

  async getFollowers() {
    try {
      const followersFeed = this.ig.feed.accountFollowers(this.ig.state.cookieUserId);
      const followers = await followersFeed.items();
      this.log('INFO', `📋 Fetched ${followers.length} followers`);
      return followers;
    } catch (error) {
      this.log('ERROR', `❌ Error getting followers: ${error.message}`);
      return [];
    }
  }

  async getFollowing() {
    try {
      const followingFeed = this.ig.feed.accountFollowing(this.ig.state.cookieUserId);
      const following = await followingFeed.items();
      this.log('INFO', `📋 Fetched ${following.length} following`);
      return following;
    } catch (error) {
      this.log('ERROR', `❌ Error getting following: ${error.message}`);
      return [];
    }
  }

  async followUser(userId) {
    try {
      await this.ig.friendship.create(userId);
      this.log('INFO', `✅ Successfully followed user ${userId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error following user ${userId}: ${error.message}`);
      return false;
    }
  }

  async unfollowUser(userId) {
    try {
      await this.ig.friendship.destroy(userId);
      this.log('INFO', `✅ Successfully unfollowed user ${userId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error unfollowing user ${userId}: ${error.message}`);
      return false;
    }
  }

  async getPendingFollowRequests() {
    try {
      const pendingRequests = await this.ig.friendship.pending();
      const users = pendingRequests.users || [];
      this.log('INFO', `📬 Fetched ${users.length} pending follow requests`);
      return users;
    } catch (error) {
      this.log('ERROR', `❌ Error getting pending follow requests: ${error.message}`);
      return [];
    }
  }

  async approveFollowRequest(userId) {
    try {
      await this.ig.friendship.approve(userId);
      this.log('INFO', `✅ Approved follow request from user ${userId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error approving follow request from ${userId}: ${error.message}`);
      return false;
    }
  }

  async getMessageRequests() {
    try {
      const pendingResponse = await this.ig.feed.directPending().request();
      const threads = pendingResponse.inbox?.threads || [];
      this.log('INFO', `📬 Fetched ${threads.length} message requests`);
      return threads;
    } catch (error) {
      this.log('ERROR', `❌ Error getting message requests: ${error.message}`);
      return [];
    }
  }

  async approveMessageRequest(threadId) {
    try {
      await this.ig.directThread.approve(threadId);
      this.log('INFO', `✅ Approved message request: ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error approving message request ${threadId}: ${error.message}`);
      return false;
    }
  }

  async declineMessageRequest(threadId) {
    try {
      await this.ig.directThread.decline(threadId);
      this.log('INFO', `❌ Declined message request: ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Error declining message request ${threadId}: ${error.message}`);
      return false;
    }
  }

  async startMessageRequestsMonitor(intervalMs = 300000) {
    if (this.messageRequestsMonitorInterval) {
      clearInterval(this.messageRequestsMonitorInterval);
      this.log('WARN', '🛑 Stopping existing message requests monitor before starting a new one');
    }
    this.messageRequestsMonitorInterval = setInterval(async () => {
      if (this.isRunning) {
        try {
          const requests = await this.getMessageRequests();
          // Logging handled in getMessageRequests
        } catch (error) {
          this.log('ERROR', `❌ Error in periodic message requests check: ${error.message}`);
        }
      }
    }, intervalMs);
    this.log('INFO', `🕒 Started message requests monitor (checking every ${intervalMs / 1000 / 60} minutes)`);
  }

  async subscribeToLiveComments(broadcastId) {
    try {
      await this.ig.realtime.graphQlSubscribe(
        GraphQLSubscriptions.getLiveRealtimeCommentsSubscription(broadcastId)
      );
      this.log('INFO', `📺 Subscribed to live comments for broadcast: ${broadcastId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Failed to subscribe to live comments for ${broadcastId}: ${error.message}`);
      return false;
    }
  }

  async setForegroundState(inApp = true, inDevice = true, timeoutSeconds = 60) {
    try {
      const timeout = inApp ? Math.max(10, timeoutSeconds) : 900;
      await this.ig.realtime.direct.sendForegroundState({
        inForegroundApp: Boolean(inApp),
        inForegroundDevice: Boolean(inDevice),
        keepAliveTimeout: timeout,
      });
      this.log('INFO', `📱 Foreground state set: App=${inApp}, Device=${inDevice}, Timeout=${timeout}s`);
      return true;
    } catch (error) {
      this.log('ERROR', `❌ Failed to set foreground state: ${error.message}`);
      return false;
    }
  }

  async simulateDeviceToggle() {
    this.log('INFO', '📱 Starting device simulation: Turning OFF...');
    const offSuccess = await this.setForegroundState(false, false, 900);
    if (!offSuccess) {
      this.log('WARN', '📱 Simulation step 1 (device off) might have failed');
    }
    setTimeout(async () => {
      this.log('INFO', '📱 Simulation: Turning device back ON...');
      const onSuccess = await this.setForegroundState(true, true, 60);
      if (!onSuccess) {
        this.log('WARN', '📱 Simulation step 2 (device on) might have failed');
      } else {
        this.log('INFO', '📱 Device simulation cycle completed');
      }
    }, 5000);
  }

  async disconnect() {
    this.log('INFO', '🔌 Initiating graceful disconnect from Instagram...');
    this.isRunning = false;
    this.pushContext = {};

    if (this.messageRequestsMonitorInterval) {
      clearInterval(this.messageRequestsMonitorInterval);
      this.messageRequestsMonitorInterval = null;
      this.log('INFO', '🕒 Message requests monitor stopped');
    }

    try {
      await this.setForegroundState(false, false, 900);
      if (this.ig.realtime && typeof this.ig.realtime.disconnect === 'function') {
        await this.ig.realtime.disconnect();
        this.log('INFO', '✅ Disconnected from Instagram Realtime successfully');
      }
      if (this.ig.fbns && typeof this.ig.fbns.disconnect === 'function') {
        await this.ig.fbns.disconnect();
        this.log('INFO', '✅ Disconnected from Instagram FBNS successfully');
      }
    } catch (error) {
      this.log('WARN', `⚠️ Error during disconnect: ${error.message}`);
    }
  }
}

async function main() {
  let bot;
  try {
    bot = new InstagramBot();
    await bot.login();
    const moduleManager = new ModuleManager(bot);
    await moduleManager.loadModules();
    const messageHandler = new MessageHandler(bot, moduleManager, null);
    bot.onMessage((message) => messageHandler.handleMessage(message));
    await bot.startMessageRequestsMonitor();
    console.log('🚀 Bot is running with full module support. Type .help or use your commands.');
    
    setInterval(() => {
      console.log(`💓 [${new Date().toISOString()}] Bot heartbeat - Running: ${bot.isRunning}`);
    }, 300000);

    const shutdownHandler = async () => {
      console.log('\n👋 [SIGINT/SIGTERM] Shutting down gracefully...');
      if (bot) {
        await bot.disconnect();
      }
      console.log('🛑 Shutdown complete.');
      process.exit(0);
    };
    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);
  } catch (error) {
    console.error(`❌ Bot failed to start: ${error.message}`);
    if (bot) {
      try {
        await bot.disconnect();
      } catch (disconnectError) {
        console.error(`❌ Error during cleanup disconnect: ${disconnectError.message}`);
      }
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`❌ Unhandled error in main execution: ${error.message}`);
    process.exit(1);
  });
}
