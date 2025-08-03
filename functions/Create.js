const { withRealtime, withFbns,withFbnsAndRealtime } = require('instagram_mqtt')
// const { GraphQLSubscriptions, SkywalkerSubscriptions } = require('instagram_mqtt/dist/realtime/subscriptions')
const { IgApiClient } = require('instagram-private-api')
const { EventEmitter } = require('events')
const Collection = require('@discordjs/collection')

const Util = require('./Util')
const {existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync} = require('fs')
const ClientUser = require('./ClientUser')
const Message = require('./Message')
const Chat = require('./Chat')
const User = require('./User')

/**
 * Client, the main hub for interacting with the Instagram API.
 * @extends {EventEmitter}
 */
class Client extends EventEmitter {
    /**
     * @typedef {object} ClientOptions
     * @property {boolean} disableReplyPrefix Whether the bot should disable user mention for the Message#reply() method
     */
    /**
     * @param {ClientOptions} options
     */
    constructor (options) {
        super()
        /**
         * @type {?ClientUser}
         * The bot's user object.
         */
        this.user = null
        /**
         * @type {?IgApiClient}
         * @private
         */
        this.ig = null
        /**
         * @type {boolean}
         * Whether the bot is connected and ready.
         */
        this.ready = false
        /**
         * @type {ClientOptions}
         * The options for the client.
         */
        this.options = options || {}

        /**
         * @typedef {Object} Cache
         * @property {Collection<string, Message>} messages The bot's messages cache.
         * @property {Collection<string, User>} users The bot's users cache.
         * @property {Collection<string, Chat>} chats The bot's chats cache.
         * @property {Collection<string, Chat>} pendingChats The bot's pending chats cache.
         */
        /**
         * @type {Cache}
         * The bot's cache.
         */
        this.cache = {
            messages: new Collection(),
            users: new Collection(),
            chats: new Collection(),
            pendingChats: new Collection()
        }

        /**
         * @type {...any[]}
         */
        this.eventsToReplay = []
    }

    /**
     * Create a new user or patch the cache one with the payload
     * @private
     * @param {string} userID The ID of the user to patch
     * @param {object} userPayload The data of the user
     * @returns {User}
     */
    _patchOrCreateUser (userID, userPayload) {
        if (this.cache.users.has(userID)) {
            this.cache.users.get(userID)._patch(userPayload)
        } else {
            this.cache.users.set(userID, new User(this, userPayload))
        }
        return this.cache.users.get(userID)
    }

    /**
     * Create a chat (or return the existing one) between one (a dm chat) or multiple users (a group).
     * @param {string[]} userIDs The users to include in the group
     * @returns {Promise<Chat>} The created chat
     */
    async createChat (userIDs) {
        const threadPayload = await this.ig.direct.createGroupThread(userIDs)
        const chat = new Chat(this, threadPayload.thread_id, threadPayload)
        this.cache.chats.set(chat.id, chat)
        return chat
    }

    /**
     * Fetch a chat and cache it.
     * @param {string} query The ID of the chat to fetch.
     * @param {boolean} [force=false] Whether the cache should be ignored
     * @returns {Promise<Chat>}
     *
     * @example
     * client.fetchChat('340282366841710300949128114477310087639').then((chat) => {
     *   chat.sendMessage('Hey!');
     * });
     */
    async fetchChat (chatID, force = false) {
        if (!this.cache.chats.has(chatID)) {
            const { thread: chatPayload } = await this.ig.feed.directThread({ thread_id: chatID }).request()
            const chat = new Chat(this, chatID, chatPayload)
            this.cache.chats.set(chatID, chat)
        } else {
            if (force) {
                const { thread: chatPayload } = await this.ig.feed.directThread({ thread_id: chatID }).request()
                this.cache.chats.get(chatID)._patch(chatPayload)
            }
        }
        return this.cache.chats.get(chatID)
    }

    /**
     * Fetch a user and cache it.
     * @param {string} query The ID or the username of the user to fetch.
     * @param {boolean} [force=false] Whether the cache should be ignored
     * @returns {Promise<User>}
     *
     * @example
     * client.fetchUser('pronote_bot').then((user) => {
     *   user.follow();
     * });
     */
    async fetchUser (query, force = false) {
        const userID = Util.isID(query) ? query : await this.ig.user.getIdByUsername(query)
        if (!this.cache.users.has(userID)) {
            const userPayload = await this.ig.user.info(userID)
            const user = new User(this, userPayload)
            this.cache.users.set(userID, user)
        } else {
            if (force) {
                const userPayload = await this.ig.user.info(userID)
                this.cache.users.get(userID)._patch(userPayload)
            }
        }
        return this.cache.users.get(userID)
    }

    /**
     * Handle Realtime messages
     * @param {object} topic
     * @param {object} payload
     * @private
     */
    handleRealtimeReceive (topic, payload) {
        if (!this.ready) {
            this.eventsToReplay.push([
                'realtime',
                topic,
                payload
            ])
            return
        }
        this.emit('rawRealtime', topic, payload)
        if (topic.id === '146') {
            const rawMessages = JSON.parse(payload)
            rawMessages.forEach(async (rawMessage) => {
                rawMessage.data.forEach((data) => {
                    // Emit right event
                    switch (data.op) {
                    case 'replace': {
                        const isInboxThreadPath = Util.matchInboxThreadPath(data.path, false)
                        if (isInboxThreadPath) {
                            const [ threadID ] = Util.matchInboxThreadPath(data.path, true)
                            if (this.cache.chats.has(threadID)) {
                                const chat = this.cache.chats.get(threadID)
                                const oldChat = Object.assign(Object.create(chat), chat)
                                this.cache.chats.get(threadID)._patch(JSON.parse(data.value))

                                /* Compare name */
                                if (oldChat.name !== chat.name) {
                                    this.emit('chatNameUpdate', chat, oldChat.name, chat.name)
                                }

                                /* Compare users */
                                if (oldChat.users.size < chat.users.size) {
                                    const userAdded = chat.users.find((u) => !oldChat.users.has(u.id))
                                    if (userAdded) this.emit('chatUserAdd', chat, userAdded)
                                } else if (oldChat.users.size > chat.users.size) {
                                    const userRemoved = oldChat.users.find((u) => !chat.users.has(u.id))
                                    if (userRemoved) this.emit('chatUserRemove', chat, userRemoved)
                                }

                                /* Compare calling status */
                                if (!oldChat.calling && chat.calling) {
                                    this.emit('callStart', chat)
                                } else if (oldChat.calling && !chat.calling) {
                                    this.emit('callEnd', chat)
                                }
                            } else {
                                const chat = new Chat(this, threadID, JSON.parse(data.value))
                                this.cache.chats.set(chat.id, chat)
                            }
                            return
                        }
                        const isMessagePath = Util.matchMessagePath(data.path, false)
                        if (isMessagePath) {
                            const [ threadID ] = Util.matchMessagePath(data.path, true)
                            this.fetchChat(threadID).then((chat) => {
                                const messagePayload = JSON.parse(data.value)
                                if (chat.messages.has(messagePayload.item_id)) {
                                    const message = chat.messages.get(messagePayload.item_id)
                                    const oldMessage = Object.assign(Object.create(message), message)
                                    chat.messages.get(messagePayload.item_id)._patch(messagePayload)

                                    /* Compare likes */
                                    if (oldMessage.likes.length > message.likes.length) {
                                        const removed = oldMessage.likes.find((like) => !message.likes.some((l) => l.userID === like.userID))
                                        this.fetchUser(removed.userID).then((user) => {
                                            if (removed) this.emit('likeRemove', user, message)
                                        })
                                    } else if (message.likes.length > oldMessage.likes.length) {
                                        const added = message.likes.find((like) => !oldMessage.likes.some((l) => l.userID === like.userID))
                                        if (added) {
                                            this.fetchUser(added.userID).then((user) => {
                                                this.emit('likeAdd', user, message)
                                            })
                                        }
                                    }
                                }
                            })
                        }
                        break
                    }

                    case 'add': {
                        const isAdminPath = Util.matchAdminPath(data.path, false)
                        if (isAdminPath) {
                            const [ threadID, userID ] = Util.matchAdminPath(data.path, true)
                            this.fetchChat(threadID).then((chat) => {
                                // Mark the user as an admin
                                chat.adminUserIDs.push(userID)
                                this.fetchUser(userID).then((user) => {
                                    this.emit('chatAdminAdd', chat, user)
                                })
                            })
                            return
                        }
                        const isMessagePath = Util.matchMessagePath(data.path, false)
                        if (isMessagePath) {
                            const [ threadID ] = Util.matchMessagePath(data.path, true)
                            this.fetchChat(threadID).then((chat) => {
                                // Create a new message
                                const messagePayload = JSON.parse(data.value)
                                if (messagePayload.item_type === 'action_log' || messagePayload.item_type === 'video_call_event') return
                                const message = new Message(this, threadID, messagePayload)
                                chat.messages.set(message.id, message)
                                if (Util.isMessageValid(message)) this.emit('messageCreate', message)
                            })
                        }
                        break
                    }

                    case 'remove': {
                        const isAdminPath = Util.matchAdminPath(data.path, false)
                        if (isAdminPath) {
                            const [ threadID, userID ] = Util.matchAdminPath(data.path, true)
                            this.fetchChat(threadID).then((chat) => {
                                // Remove the user from the administrators
                                chat.adminUserIDs.push(userID)
                                this.fetchUser(userID).then((user) => {
                                    this.emit('chatAdminRemove', chat, user)
                                })
                            })
                            return
                        }
                        const isMessagePath = Util.matchMessagePath(data.path, false)
                        if (isMessagePath) {
                            const [ threadID ] = Util.matchMessagePath(data.path, true)
                            this.fetchChat(threadID).then((chat) => {
                                // Emit message delete event
                                const messageID = data.value
                                const existing = chat.messages.get(messageID)
                                if (existing) this.emit('messageDelete', existing)
                            })
                        }
                        break
                    }

                    default:
                        break
                    }
                })
            })
        }
    }

    /**
     * Handle FBNS messages
     * @param {object} data
     * @private
     */


        

        this.ig = ig
        this.ready = true
        this.emit('connected')
        this.eventsToReplay.forEach((event) => {
            const eventType = event.shift()
            if (eventType === 'realtime') {
                this.handleRealtimeReceive(...event)
            } 
        })
    }

    toJSON () {
        const json = {
            ready: this.ready,
            options: this.options,
            id: this.user.id
        }
        return json
    }
}

module.exports = Client

