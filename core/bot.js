import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions } from 'instagram_mqtt';
import { SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

class InstagramBot {
  constructor() {
    this.ig = withRealtime(new IgApiClient());
    this.messageHandlers = [];
    this.isRunning = false;
    this.lastMessageCheck = new Date(Date.now() - 60000);
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
    this.currentUser = null;
  }

  log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`, ...args);
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
        this.log('INFO', '📂 Found session.json, trying to login from session...');
        const sessionData = JSON.parse(await fs.readFile('./session.json', 'utf-8'));
        await this.ig.state.deserialize(sessionData);
        
        try {
          this.currentUser = await this.ig.account.currentUser();
          this.log('INFO', `✅ Logged in from session.json as @${this.currentUser.username}`);
          loginSuccess = true;
        } catch (validationError) {
          this.log('WARN', '⚠️ Session validation failed:', validationError.message);
        }
      } catch (sessionAccessError) {
        this.log('INFO', '📂 session.json not found or invalid, trying cookies.json...');
      }

      // Fallback to cookies.json
      if (!loginSuccess) {
        try {
          this.log('INFO', '📂 Attempting login using cookies.json...');
          await this.loadCookiesFromJson('./cookies.json');
          
          try {
            this.currentUser = await this.ig.account.currentUser();
            this.log('INFO', `✅ Logged in using cookies.json as @${this.currentUser.username}`);
            loginSuccess = true;

            // Save session after successful cookie login
            const session = await this.ig.state.serialize();
            delete session.constants;
            await fs.writeFile('./session.json', JSON.stringify(session, null, 2));
            this.log('INFO', '💾 session.json saved from cookie-based login');
          } catch (cookieValidationError) {
            this.log('ERROR', '❌ Failed to validate login using cookies.json:', cookieValidationError.message);
            throw new Error(`Cookie login validation failed: ${cookieValidationError.message}`);
          }
        } catch (cookieLoadError) {
          this.log('ERROR', '❌ Failed to load or process cookies.json:', cookieLoadError.message);
          throw new Error(`Cookie loading failed: ${cookieLoadError.message}`);
        }
      }

      if (loginSuccess) {
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
          connectOverrides: {},
        });

        this.isRunning = true;
        this.log('INFO', '🚀 Instagram bot is now running and listening for messages');
      } else {
        throw new Error('No valid login method succeeded (session or cookies).');
      }

    } catch (error) {
      this.log('ERROR', '❌ Failed to initialize bot:', error.message);
      throw error;
    }
  }

  async loadCookiesFromJson(path = './cookies.json') {
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

      this.log('INFO', `🍪 Successfully loaded ${cookiesLoaded}/${cookies.length} cookies from file`);
    } catch (error) {
      this.log('ERROR', `❌ Critical error loading cookies from ${path}:`, error.message);
      throw error;
    }
  }

  registerRealtimeHandlers() {
    this.log('INFO', '📡 Registering real-time event handlers...');

    // Main message handler
    this.ig.realtime.on('message', async (data) => {
      try {
        this.log('DEBUG', '📨 [Realtime] Raw message event data received');
        
        if (!data.message) {
          this.log('WARN', '⚠️ No message payload in event data');
          return;
        }

        if (!this.isNewMessageById(data.message.item_id)) {
          this.log('DEBUG', `⚠️ Message ${data.message.item_id} filtered as duplicate (by ID)`);
          return;
        }

        this.log('INFO', '✅ Processing new message (by ID)...');
        await this.handleMessage(data.message, data);

      } catch (err) {
        this.log('ERROR', '❌ Critical error in main message handler:', err.message);
      }
    });

    // Direct message handler
    this.ig.realtime.on('direct', async (data) => {
      try {
        this.log('DEBUG', '📨 [Realtime] Raw direct event data received');
        
        if (data.message) {
          if (!this.isNewMessageById(data.message.item_id)) {
            this.log('DEBUG', `⚠️ Direct message ${data.message.item_id} filtered as duplicate (by ID)`);
            return;
          }

          this.log('INFO', '✅ Processing new direct message (by ID)...');
          await this.handleMessage(data.message, data);
        } else {
          this.log('INFO', 'ℹ️ Received non-message direct event');
        }

      } catch (err) {
        this.log('ERROR', '❌ Critical error in direct handler:', err.message);
      }
    });

    // Error handlers
    this.ig.realtime.on('error', (err) => {
      this.log('ERROR', '🚨 Realtime connection error:', err.message || err);
    });

    this.ig.realtime.on('close', () => {
      this.log('WARN', '🔌 Realtime connection closed');
      this.isRunning = false;
    });

    this.ig.realtime.on('connect', () => {
      this.log('INFO', '🔗 Realtime connection successfully established');
      this.isRunning = true;
    });
  }

  isNewMessageById(messageId) {
    if (!messageId) {
      this.log('WARN', '⚠️ Attempted to check message ID, but ID was missing.');
      return true;
    }

    if (this.processedMessageIds.has(messageId)) {
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

      // Enhanced message processing with media support
      const processedMessage = {
        id: message.item_id,
        text: message.text || '',
        senderId: message.user_id,
        senderUsername: senderUsername,
        timestamp: new Date(parseInt(message.timestamp, 10) / 1000),
        threadId: eventData.thread?.thread_id || message.thread_id || 'unknown_thread',
        threadTitle: eventData.thread?.thread_title || message.thread_title || 'Direct Message',
        type: this.getMessageType(message),
        mediaData: this.extractMediaData(message),
        raw: message
      };

      this.log('INFO', `💬 [${processedMessage.threadTitle}] New ${processedMessage.type} from @${processedMessage.senderUsername}: "${processedMessage.text || '[Media]'}"`);

      // Execute registered message handlers
      for (const handler of this.messageHandlers) {
        try {
          await handler(processedMessage);
        } catch (handlerError) {
          this.log('ERROR', `❌ Error in message handler:`, handlerError.message);
        }
      }

    } catch (error) {
      this.log('ERROR', '❌ Critical error handling message:', error.message);
    }
  }

  getMessageType(message) {
    if (message.item_type === 'text') return 'text';
    if (message.item_type === 'media') return 'photo';
    if (message.item_type === 'video') return 'video';
    if (message.item_type === 'voice_media') return 'voice';
    if (message.item_type === 'animated_media') return 'gif';
    if (message.item_type === 'story_share') return 'story';
    if (message.item_type === 'link') return 'link';
    if (message.item_type === 'like') return 'like';
    return message.item_type || 'unknown';
  }

  extractMediaData(message) {
    const mediaData = {
      hasMedia: false,
      mediaType: null,
      mediaUrl: null,
      thumbnailUrl: null,
      duration: null,
      dimensions: null
    };

    try {
      if (message.item_type === 'media' && message.media) {
        mediaData.hasMedia = true;
        mediaData.mediaType = 'photo';
        
        if (message.media.image_versions2?.candidates?.length > 0) {
          mediaData.mediaUrl = message.media.image_versions2.candidates[0].url;
          mediaData.dimensions = {
            width: message.media.image_versions2.candidates[0].width,
            height: message.media.image_versions2.candidates[0].height
          };
        }
      }

      if (message.item_type === 'video' && message.video_media) {
        mediaData.hasMedia = true;
        mediaData.mediaType = 'video';
        
        if (message.video_media.video_versions?.length > 0) {
          mediaData.mediaUrl = message.video_media.video_versions[0].url;
        }
        
        if (message.video_media.image_versions2?.candidates?.length > 0) {
          mediaData.thumbnailUrl = message.video_media.image_versions2.candidates[0].url;
        }
      }

      if (message.item_type === 'voice_media' && message.voice_media) {
        mediaData.hasMedia = true;
        mediaData.mediaType = 'voice';
        
        if (message.voice_media.media?.audio) {
          mediaData.mediaUrl = message.voice_media.media.audio.audio_src;
          mediaData.duration = message.voice_media.media.audio.duration;
        }
      }

      if (message.item_type === 'animated_media' && message.animated_media) {
        mediaData.hasMedia = true;
        mediaData.mediaType = 'gif';
        
        if (message.animated_media.images?.fixed_height) {
          mediaData.mediaUrl = message.animated_media.images.fixed_height.url;
        }
      }

    } catch (error) {
      this.log('WARN', '⚠️ Error extracting media data:', error.message);
    }

    return mediaData;
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
      const result = await this.ig.entity.directThread(threadId).broadcastText(text);
      this.log('INFO', `📤 Message sent successfully to thread ${threadId}: "${text}"`);
      return result;
    } catch (error) {
      this.log('ERROR', `❌ Error sending message to thread ${threadId}:`, error.message);
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
      
      this.log('INFO', `📤 Photo sent successfully to thread ${threadId}`);
      return result;
    } catch (error) {
      this.log('ERROR', `❌ Error sending photo to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  async sendVideo(threadId, videoBuffer, caption = '') {
    try {
      const result = await this.ig.entity.directThread(threadId).broadcastVideo({
        video: videoBuffer
      });
      
      if (caption) {
        await this.sendMessage(threadId, caption);
      }
      
      this.log('INFO', `📤 Video sent successfully to thread ${threadId}`);
      return result;
    } catch (error) {
      this.log('ERROR', `❌ Error sending video to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  async sendVoice(threadId, voiceBuffer) {
    try {
      const result = await this.ig.entity.directThread(threadId).broadcastVoice({
        file: voiceBuffer
      });
      
      this.log('INFO', `📤 Voice message sent successfully to thread ${threadId}`);
      return result;
    } catch (error) {
      this.log('ERROR', `❌ Error sending voice message to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  // User and thread management methods
  async getUserInfo(userId) {
    try {
      const userInfo = await this.ig.user.info(userId);
      return userInfo;
    } catch (error) {
      this.log('ERROR', `❌ Error getting user info for ${userId}:`, error.message);
      return null;
    }
  }

  async searchUser(username) {
    try {
      const user = await this.ig.user.searchExact(username);
      return user;
    } catch (error) {
      this.log('ERROR', `❌ Error searching user ${username}:`, error.message);
      return null;
    }
  }

  async getThreadInfo(threadId) {
    try {
      const thread = await this.ig.feed.directThread({ thread_id: threadId }).request();
      return thread;
    } catch (error) {
      this.log('ERROR', `❌ Error getting thread info for ${threadId}:`, error.message);
      return null;
    }
  }

  async getMessageRequests() {
    try {
      const pendingResponse = await this.ig.feed.directPending().request();
      const threads = pendingResponse.inbox?.threads || [];
      this.log('INFO', `📬 Fetched ${threads.length} message requests`);
      return threads;
    } catch (error) {
      this.log('ERROR', 'Failed to fetch message requests:', error.message);
      return [];
    }
  }

  async approveMessageRequest(threadId) {
    if (!threadId) {
      this.log('WARN', '⚠️ approveMessageRequest called without threadId');
      return false;
    }
    try {
      await this.ig.directThread.approve(threadId);
      this.log('INFO', `✅ Successfully approved message request: ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `Failed to approve message request ${threadId}:`, error.message);
      return false;
    }
  }

  async startMessageRequestsMonitor(intervalMs = 300000) {
    if (this.messageRequestsMonitorInterval) {
      clearInterval(this.messageRequestsMonitorInterval);
      this.log('WARN', '🛑 Stopping existing message requests monitor before starting a new one.');
    }

    this.messageRequestsMonitorInterval = setInterval(async () => {
      if (this.isRunning) {
        try {
          const requests = await this.getMessageRequests();
          // Auto-approve if enabled
          if (config.followers?.autoAcceptRequests) {
            for (const request of requests) {
              await this.approveMessageRequest(request.thread_id);
              await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limiting
            }
          }
        } catch (error) {
          this.log('ERROR', 'Error in periodic message requests check:', error.message);
        }
      }
    }, intervalMs);

    this.log('INFO', `🕒 Started message requests monitor (checking every ${intervalMs / 1000 / 60} minutes)`);
  }

  async disconnect() {
    this.log('INFO', '🔌 Initiating graceful disconnect from Instagram...');
    this.isRunning = false;
    
    if (this.messageRequestsMonitorInterval) {
      clearInterval(this.messageRequestsMonitorInterval);
      this.messageRequestsMonitorInterval = null;
      this.log('INFO', '🕒 Message requests monitor stopped.');
    }

    try {
      if (this.ig.realtime && typeof this.ig.realtime.disconnect === 'function') {
        await this.ig.realtime.disconnect();
        this.log('INFO', '✅ Disconnected from Instagram realtime successfully');
      } else {
        this.log('WARN', '⚠️ Realtime client was not initialized or disconnect method not found');
      }
    } catch (disconnectError) {
      this.log('WARN', '⚠️ Error during disconnect:', disconnectError.message);
    }
  }
}

export { InstagramBot };