import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { connectDb } from '../utils/db.js';

export class FollowersRealtimeModule extends EventEmitter {
  constructor(instagramClient) {
    super();
    this.instagramClient = instagramClient;
    this.name = 'followers';
    this.description = 'Real-time followers management with event-based automation';
    
    this.db = null;
    this.collection = null;
    this.followersCache = new Map();
    this.followingCache = new Map();
    this.followQueue = [];
    this.isProcessingQueue = false;
    this.followCount = 0;
    this.followResetTime = Date.now() + 3600000;
    
    this.commands = {};
    this.setupCommands();
    this.initializeDatabase();
    this.setupEventListeners();
  }

  async initializeDatabase() {
    try {
      this.db = await connectDb();
      this.collection = this.db.collection('followers_realtime');
      await this.loadInitialData();
    } catch (error) {
      logger.error('Failed to initialize followers database:', error.message);
    }
  }

  async loadInitialData() {
    try {
      // Load current followers and following only once at startup
      const followers = await this.instagramClient.getFollowers();
      const following = await this.instagramClient.getFollowing();
      
      followers.forEach(user => {
        this.followersCache.set(user.pk.toString(), {
          username: user.username,
          fullName: user.full_name,
          isPrivate: user.is_private,
          followedAt: new Date()
        });
      });

      following.forEach(user => {
        this.followingCache.set(user.pk.toString(), {
          username: user.username,
          fullName: user.full_name,
          followedAt: new Date()
        });
      });

      logger.info(`📊 Loaded ${followers.length} followers and ${following.length} following to cache`);
    } catch (error) {
      logger.error('Error loading initial followers data:', error.message);
    }
  }

  setupEventListeners() {
    // Listen for new followers in real-time (no polling!)
    this.instagramClient.on('newFollower', async (user) => {
      await this.handleNewFollower(user);
    });

    // Listen for user followed events
    this.instagramClient.on('userFollowed', async (userId) => {
      await this.handleUserFollowed(userId);
    });

    // Listen for user unfollowed events
    this.instagramClient.on('userUnfollowed', async (userId) => {
      await this.handleUserUnfollowed(userId);
    });

    // Listen for follow request approved events
    this.instagramClient.on('followRequestApproved', async (userId) => {
      await this.handleFollowRequestApproved(userId);
    });

    // Listen for message request approved events
    this.instagramClient.on('messageRequestApproved', async (threadId) => {
      await this.handleMessageRequestApproved(threadId);
    });

    // Process follow queue periodically (but only when needed)
    setInterval(() => {
      if (this.followQueue.length > 0) {
        this.processFollowQueue();
      }
    }, 30000); // Check every 30 seconds

    logger.info('🎯 Real-time followers event listeners setup complete');
  }

  setupCommands() {
    this.commands['followers'] = {
      handler: this.handleFollowersCommand.bind(this),
      description: 'Show followers statistics',
      usage: '.followers',
      adminOnly: false
    };

    this.commands['following'] = {
      handler: this.handleFollowingCommand.bind(this),
      description: 'Show following statistics',
      usage: '.following',
      adminOnly: false
    };

    this.commands['follow'] = {
      handler: this.handleFollowCommand.bind(this),
      description: 'Follow a user by username',
      usage: '.follow <username>',
      adminOnly: true
    };

    this.commands['unfollow'] = {
      handler: this.handleUnfollowCommand.bind(this),
      description: 'Unfollow a user by username',
      usage: '.unfollow <username>',
      adminOnly: true
    };

    this.commands['autofollow'] = {
      handler: this.handleAutoFollowCommand.bind(this),
      description: 'Toggle auto follow back',
      usage: '.autofollow [on|off]',
      adminOnly: true
    };

    this.commands['autorequests'] = {
      handler: this.handleAutoRequestsCommand.bind(this),
      description: 'Toggle auto accept follow requests',
      usage: '.autorequests [on|off]',
      adminOnly: true
    };

    this.commands['automessage'] = {
      handler: this.handleAutoMessageCommand.bind(this),
      description: 'Toggle auto message new followers',
      usage: '.automessage [on|off]',
      adminOnly: true
    };

    this.commands['requests'] = {
      handler: this.handleRequestsCommand.bind(this),
      description: 'Show pending follow requests',
      usage: '.requests',
      adminOnly: true
    };

    this.commands['msgrequests'] = {
      handler: this.handleMessageRequestsCommand.bind(this),
      description: 'Show pending message requests',
      usage: '.msgrequests',
      adminOnly: true
    };
  }

  getCommands() {
    return this.commands;
  }

  async process(message) {
    return message;
  }

  // Real-time event handlers (NO POLLING!)
  async handleNewFollower(user) {
    try {
      const userId = user.id;
      
      // Check if already in cache (avoid duplicates)
      if (this.followersCache.has(userId)) {
        return;
      }

      // Add to cache
      this.followersCache.set(userId, {
        username: user.username,
        fullName: user.fullName,
        isPrivate: user.isPrivate,
        followedAt: new Date()
      });

      logger.info(`👤 New follower detected: @${user.username}`);

      // Auto follow back if enabled
      if (config.followers.autoFollowBack && !this.followingCache.has(userId)) {
        await this.queueFollow(userId, user.username);
      }

      // Auto message new follower if enabled
      if (config.followers.autoMessageNewFollowers) {
        try {
          // Create or get private chat
          const privateChat = await user.fetchPrivateChat();
          if (privateChat) {
            await privateChat.sendMessage(config.followers.welcomeMessage);
            logger.info(`💬 Sent welcome message to @${user.username}`);
          }
        } catch (error) {
          logger.error(`Failed to send welcome message to @${user.username}:`, error.message);
        }
      }

      // Save to database
      if (this.collection) {
        try {
          await this.collection.insertOne({
            type: 'new_follower',
            userId: userId,
            username: user.username,
            fullName: user.fullName,
            timestamp: new Date()
          });
        } catch (error) {
          logger.error('Error saving new follower to database:', error.message);
        }
      }

      // Emit event for other modules
      this.emit('newFollower', user);

    } catch (error) {
      logger.error('Error handling new follower:', error.message);
    }
  }

  async handleUserFollowed(userId) {
    try {
      // Get user info and add to following cache
      const userInfo = await this.instagramClient.getUserInfo(userId);
      if (userInfo) {
        this.followingCache.set(userId, {
          username: userInfo.username,
          fullName: userInfo.full_name,
          followedAt: new Date()
        });
        logger.info(`➡️ Now following @${userInfo.username}`);
      }
    } catch (error) {
      logger.error('Error handling user followed event:', error.message);
    }
  }

  async handleUserUnfollowed(userId) {
    try {
      const userInfo = this.followingCache.get(userId);
      this.followingCache.delete(userId);
      logger.info(`❌ Unfollowed @${userInfo?.username || userId}`);
    } catch (error) {
      logger.error('Error handling user unfollowed event:', error.message);
    }
  }

  async handleFollowRequestApproved(userId) {
    try {
      logger.info(`✅ Follow request approved for user ${userId}`);
      // The user will be added to followers cache when they actually follow
    } catch (error) {
      logger.error('Error handling follow request approved:', error.message);
    }
  }

  async handleMessageRequestApproved(threadId) {
    try {
      logger.info(`✅ Message request approved for thread ${threadId}`);
    } catch (error) {
      logger.error('Error handling message request approved:', error.message);
    }
  }

  // Command handlers
  async handleFollowersCommand(args, message) {
    const followersCount = this.followersCache.size;
    const followingCount = this.followingCache.size;
    
    const stats = `👥 **Followers Statistics**\n\n` +
      `👤 Followers: ${followersCount}\n` +
      `➡️ Following: ${followingCount}\n` +
      `🔄 Auto Follow Back: ${config.followers.autoFollowBack ? 'ON' : 'OFF'}\n` +
      `✅ Auto Accept Requests: ${config.followers.autoAcceptRequests ? 'ON' : 'OFF'}\n` +
      `💬 Auto Message: ${config.followers.autoMessageNewFollowers ? 'ON' : 'OFF'}\n` +
      `⏳ Follow Queue: ${this.followQueue.length} pending`;

    await this.sendReply(message, stats);
  }

  async handleFollowingCommand(args, message) {
    const following = Array.from(this.followingCache.values())
      .slice(0, 10)
      .map(user => `• @${user.username}`)
      .join('\n');

    const response = `➡️ **Following (${this.followingCache.size} total)**\n\n` +
      `${following || 'No one followed yet'}\n\n` +
      `${this.followingCache.size > 10 ? '...and more' : ''}`;

    await this.sendReply(message, response);
  }

  async handleFollowCommand(args, message) {
    if (!args[0]) {
      await this.sendReply(message, '❌ Please provide a username');
      return;
    }

    const username = args[0].replace('@', '');
    
    try {
      const user = await this.instagramClient.searchUser(username);
      if (!user) {
        await this.sendReply(message, `❌ User @${username} not found`);
        return;
      }

      if (this.followingCache.has(user.pk.toString())) {
        await this.sendReply(message, `ℹ️ Already following @${username}`);
        return;
      }

      const success = await this.instagramClient.followUser(user.pk);
      if (success) {
        await this.sendReply(message, `✅ Successfully followed @${username}`);
      } else {
        await this.sendReply(message, `❌ Failed to follow @${username}`);
      }
    } catch (error) {
      await this.sendReply(message, `❌ Error: ${error.message}`);
    }
  }

  async handleUnfollowCommand(args, message) {
    if (!args[0]) {
      await this.sendReply(message, '❌ Please provide a username');
      return;
    }

    const username = args[0].replace('@', '');
    
    try {
      const user = await this.instagramClient.searchUser(username);
      if (!user) {
        await this.sendReply(message, `❌ User @${username} not found`);
        return;
      }

      if (!this.followingCache.has(user.pk.toString())) {
        await this.sendReply(message, `ℹ️ Not following @${username}`);
        return;
      }

      const success = await this.instagramClient.unfollowUser(user.pk);
      if (success) {
        await this.sendReply(message, `✅ Successfully unfollowed @${username}`);
      } else {
        await this.sendReply(message, `❌ Failed to unfollow @${username}`);
      }
    } catch (error) {
      await this.sendReply(message, `❌ Error: ${error.message}`);
    }
  }

  async handleAutoFollowCommand(args, message) {
    const action = args[0]?.toLowerCase();
    
    if (action === 'on') {
      config.followers.autoFollowBack = true;
      await this.sendReply(message, '✅ Auto follow back enabled');
    } else if (action === 'off') {
      config.followers.autoFollowBack = false;
      await this.sendReply(message, '❌ Auto follow back disabled');
    } else {
      const status = config.followers.autoFollowBack ? 'ON' : 'OFF';
      await this.sendReply(message, `🔄 Auto follow back is currently: ${status}`);
    }
  }

  async handleAutoRequestsCommand(args, message) {
    const action = args[0]?.toLowerCase();
    
    if (action === 'on') {
      config.followers.autoAcceptRequests = true;
      await this.sendReply(message, '✅ Auto accept requests enabled');
      // Start processing existing requests
      this.processFollowRequests();
    } else if (action === 'off') {
      config.followers.autoAcceptRequests = false;
      await this.sendReply(message, '❌ Auto accept requests disabled');
    } else {
      const status = config.followers.autoAcceptRequests ? 'ON' : 'OFF';
      await this.sendReply(message, `✅ Auto accept requests is currently: ${status}`);
    }
  }

  async handleAutoMessageCommand(args, message) {
    const action = args[0]?.toLowerCase();
    
    if (action === 'on') {
      config.followers.autoMessageNewFollowers = true;
      await this.sendReply(message, '✅ Auto message new followers enabled');
    } else if (action === 'off') {
      config.followers.autoMessageNewFollowers = false;
      await this.sendReply(message, '❌ Auto message new followers disabled');
    } else {
      const status = config.followers.autoMessageNewFollowers ? 'ON' : 'OFF';
      await this.sendReply(message, `💬 Auto message new followers is currently: ${status}`);
    }
  }

  async handleRequestsCommand(args, message) {
    try {
      const requests = await this.instagramClient.getPendingFollowRequests();
      
      if (requests.length === 0) {
        await this.sendReply(message, '📭 No pending follow requests');
        return;
      }

      const requestsList = requests.slice(0, 10)
        .map(user => `• @${user.username} (${user.full_name || 'No name'})`)
        .join('\n');

      const response = `📬 **Pending Follow Requests (${requests.length})**\n\n` +
        `${requestsList}\n\n` +
        `${requests.length > 10 ? '...and more\n\n' : ''}` +
        `Use .autorequests on to auto-accept`;

      await this.sendReply(message, response);
    } catch (error) {
      await this.sendReply(message, `❌ Error getting requests: ${error.message}`);
    }
  }

  async handleMessageRequestsCommand(args, message) {
    try {
      const requests = await this.instagramClient.getMessageRequests();
      
      if (requests.length === 0) {
        await this.sendReply(message, '📭 No pending message requests');
        return;
      }

      const requestsList = requests.slice(0, 10)
        .map(thread => {
          const user = thread.users?.[0];
          return `• @${user?.username || 'Unknown'} - "${thread.last_permanent_item?.text || 'Media message'}"`;
        })
        .join('\n');

      const response = `📬 **Pending Message Requests (${requests.length})**\n\n` +
        `${requestsList}\n\n` +
        `${requests.length > 10 ? '...and more' : ''}`;

      await this.sendReply(message, response);
    } catch (error) {
      await this.sendReply(message, `❌ Error getting message requests: ${error.message}`);
    }
  }

  // Queue management (rate-limited)
  async queueFollow(userId, username) {
    this.followQueue.push({ userId, username, timestamp: Date.now() });
    logger.debug(`📝 Queued follow for @${username}`);
  }

  async processFollowQueue() {
    if (this.isProcessingQueue || this.followQueue.length === 0) return;
    
    // Reset follow count every hour
    if (Date.now() > this.followResetTime) {
      this.followCount = 0;
      this.followResetTime = Date.now() + 3600000;
    }

    // Check rate limit
    if (this.followCount >= config.followers.maxFollowsPerHour) {
      logger.debug('Follow rate limit reached, waiting...');
      return;
    }

    this.isProcessingQueue = true;

    try {
      const followItem = this.followQueue.shift();
      if (followItem) {
        const success = await this.instagramClient.followUser(followItem.userId);
        if (success) {
          this.followCount++;
          logger.info(`🤖 Auto-followed @${followItem.username} (${this.followCount}/${config.followers.maxFollowsPerHour})`);
        }

        // Random delay between follows
        const delay = Math.random() * (config.followers.followDelay.max - config.followers.followDelay.min) + config.followers.followDelay.min;
        await this.delay(delay);
      }
    } catch (error) {
      logger.error('Error processing follow queue:', error.message);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  // Process follow requests (only when auto-accept is enabled)
  async processFollowRequests() {
    if (!config.followers.autoAcceptRequests) return;

    try {
      const requests = await this.instagramClient.getPendingFollowRequests();
      
      for (const request of requests) {
        const success = await this.instagramClient.approveFollowRequest(request.pk);
        if (success) {
          logger.info(`🤖 Auto-approved follow request from @${request.username}`);
        }
        
        // Small delay to avoid rate limiting
        await this.delay(2000);
      }
    } catch (error) {
      logger.error('Error processing follow requests:', error.message);
    }
  }

  async sendReply(message, text) {
    return await this.instagramClient.sendMessage(message.threadId, text);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup() {
    logger.info('Cleaning up followers realtime module...');
    this.followQueue = [];
    this.followersCache.clear();
    this.followingCache.clear();
  }
}