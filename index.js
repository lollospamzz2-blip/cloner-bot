const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const http = require('http');

// Environment variables - SOLO 2 RICHIESTE
const USER_TOKEN = process.env.USER_TOKEN;
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID;

// Default values - Auto-detect
const PORT = process.env.PORT || 3000;
const WEBHOOK_NAME = 'GRINDR';
const RATE_LIMIT_MS = 300;
const MAX_CONCURRENT = 3;

// Validation
if (!USER_TOKEN || !TARGET_GUILD_ID) {
    console.error('❌ CONFIGURAZIONE INCOMPLETA!');
    console.error('Su Render aggiungi solo 2 variabili:');
    console.error('  USER_TOKEN = il tuo token Discord');
    console.error('  TARGET_GUILD_ID = ID del server target');
    process.exit(1);
}

// Keep-alive server per Render
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Discord Selfbot Running');
});

server.listen(PORT, () => {
    console.log(`✅ Keep-alive server on port ${PORT}`);
});

const client = new Client({ 
    checkUpdate: false,
    ws: {
        properties: {
            os: 'Linux',
            browser: 'Discord Client',
            device: 'Desktop'
        }
    }
});

let isCloning = false;
let createdChannels = [];
let createdWebhooks = [];
let detectedChannels = [];
let globalStats = { totalSuccess: 0, totalError: 0, totalVideos: 0 };

// Upload Queue per parallelize
class UploadQueue {
    constructor(maxConcurrent) {
        this.maxConcurrent = maxConcurrent;
        this.queue = [];
        this.running = 0;
    }

    async add(task) {
        return new Promise((resolve) => {
            this.queue.push({ task, resolve });
            this.process();
        });
    }

    async process() {
        while (this.running < this.maxConcurrent && this.queue.length > 0) {
            this.running++;
            const { task, resolve } = this.queue.shift();
            try {
                const result = await task();
                resolve(result);
            } catch (error) {
                resolve({ error: error.message });
            } finally {
                this.running--;
                this.process();
            }
        }
    }
}

const uploadQueue = new UploadQueue(MAX_CONCURRENT);

async function detectSourceChannels() {
    try {
        console.log('\n🔍 Rilevamento canali sorgente...\n');
        
        const userGuilds = client.guilds.cache;
        if (userGuilds.size === 0) {
            console.error('❌ Non sei in nessun server!');
            return [];
        }
        
        for (const [guildId, guild] of userGuilds) {
            if (guildId !== TARGET_GUILD_ID) {
                const textChannels = guild.channels.cache.filter(ch => ch.type === 'GUILD_TEXT');
                
                if (textChannels.size > 0) {
                    console.log(`📍 Server trovato: ${guild.name}`);
                    
                    textChannels.forEach((ch, idx) => {
                        console.log(`   ${idx + 1}. #${ch.name} (${ch.id})`);
                        detectedChannels.push({
                            id: ch.id,
                            name: ch.name,
                            guild: guild.name
                        });
                    });
                    console.log();
                    
                    if (detectedChannels.length > 0) {
                        break;
                    }
                }
            }
        }
        
        if (detectedChannels.length === 0) {
            console.error('❌ Nessun canale trovato negli altri server!');
            return [];
        }
        
        console.log(`✅ Trovati ${detectedChannels.length} canali\n`);
        return detectedChannels.map(ch => ch.id);
        
    } catch (error) {
        console.error(`❌ Errore rilevamento: ${error.message}`);
        return [];
    }
}

async function createChannelAndWebhook(guild, index, sourceName) {
    try {
        const channelName = `${WEBHOOK_NAME}-${index + 1}`;
        console.log(`📁 Creando canale: ${channelName}...`);
        
        const channel = await guild.channels.create(channelName, {
            type: 'GUILD_TEXT',
            topic: `Clonato da: ${sourceName}`,
            nsfw: true
        });
        
        console.log(`🔧 Creando webhook...`);
        const webhook = await channel.createWebhook(WEBHOOK_NAME, { avatar: null });
        
        console.log(`✅ Canale #${channel.name} creato\n`);
        return { channel, webhook };
        
    } catch (error) {
        console.error(`❌ Errore creazione canale ${index + 1}: ${error.message}`);
        return null;
    }
}

async function downloadFile(url, maxSize = 8388608) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 45000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            maxContentLength: maxSize,
            maxBodyLength: maxSize
        });
        
        const contentType = response.headers['content-type'] || 'video/mp4';
        let ext = 'mp4';
        
        if (contentType.includes('png')) ext = 'png';
        else if (contentType.includes('jpg') || contentType.includes('jpeg')) ext = 'jpg';
        else if (contentType.includes('gif')) ext = 'gif';
        else if (contentType.includes('webp')) ext = 'webp';
        else if (contentType.includes('video') || contentType.includes('mp4')) ext = 'mp4';
        else if (contentType.includes('webm')) ext = 'webm';
        
        return {
            buffer: Buffer.from(response.data),
            contentType: contentType,
            ext: ext,
            size: response.data.length
        };
    } catch (error) {
        return null;
    }
}

async function sendViaWebhook(webhookUrl, messageData, files = []) {
    try {
        const formData = new FormData();
        
        if (messageData.content && messageData.content.trim()) {
            formData.append('content', messageData.content.substring(0, 2000));
        }
        
        if (files.length > 0) {
            for (let i = 0; i < Math.min(files.length, 10); i++) {
                const file = files[i];
                formData.append(`files[${i}]`, file.buffer, {
                    filename: file.filename || `file_${i}.${file.ext}`,
                    contentType: file.contentType
                });
            }
        }
        
        formData.append('username', WEBHOOK_NAME);
        if (messageData.avatar_url) {
            formData.append('avatar_url', messageData.avatar_url);
        }
        
        await axios.post(webhookUrl, formData, {
            headers: formData.getHeaders(),
            timeout: 60000,
            maxBodyLength: 8388608,
            maxContentLength: 8388608
        });
        
        return true;
    } catch (error) {
        return false;
    }
}

async function fetchChannelMessages(channelId) {
    try {
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
        if (!channel) {
            console.error(`❌ Canale ${channelId} non trovato`);
            return [];
        }
        
        console.log(`📨 Fetching messaggi da #${channel.name}...`);
        let allMessages = [];
        let lastId = null;
        let batchCount = 0;
        
        while (true) {
            try {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;
                
                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;
                
                allMessages = allMessages.concat(Array.from(messages.values()));
                
                if (messages.last()) lastId = messages.last().id;
                
                batchCount++;
                console.log(`   Batch ${batchCount}: ${messages.size} msg (total: ${allMessages.length})`);
                
                if (messages.size < 100) break;
                
                await new Promise(resolve => setTimeout(resolve, 800));
                
            } catch (error) {
                console.error(`   ❌ Batch error ${batchCount}: ${error.message}`);
                break;
            }
        }
        
        allMessages.reverse();
        console.log(`✅ Total: ${allMessages.length} messaggi\n`);
        return allMessages;
        
    } catch (error) {
        console.error(`❌ Fetch error: ${error.message}`);
        return [];
    }
}

async function cloneChannel(sourceChannelId, targetWebhook, channelIndex) {
    try {
        console.log(`\n🚀 CLONING CANALE ${channelIndex + 1}`);
        
        const messages = await fetchChannelMessages(sourceChannelId);
        
        if (messages.length === 0) {
            console.log(`⚠️ Nessun messaggio`);
            return { success: 0, error: 0, videos: 0 };
        }
        
        let videoCount = 0;
        const uploadTasks = [];
        
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (message.author.bot) continue;
            
            uploadTasks.push(
                uploadQueue.add(async () => {
                    try {
                        const messageData = {
                            content: message.content || '',
                            username: WEBHOOK_NAME,
                            avatar_url: message.author.displayAvatarURL({ format: 'png', size: 256 })
                        };
                        
                        const files = [];
                        let hasVideo = false;
                        
                        if (message.attachments && message.attachments.size > 0) {
                            for (const attachment of message.attachments.values()) {
                                try {
                                    if (attachment.size > 8388608) continue;
                                    
                                    const fileData = await downloadFile(attachment.url);
                                    if (fileData) {
                                        if (fileData.ext === 'mp4' || fileData.ext === 'webm') {
                                            hasVideo = true;
                                        }
                                        files.push({
                                            ...fileData,
                                            filename: attachment.name || `file_${Date.now()}.${fileData.ext}`
                                        });
                                    }
                                } catch (error) { /* */ }
                            }
                        }
                        
                        if (message.embeds && message.embeds.length > 0) {
                            for (const embed of message.embeds) {
                                if (embed.image && embed.image.url && files.length < 10) {
                                    try {
                                        const fileData = await downloadFile(embed.image.url);
                                        if (fileData) files.push({ ...fileData, filename: `embed_${Date.now()}.${fileData.ext}` });
                                    } catch (error) { /* */ }
                                }
                                
                                if (embed.video && embed.video.url && files.length < 10) {
                                    try {
                                        const fileData = await downloadFile(embed.video.url);
                                        if (fileData) {
                                            hasVideo = true;
                                            files.push({ ...fileData, filename: `video_${Date.now()}.${fileData.ext}` });
                                        }
                                    } catch (error) { /* */ }
                                }
                            }
                        }
                        
                        const success = await sendViaWebhook(targetWebhook.webhook.url, messageData, files);
                        
                        if (success) {
                            globalStats.totalSuccess++;
                            if (hasVideo) {
                                videoCount++;
                                globalStats.totalVideos++;
                            }
                        } else {
                            globalStats.totalError++;
                        }
                        
                        return { success };
                        
                    } catch (error) {
                        globalStats.totalError++;
                        return { success: false };
                    }
                })
            );
        }
        
        const results = await Promise.allSettled(uploadTasks);
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        const errorCount = results.filter(r => r.status === 'rejected' || !r.value.success).length;
        
        console.log(`✅ CANALE ${channelIndex + 1} DONE!`);
        console.log(`   ✅ ${successCount} messaggi`);
        console.log(`   🎬 ${videoCount} video`);
        console.log(`   ❌ ${errorCount} errori\n`);
        
        return { success: successCount, error: errorCount, videos: videoCount };
        
    } catch (error) {
        console.error(`❌ Clone error: ${error.message}`);
        return { success: 0, error: 1, videos: 0 };
    }
}

async function startCloning() {
    if (isCloning) {
        console.log('⚠️ Già in corso!');
        return;
    }
    
    isCloning = true;
    globalStats = { totalSuccess: 0, totalError: 0, totalVideos: 0 };
    
    console.log('\n' + '='.repeat(70));
    console.log('🚀 AVVIO CLONAZIONE AUTOMATICA');
    console.log('='.repeat(70));
    
    try {
        createdChannels = [];
        createdWebhooks = [];
        
        const targetGuild = client.guilds.cache.get(TARGET_GUILD_ID);
        if (!targetGuild) {
            console.error('❌ Non sei nel server target!');
            isCloning = false;
            return;
        }
        
        console.log(`\n🏰 Server target: ${targetGuild.name}`);
        console.log(`⚡ Upload paralleli: ${MAX_CONCURRENT}x\n`);
        
        // Auto-detect source channels
        const sourceChannelIds = await detectSourceChannels();
        
        if (sourceChannelIds.length === 0) {
            console.error('❌ Nessun canale da clonare!');
            isCloning = false;
            return;
        }
        
        // FASE 1: Create channels
        console.log('🎯 FASE 1: Creazione canali\n');
        const webhookInfos = [];
        
        for (let i = 0; i < sourceChannelIds.length; i++) {
            const sourceName = detectedChannels[i]?.name || `Channel ${i + 1}`;
            const webhookInfo = await createChannelAndWebhook(targetGuild, i, sourceName);
            if (webhookInfo) {
                webhookInfos.push(webhookInfo);
                createdChannels.push(webhookInfo.channel);
                createdWebhooks.push(webhookInfo.webhook);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (webhookInfos.length === 0) {
            console.error('❌ Nessun canale creato!');
            isCloning = false;
            return;
        }
        
        console.log(`✨ ${webhookInfos.length} canali creati!\n`);
        
        // FASE 2: Clone PARALLEL
        console.log('⚡ FASE 2: Clonazione PARALLELA\n');
        
        const clonePromises = [];
        for (let i = 0; i < sourceChannelIds.length && i < webhookInfos.length; i++) {
            clonePromises.push(cloneChannel(sourceChannelIds[i], webhookInfos[i], i));
        }
        
        const results = await Promise.allSettled(clonePromises);
        
        // FASE 3: Summary
        console.log('\n' + '='.repeat(70));
        console.log('✨ CLONAZIONE COMPLETATA!');
        console.log('='.repeat(70) + '\n');
        
        console.log('📊 RIEPILOGO FINALE:\n');
        
        results.forEach((result, i) => {
            const data = result.status === 'fulfilled' ? result.value : { success: 0, error: 1, videos: 0 };
            const channelName = createdChannels[i]?.name || 'N/A';
            console.log(`Canale ${i + 1} (#${channelName}):`);
            console.log(`   ✅ ${data.success} messaggi`);
            console.log(`   🎬 ${data.videos} video`);
            console.log(`   ❌ ${data.error} errori`);
            if (createdWebhooks[i]) {
                console.log(`   🔗 ${createdWebhooks[i].url}\n`);
            }
        });
        
        console.log('📈 TOTALE:\n');
        console.log(`   ✅ ${globalStats.totalSuccess} messaggi clonati`);
        console.log(`   🎬 ${globalStats.totalVideos} video`);
        console.log(`   ❌ ${globalStats.totalError} errori`);
        console.log(`   🏁 ${createdChannels.length} canali\n`);
        
        // Save webhooks
        const webhookData = {
            timestamp: new Date().toISOString(),
            server: targetGuild.name,
            serverId: targetGuild.id,
            webhookName: WEBHOOK_NAME,
            webhooks: createdWebhooks.map(w => ({
                url: w.url,
                id: w.id,
                channelId: w.channel?.id,
                channelName: w.channel?.name
            })),
            stats: { 
                totalSuccess: globalStats.totalSuccess, 
                totalError: globalStats.totalError,
                totalVideos: globalStats.totalVideos,
                totalChannels: createdChannels.length
            }
        };
        
        fs.writeFileSync('webhooks_cloned.json', JSON.stringify(webhookData, null, 2));
        console.log('💾 Dati salvati in webhooks_cloned.json\n');
        console.log('🎉 FATTO!\n');
        
    } catch (error) {
        console.error('❌ Errore:', error.message);
    } finally {
        isCloning = false;
    }
}

client.on('ready', () => {
    try {
        console.log('='.repeat(70));
        console.log(`✅ ACCOUNT READY: ${client.user.tag}`);
        console.log('='.repeat(70));
        console.log(`🆔 ID: ${client.user.id}`);
        console.log(`🏰 Servers: ${client.guilds.cache.size}`);
        console.log('='.repeat(70));
        
        console.log('\n⏱️ Starting in 2 seconds...\n');
        
        setTimeout(() => {
            startCloning();
        }, 2000);
    } catch (error) {
        console.error('❌ Ready event error:', error.message);
    }
});

client.on('error', error => {
    console.error('❌ Client error:', error.message);
});

// Process handlers
process.on('SIGINT', () => {
    console.log('\n👋 Closing...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Closing...');
    client.destroy();
    process.exit(0);
});

console.log('🔐 Login...\n');

client.login(USER_TOKEN).catch(error => {
    console.error('❌ Login failed:', error.message);
    process.exit(1);
});
