// instagram-bot.js (or your main bot file name)
import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions } from 'instagram_mqtt';
import { SkywalkerSubscriptions } from 'instagram_mqtt';
// Use fs.promises for async/await compatibility
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';
import camelcaseKeys from 'camelcase-keys'; // <-- Import for push notification parsing

class InstagramBot {
  constructor() {
    this.ig = withRealtime(new IgApiClient());
    this.messageHandlers = [];
    this.isRunning = false;
    this.lastMessageCheck = new Date(Date.now() - 60000); // Initialize to 1 min ago
    // Improved message deduplication using IDs
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;

    // --- Store for push notification context ---
    this.pushContext = {}; // Store thread_id, item_id, etc. from push notifications
    // --- End push context ---
  }

  log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`, ...args);
  }

  async login() {
    try {
      const username = config.instagram?.username;
      // password not used in current flow
      if (!username) {
        throw new Error('❌ INSTAGRAM_USERNAME is missing');
      }
      this.ig.state.generateDevice(username);
      let loginSuccess = false; // Flag to track successful login path
      // Step 1: Try session.json first
      try {
        await fs.access('./session.json'); // Use fs.promises
        this.log('INFO', '📂 Found session.json, trying to login from session...');
        const sessionData = JSON.parse(await fs.readFile('./session.json', 'utf-8')); // Use fs.promises
        await this.ig.state.deserialize(sessionData);
        // --- Add specific error handling for currentUser() ---
        try {
          await this.ig.account.currentUser(); // Validate session
          this.log('INFO', '✅ Logged in from session.json');
          loginSuccess = true;
        } catch (validationError) {
          this.log('WARN', '⚠️ Session validation failed:', validationError.message);
          // Fall through to cookie login if session is invalid
        }
        // --- End addition ---
      } catch (sessionAccessError) {
        this.log('INFO', '📂 session.json not found or invalid, trying cookies.json...', sessionAccessError.message);
        // Fall through to cookie login if session file access fails
      }
      // Step 2: Try cookies.json if session login wasn't successful
      if (!loginSuccess) {
        try {
          this.log('INFO', '📂 Attempting login using cookies.json...');
          await this.loadCookiesFromJson('./cookies.json');
          try {
            const currentUserResponse = await this.ig.account.currentUser();
            this.log('INFO', `✅ Logged in using cookies.json as @${currentUserResponse.username}`);
            loginSuccess = true;
            const session = await this.ig.state.serialize();
            delete session.constants;
            await fs.writeFile('./session.json', JSON.stringify(session, null, 2));
            this.log('INFO', '💾 session.json saved from cookie-based login');
          } catch (cookieValidationError) {
            this.log('ERROR', '❌ Failed to validate login using cookies.json:', cookieValidationError.message);
            this.log('DEBUG', 'Cookie validation error stack:', cookieValidationError.stack);
            // Continue to fresh login
          }
        } catch (cookieLoadError) {
          this.log('ERROR', '❌ Failed to load or process cookies.json:', cookieLoadError.message);
          this.log('DEBUG', 'Cookie loading error stack:', cookieLoadError.stack);
          // Continue to fresh login
        }
      }
      // Step 3: Fallback to fresh login using username & password if enabled
      if (!loginSuccess && config.instagram?.password) {
        try {
          this.log('INFO', '🔐 Attempting fresh login with username and password...');
          await this.ig.account.login(username, config.instagram.password);
          this.log('INFO', `✅ Fresh login successful as @${username}`);
          loginSuccess = true;
          const session = await this.ig.state.serialize();
          delete session.constants;
          await fs.writeFile('./session.json', JSON.stringify(session, null, 2));
          this.log('INFO', '💾 session.json saved after fresh login');
        } catch (loginError) {
          this.log('ERROR', '❌ Fresh login failed:', loginError.message);
          this.log('DEBUG', 'Fresh login error stack:', loginError.stack);
          throw new Error(`Fresh login failed: ${loginError.message}`);
        }
      }
      if (loginSuccess) {
        // --- Register handlers and connect AFTER successful login ---
        this.registerRealtimeHandlers(); // Register handlers
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
        // Optional: Final validation after connect? (currentUser should work now)
        // const user = await this.ig.account.currentUser();
        // this.log('INFO', `✅ Final connection check as @${user.username}`);
        this.isRunning = true;
        this.log('INFO', '🚀 Instagram bot is now running and listening for messages');
        // --- End registration and connection ---
      } else {
        throw new Error('No valid login method succeeded (session or cookies).');
      }
    } catch (error) {
      this.log('ERROR', '❌ Failed to initialize bot:', error.message);
      this.log('DEBUG', 'Initialization error stack:', error.stack); // Log stack trace
      // --- More specific error re-throwing ---
      if (error.message.includes('login') || error.message.includes('cookie') || error.message.includes('session')) {
        throw error; // Re-throw login/cookie/session specific errors
      } else {
        // Wrap unexpected errors
        throw new Error(`Unexpected error during initialization: ${error.message}`);
      }
      // --- End specific error re-throwing ---
    }
  }

  // Ensure fs.promises is used for async operations
  async loadCookiesFromJson(path = './cookies.json') {
    try {
      // Use fs.promises.readFile
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
          // Add expires if available in your cookie format
          // expires: cookie.expires ? new Date(cookie.expires) : undefined
        });
        // Use fs.promises for setCookie if needed (though cookieJar.setCookie might not be async)
        // Ensure the URL format is correct
        await this.ig.state.cookieJar.setCookie(
          toughCookie.toString(),
          `https://${toughCookie.domain}${toughCookie.path}`
        );
        cookiesLoaded++;
      }
      this.log('INFO', `🍪 Successfully loaded ${cookiesLoaded}/${cookies.length} cookies from file`);
    } catch (error) {
      this.log('ERROR', `❌ Critical error loading cookies from ${path}:`, error.message);
      this.log('DEBUG', `Cookie loading error details:`, error.stack);
      throw error; // Re-throw to stop the login process
    }
  }

  registerRealtimeHandlers() {
    this.log('INFO', '📡 Registering real-time event handlers...');

    // --- Core Message Handling (Your original logic) ---
    // Main message handler for direct messages wrapped in realtime protocol
    this.ig.realtime.on('message', async (data) => {
      try {
        this.log('DEBUG', '📨 [Realtime] Raw message event data received'); // More specific debug log
        if (!data.message) {
          this.log('WARN', '⚠️ No message payload in event data');
          return;
        }
        // Use improved deduplication (potentially enhanced by push context)
        // --- Modified call to pass thread_id ---
        if (!this.isNewMessageById(data.message.item_id, data.message.thread_id)) {
          this.log('DEBUG', `⚠️ Message ${data.message.item_id} filtered as duplicate (by ID or Push Context)`);
          return;
        }
        // --- End modification ---
        this.log('INFO', '✅ Processing new message (by ID)...');
        await this.handleMessage(data.message, data);
      } catch (err) {
        this.log('ERROR', '❌ Critical error in main message handler:', err.message);
        // Consider adding more context like the raw data if helpful for debugging
        // this.log('DEBUG', 'Raw data:', JSON.stringify(data, null, 2));
      }
    });
    // Handler for other direct message related events (might overlap with 'message')
    this.ig.realtime.on('direct', async (data) => {
      try {
        this.log('DEBUG', '📨 [Realtime] Raw direct event data received');
        // Check if the direct event *also* contains a message payload
        if (data.message) {
          // Apply deduplication here too (potentially enhanced by push context)
          // --- Modified call to pass thread_id ---
          if (!this.isNewMessageById(data.message.item_id, data.message.thread_id)) {
            this.log('DEBUG', `⚠️ Direct message ${data.message.item_id} filtered as duplicate (by ID or Push Context)`);
            return;
          }
          // --- End modification ---
          this.log('INFO', '✅ Processing new direct message (by ID)...');
          await this.handleMessage(data.message, data); // Process if it's a new message
        } else {
          // Handle other direct events that are NOT message payloads
          this.log('INFO', 'ℹ️ Received non-message direct event');
          this.log('DEBUG', 'Direct event details:', JSON.stringify(data, null, 2));
          // Add specific logic for non-message direct events if needed
        }
      } catch (err) {
        this.log('ERROR', '❌ Critical error in direct handler:', err.message);
      }
    });

    // --- Push Notification Handling (FBNS) ---
    this.log('INFO', '🔔 Setting up FBNS (Push Notification) listener...');
    this.ig.realtime.on('push', async (data) => { // <-- Add this 'push' listener
      try {
        this.log('INFO', '🔔 [Push] FBNS Push notification received');
        // this.log('DEBUG', 'Push notification ', JSON.stringify(data, null, 2)); // Uncomment for full details

        // --- Process the Push Notification (Similar to push.example.ts) ---
        // Use camelcaseKeys to convert snake_case keys to camelCase for easier JS access
        const { collapseKey, payload } = camelcaseKeys(data, { deep: true });

        // Check if it's a direct message notification
        if (collapseKey === 'direct_v2_message') {
          this.log('INFO', '🔔 [Push] Identified as Direct Message notification');

          // Extract thread_id and item_id from the payload string
          const threadIdMatch = payload?.match?.(/thread_id=(\d+)/);
          const itemIdMatch = payload?.match?.(/item_id=([^&]+)/); // Capture until next '&'

          const threadId = threadIdMatch?.[1];
          const itemId = itemIdMatch?.[1];

          this.log('INFO', `🔔 [Push] Extracted - Thread ID: ${threadId}, Item ID: ${itemId}`);

          if (threadId && itemId) {
            // --- Store Context for Deduplication ---
            if (!this.pushContext[threadId]) {
              this.pushContext[threadId] = new Set();
            }
            this.pushContext[threadId].add(itemId);

            // Simple cleanup: Clear context if it gets too large (basic memory management)
            if (Object.keys(this.pushContext).length > 100) { // Arbitrary limit
              this.pushContext = {};
              this.log('DEBUG', '🧹 [Push] Cleared push context cache (size limit)');
            }
            // --- End Store Context ---

            this.log('INFO', `🔔 [Push] Awaiting 'message'/'direct' event for T:${threadId} I:${itemId}`);

          } else {
            this.log('WARN', '🔔 [Push] Could not extract thread_id or item_id from payload');
            // this.log('DEBUG', 'Payload snippet:', payload?.substring(0, 200)); // Uncomment for payload debugging
          }
        } else {
          this.log('INFO', `🔔 [Push] Received non-direct message push notification. Collapse Key: ${collapseKey}`);
          // Handle other types of pushes if necessary (e.g., activity)
          if (collapseKey === 'consolidated_notification_ig' || collapseKey?.startsWith('notification')) {
            this.ig.realtime.emit('activity', data); // Forward to existing 'activity' handler
            this.log('INFO', '🔔 [Push] Forwarded potential activity notification.');
          }
        }
        // --- End Process Push Notification ---
      } catch (pushError) {
        this.log('ERROR', '❌ Error processing push notification:', pushError.message);
        // this.log('DEBUG', 'Push error stack:', pushError.stack); // Uncomment for error debugging
        // Don't let push errors crash the handler
      }
    });
    this.log('INFO', '🔔 FBNS (Push Notification) listener setup complete.');
    // --- End Push Notification Handling ---

    // --- Additional Event Listeners (From example & useful additions) ---
    // Catches raw data for topics that might not have specific handlers
    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      // Log relevant topics, reduce verbosity of others if needed
      if (topicStr.includes('direct') || topicStr.includes('message') || topicStr.includes('iris')) {
        this.log('DEBUG', `📥 [Realtime] Received on topic: ${topicStr}`);
        // Optionally log message summaries without full content for less clutter
        // messages.forEach((msg, index) => this.log('TRACE', `  Message ${index}:`, msg ? msg.toString().substring(0, 100) + '...' : 'null'));
      } else {
        // Log less critical topics at a lower level or less frequently
        this.log('TRACE', `📥 [Realtime] Received on other topic: ${topicStr}`);
      }
    });
    // General error handler for the realtime connection
    this.ig.realtime.on('error', (err) => {
      this.log('ERROR', '🚨 Realtime connection error:', err.message || err);
      // Could trigger reconnection logic here if needed
    });
    // Handler for when the connection closes
    this.ig.realtime.on('close', () => {
      this.log('WARN', '🔌 Realtime connection closed');
      this.isRunning = false; // Update state
      // Could trigger reconnection logic here
    });
    // --- Specific Feature Event Listeners ---
    // Thread structure updates (e.g., members added/removed, admin changes)
    this.ig.realtime.on('threadUpdate', (data) => {
      this.log('INFO', '🧵 Thread update event received');
      this.log('DEBUG', 'Thread update details:', JSON.stringify(data, null, 2));
      // Add logic to handle thread changes if needed by your bot
    });
    // Fallback for subscription events that don't have specific handlers
    this.ig.realtime.on('realtimeSub', (data) => {
      this.log('INFO', '🔄 Generic realtime subscription event received');
      this.log('DEBUG', 'RealtimeSub details:', JSON.stringify(data, null, 2));
    });
    // User presence/online status updates (requires getAppPresenceSubscription)
    this.ig.realtime.on('presence', (data) => {
      this.log('INFO', '👤 Presence update event received');
      this.log('DEBUG', 'Presence details:', JSON.stringify(data, null, 2));
      // Example: Update user status in your bot's memory
    });
    // Typing indicators in DMs (requires getDirectTypingSubscription)
    this.ig.realtime.on('typing', (data) => {
      this.log('INFO', '⌨️ Typing indicator event received');
      this.log('DEBUG', 'Typing details:', JSON.stringify(data, null, 2));
      // Example: Send "X is typing..." to your bot's interface
    });
    // Message status updates (e.g., read receipts) (requires getDirectStatusSubscription)
    this.ig.realtime.on('messageStatus', (data) => {
      this.log('INFO', '📊 Message status update event received');
      this.log('DEBUG', 'MessageStatus details:', JSON.stringify(data, null, 2));
      // Example: Update message status in your UI/logs
    });
    // Live stream related notifications (requires liveSub)
    this.ig.realtime.on('liveNotification', (data) => {
      this.log('INFO', '📺 Live stream notification event received');
      this.log('DEBUG', 'LiveNotification details:', JSON.stringify(data, null, 2));
      // Example: Alert about a user going live
    });
    // General activity notifications (likes, comments, follows) - check if this is the correct event name
    this.ig.realtime.on('activity', (data) => {
      this.log('INFO', '⚡ Activity notification event received');
      this.log('DEBUG', 'Activity details:', JSON.stringify(data, null, 2));
      // Example: Notify about interactions
    });
    // --- Connection Lifecycle Events ---
    this.ig.realtime.on('connect', () => {
      this.log('INFO', '🔗 Realtime connection successfully established');
      // Add this line to indicate FBNS is part of the active connection
      this.log('INFO', '✅ Bot connected with FBNS (Push Notifications) support');
      this.isRunning = true; // Update state on successful connect/reconnect
    });
    this.ig.realtime.on('reconnect', () => {
      this.log('INFO', '🔁 Realtime client is attempting to reconnect');
      // Optionally add a similar log line for reconnection if desired
      // this.log('INFO', '🔁 Reconnecting with FBNS support...');
    });
    // --- Debugging Events ---
    this.ig.realtime.on('debug', (data) => {
      // Use a lower log level for verbose debugging info
      this.log('TRACE', '🐛 Realtime debug info:', data);
    });
    // Add any other specific handlers you find useful from the library docs
  }

  // Improved deduplication using message ID and enhanced with Push Context
  // --- Modified signature to accept threadId ---
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

  // --- Methods for Missing Features from Example ---
  // Subscribe to live comments on a specific broadcast
  async subscribeToLiveComments(broadcastId) {
    if (!broadcastId) {
      this.log('WARN', '⚠️ subscribeToLiveComments called without broadcastId');
      return false;
    }
    try {
      await this.ig.realtime.graphQlSubscribe(
        GraphQLSubscriptions.getLiveRealtimeCommentsSubscription(broadcastId)
      );
      this.log('INFO', `📺 Successfully subscribed to live comments for broadcast: ${broadcastId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `Failed to subscribe to live comments for ${broadcastId}:`, error.message);
      return false;
    }
  }

  // Simulate app/device foreground/background state
  async setForegroundState(inApp = true, inDevice = true, timeoutSeconds = 60) {
    // Validate inputs if necessary
    const timeout = inApp ? Math.max(10, timeoutSeconds) : 900; // Enforce min timeout for app
    try {
      await this.ig.realtime.direct.sendForegroundState({
        inForegroundApp: Boolean(inApp),
        inForegroundDevice: Boolean(inDevice),
        keepAliveTimeout: timeout,
      });
      this.log('INFO', `📱 Foreground state set: App=${Boolean(inApp)}, Device=${Boolean(inDevice)}, Timeout=${timeout}s`);
      return true;
    } catch (error) {
      this.log('ERROR', 'Failed to set foreground state:', error.message);
      return false;
    }
  }

  // Demonstrate foreground/background simulation
  async simulateDeviceToggle() {
    this.log('INFO', '📱 Starting device simulation: Turning OFF...');
    const offSuccess = await this.setForegroundState(false, false, 900);
    if (!offSuccess) {
      this.log('WARN', '📱 Simulation step 1 (device off) might have failed.');
    }
    // Use a longer timeout for realistic simulation
    setTimeout(async () => {
      this.log('INFO', '📱 Simulation: Turning device back ON...');
      const onSuccess = await this.setForegroundState(true, true, 60);
      if (!onSuccess) {
        this.log('WARN', '📱 Simulation step 2 (device on) might have failed.');
      } else {
        this.log('INFO', '📱 Device simulation cycle completed.');
      }
    }, 5000); // 5 seconds for demo, increase for real usage
  }

  // --- Message Requests Handling ---
  async getMessageRequests() {
    try {
      const pendingResponse = await this.ig.feed.directPending().request();
      const threads = pendingResponse.inbox?.threads || [];
      this.log('INFO', `📬 Fetched ${threads.length} message requests`);
      return threads;
    } catch (error) {
      this.log('ERROR', 'Failed to fetch message requests:', error.message);
      // Return empty array on error to prevent breaking callers
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

  async declineMessageRequest(threadId) {
    if (!threadId) {
      this.log('WARN', '⚠️ declineMessageRequest called without threadId');
      return false;
    }
    try {
      await this.ig.directThread.decline(threadId);
      this.log('INFO', `❌ Successfully declined message request: ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `Failed to decline message request ${threadId}:`, error.message);
      return false;
    }
  }

  // Start monitoring message requests periodically
  async startMessageRequestsMonitor(intervalMs = 300000) { // Default 5 minutes
    if (this.messageRequestsMonitorInterval) {
      clearInterval(this.messageRequestsMonitorInterval);
      this.log('WARN', '🛑 Stopping existing message requests monitor before starting a new one.');
    }
    this.messageRequestsMonitorInterval = setInterval(async () => {
      if (this.isRunning) { // Only check if bot is considered running
        try {
          const requests = await this.getMessageRequests();
          // The getMessageRequests method already logs the count
          // Add specific logic here if you want to auto-approve/decline based on rules
        } catch (error) {
          // Error is logged inside getMessageRequests, but monitor loop continues
          this.log('ERROR', 'Error in periodic message requests check:', error.message);
        }
      }
    }, intervalMs);
    this.log('INFO', `🕒 Started message requests monitor (checking every ${intervalMs / 1000 / 60} minutes)`);
  }

  // --- Connection Management ---
  async disconnect() {
    this.log('INFO', '🔌 Initiating graceful disconnect from Instagram...');
    this.isRunning = false; // Immediately mark as not running

    // --- Clear Push Context on Disconnect ---
    this.pushContext = {}; // Clear push context on disconnect
    this.log('DEBUG', '🧹 [Push] Cleared push context on disconnect.');
    // --- End Clear Push Context ---

    // Clear the message requests monitor if it exists
    if (this.messageRequestsMonitorInterval) {
      clearInterval(this.messageRequestsMonitorInterval);
      this.messageRequestsMonitorInterval = null;
      this.log('INFO', '🕒 Message requests monitor stopped.');
    }
    try {
      // Inform Instagram the "app" is going to background before disconnecting
      this.log('DEBUG', '📱 Setting foreground state to background before disconnect...');
      await this.setForegroundState(false, false, 900); // Ignore result, proceed with disconnect
    } catch (stateError) {
      this.log('WARN', '⚠️ Error setting background state before disconnect:', stateError.message);
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
      // Don't re-throw, as we are shutting down
    }
  }
}

// Main execution logic
async function main() {
  let bot;
  try {
    bot = new InstagramBot();
    await bot.login(); // ✅ Login with cookies or credentials
    // ✅ Load all modules
    const moduleManager = new ModuleManager(bot);
    await moduleManager.loadModules();
    // ✅ Setup message handler
    const messageHandler = new MessageHandler(bot, moduleManager, null); // Assuming null is okay for the third arg
    // ✅ Route incoming messages to the handler
    bot.onMessage((message) => messageHandler.handleMessage(message));
    // ✅ Start monitoring message requests
    await bot.startMessageRequestsMonitor(); // Use default interval
    console.log('🚀 Bot is running with full module support. Type .help or use your commands.');
    // ✅ Periodic heartbeat/status log (more frequent for debugging, can be longer)
    setInterval(() => {
      console.log(`💓 [${new Date().toISOString()}] Bot heartbeat - Running: ${bot.isRunning}`); // Simplified heartbeat
    }, 300000); // Every 5 minutes
    // ✅ Graceful shutdown handling
    const shutdownHandler = async () => {
      console.log('\n👋 [SIGINT/SIGTERM] Shutting down gracefully...');
      if (bot) {
        await bot.disconnect();
      }
      console.log('🛑 Shutdown complete.');
      process.exit(0);
    };
    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler); // Handle termination signals
  } catch (error) {
    console.error('❌ Bot failed to start:', error.message);
    // Attempt cleanup if bot was partially initialized
    if (bot) {
      try {
        await bot.disconnect();
      } catch (disconnectError) {
        console.error('❌ Error during cleanup disconnect:', disconnectError.message);
      }
    }
    process.exit(1);
  }
}

// Run main only if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Unhandled error in main execution:', error.message);
    process.exit(1);
  });
}

// Export for external usage
export { InstagramBot };
