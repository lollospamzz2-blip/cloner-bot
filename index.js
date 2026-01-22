const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
require('dotenv').config();

// Configurazione
const CONFIG = {
    SOURCE_GUILD_ID: process.env.SOURCE_GUILD_ID || '1430987988606779455',
    CHANNEL_IDS: process.env.CHANNEL_IDS ? 
        process.env.CHANNEL_IDS.split(',') : [
            '1431350770460004373',
            '1431350918267404501',
            '1431350851259072714'
        ],
    WEBHOOK_NAME: process.env.WEBHOOK_NAME || 'GRINDR',
    TARGET_GUILD_ID: process.env.TARGET_GUILD_ID,
    BOT_TOKEN: process.env.BOT_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID
};

// Verifica token
if (!CONFIG.BOT_TOKEN) {
    console.error('❌ ERRORE: BOT_TOKEN non configurato!');
    console.error('Aggiungilo in .env o nelle variabili d\'ambiente di Render');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks
    ]
});

// Array per tenere traccia dei webhook creati
let createdWebhooks = [];

async function createWebhookInChannel(channel, webhookName) {
    try {
        console.log(`🔧 Creando webhook in #${channel.name}...`);
        const webhook = await channel.createWebhook({
            name: webhookName,
            avatar: null
        });
        console.log(`✅ Webhook creato: ${webhook.url}`);
        return webhook;
    } catch (error) {
        console.error(`❌ Errore creazione webhook in ${channel.name}:`, error.message);
        return null;
    }
}

async function sendViaWebhook(webhookUrl, messageData, files = []) {
    try {
        const formData = new FormData();
        
        // Aggiungi contenuto del messaggio
        if (messageData.content) {
            formData.append('content', messageData.content);
        }
        
        // Aggiungi files
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.buffer) {
                formData.append(`files[${i}]`, file.buffer, {
                    filename: file.filename || `file_${i}.${file.ext || 'jpg'}`,
                    contentType: file.contentType
                });
            }
        }
        
        // Aggiungi username e avatar se presenti
        if (messageData.username) {
            formData.append('username', messageData.username);
        }
        if (messageData.avatar_url) {
            formData.append('avatar_url', messageData.avatar_url);
        }
        
        const response = await axios.post(webhookUrl, formData, {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        return response.data;
    } catch (error) {
        console.error('❌ Errore invio webhook:', error.message);
        return null;
    }
}

async function downloadAttachment(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer'
        });
        
        // Determina estensione dal content-type
        const contentType = response.headers['content-type'];
        let ext = 'bin';
        if (contentType.includes('image/jpeg')) ext = 'jpg';
        else if (contentType.includes('image/png')) ext = 'png';
        else if (contentType.includes('image/gif')) ext = 'gif';
        else if (contentType.includes('video/mp4')) ext = 'mp4';
        
        return {
            buffer: Buffer.from(response.data),
            contentType: contentType,
            ext: ext
        };
    } catch (error) {
        console.error('❌ Errore download:', error.message);
        return null;
    }
}

async function cloneChannel(sourceChannelId, targetChannelId, webhook) {
    try {
        const sourceChannel = await client.channels.fetch(sourceChannelId);
        const targetChannel = await client.channels.fetch(targetChannelId);
        
        if (!sourceChannel || !targetChannel) {
            console.error('❌ Canale non trovato');
            return;
        }
        
        console.log(`🚀 Clonazione da #${sourceChannel.name} a #${targetChannel.name}...`);
        
        // Fetch messaggi (limite 100 alla volta)
        let messages = [];
        let lastId;
        
        while (true) {
            const options = { limit: 100 };
            if (lastId) options.before = lastId;
            
            const fetched = await sourceChannel.messages.fetch(options);
            if (fetched.size === 0) break;
            
            messages = messages.concat(Array.from(fetched.values()));
            lastId = fetched.last().id;
            
            if (fetched.size < 100) break;
        }
        
        // Inverti ordine per clonare dal più vecchio al più nuovo
        messages.reverse();
        
        console.log(`📨 Trovati ${messages.length} messaggi da clonare`);
        
        // Clona ogni messaggio
        for (const message of messages) {
            if (message.author.bot) continue;
            
            try {
                const messageData = {
                    content: message.content || '',
                    username: message.author.username,
                    avatar_url: message.author.displayAvatarURL({ extension: 'png' })
                };
                
                const files = [];
                
                // Gestisci allegati
                if (message.attachments.size > 0) {
                    for (const attachment of message.attachments.values()) {
                        const fileData = await downloadAttachment(attachment.url);
                        if (fileData) {
                            files.push({
                                ...fileData,
                                filename: attachment.name || `file_${Date.now()}.${fileData.ext}`
                            });
                        }
                    }
                }
                
                // Gestisci embed con immagini
                if (message.embeds.length > 0) {
                    for (const embed of message.embeds) {
                        if (embed.image) {
                            const fileData = await downloadAttachment(embed.image.url);
                            if (fileData) {
                                files.push({
                                    ...fileData,
                                    filename: `embed_${Date.now()}.${fileData.ext}`
                                });
                            }
                        }
                    }
                }
                
                // Invia tramite webhook
                await sendViaWebhook(webhook.url, messageData, files);
                
                // Piccola pausa per evitare rate limit
                await new Promise(resolve => setTimeout(resolve, 500));
                
                console.log(`✅ Clonato messaggio da ${message.author.username}`);
                
            } catch (error) {
                console.error('❌ Errore clonazione messaggio:', error.message);
            }
        }
        
        console.log(`🎉 Clonazione completata per #${sourceChannel.name}`);
        
    } catch (error) {
        console.error('❌ Errore nella clonazione:', error);
    }
}

async function startCloning() {
    try {
        console.log('🤖 Bot avviato!');
        console.log(`🔍 Connesso come: ${client.user.tag}`);
        
        // Verifica che il bot sia nel server target
        const targetGuild = await client.guilds.fetch(CONFIG.TARGET_GUILD_ID);
        if (!targetGuild) {
            console.error('❌ Bot non presente nel server target!');
            return;
        }
        
        console.log(`🏰 Server target: ${targetGuild.name}`);
        
        // Crea canali GRINDR e webhook
        const targetChannels = [];
        const webhooks = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length; i++) {
            try {
                // Crea canale nel server target
                const channelName = `${CONFIG.WEBHOOK_NAME}-${i + 1}`;
                console.log(`📁 Creando canale: ${channelName}...`);
                
                const newChannel = await targetGuild.channels.create({
                    name: channelName,
                    type: 0, // TEXT_CHANNEL
                    topic: `Clonato da ${CONFIG.SOURCE_GUILD_ID}`,
                    nsfw: true // Per sicurezza se ci sono contenuti NSFW
                });
                
                targetChannels.push(newChannel);
                
                // Crea webhook nel nuovo canale
                const webhook = await createWebhookInChannel(newChannel, CONFIG.WEBHOOK_NAME);
                if (webhook) {
                    webhooks.push({
                        channel: newChannel,
                        webhook: webhook
                    });
                }
                
                console.log(`✅ Canale e webhook creati: ${channelName}`);
                
            } catch (error) {
                console.error(`❌ Errore creazione canale ${i + 1}:`, error.message);
            }
        }
        
        // Avvia clonazione in parallelo
        const clonePromises = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length && i < webhooks.length; i++) {
            clonePromises.push(
                cloneChannel(
                    CONFIG.CHANNEL_IDS[i],
                    webhooks[i].channel.id,
                    webhooks[i].webhook
                )
            );
        }
        
        console.log('🚀 Avvio clonazione in parallelo...');
        await Promise.allSettled(clonePromises);
        
        console.log('🎉 Tutte le clonazioni completate!');
        console.log('📊 Riepilogo webhook creati:');
        webhooks.forEach((wh, i) => {
            console.log(`  ${i + 1}. #${wh.channel.name} -> ${wh.webhook.url}`);
        });
        
    } catch (error) {
        console.error('❌ Errore nello startCloning:', error);
    }
}

// Eventi del bot
client.once('ready', () => {
    console.log('✅ Bot pronto!');
    
    // Avvia clonazione automaticamente
    if (process.env.AUTO_START === 'true') {
        setTimeout(() => {
            startCloning();
        }, 5000);
    }
});

client.on('messageCreate', async (message) => {
    // Comando manuale per avviare la clonazione
    if (message.content === '!clone' && message.author.id === process.env.ADMIN_ID) {
        await message.reply('🚀 Avvio clonazione...');
        startCloning();
    }
    
    // Comando per status
    if (message.content === '!status') {
        await message.reply(`🤖 Bot online! Creati ${createdWebhooks.length} webhook`);
    }
});

// Gestione errori
process.on('unhandledRejection', (error) => {
    console.error('❌ Errore non gestito:', error);
});

// Avvio bot
client.login(CONFIG.BOT_TOKEN);
