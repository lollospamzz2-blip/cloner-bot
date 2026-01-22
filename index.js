const { Client, GatewayIntentBits } = require('discord.js-selfbot-v13');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
require('dotenv').config();

// Configurazione
const CONFIG = {
    USER_TOKEN: process.env.USER_TOKEN,
    SOURCE_GUILD_ID: process.env.SOURCE_GUILD_ID || '1430987988606779455',
    CHANNEL_IDS: process.env.CHANNEL_IDS ? 
        process.env.CHANNEL_IDS.split(',') : [
            '1431350770460004373',
            '1431350918267404501',
            '1431350851259072714'
        ],
    WEBHOOK_NAME: process.env.WEBHOOK_NAME || 'GRINDR',
    TARGET_GUILD_ID: process.env.TARGET_GUILD_ID,
    ADMIN_IDS: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : []
};

// Verifica token
if (!CONFIG.USER_TOKEN) {
    console.error('❌ ERRORE: USER_TOKEN mancante!');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.DirectMessages
    ]
});

// Stato del clonatore
let isCloning = false;
let cloningProgress = {
    total: 0,
    completed: 0,
    channels: {}
};
let createdChannels = [];
let createdWebhooks = [];

function canUserRunCommand(userId) {
    // Se non ci sono admin configurati, solo l'owner può eseguire
    if (CONFIG.ADMIN_IDS.length === 0) {
        return userId === client.user.id;
    }
    return CONFIG.ADMIN_IDS.includes(userId) || userId === client.user.id;
}

async function createChannelAndWebhook(guild, index) {
    try {
        const channelName = `${CONFIG.WEBHOOK_NAME}-${index + 1}`;
        console.log(`📁 Creando canale: ${channelName}...`);
        
        const channel = await guild.channels.create({
            name: channelName,
            type: 0,
            topic: `Clonato da canale #${index + 1} | ID: ${CONFIG.CHANNEL_IDS[index]}`,
            nsfw: true
        });
        
        console.log(`🔧 Creando webhook in #${channel.name}...`);
        const webhook = await channel.createWebhook({
            name: CONFIG.WEBHOOK_NAME,
            avatar: null
        });
        
        console.log(`✅ Canale #${channel.name} creato con webhook`);
        return { channel, webhook };
        
    } catch (error) {
        console.error(`❌ Errore creazione canale ${index + 1}:`, error.message);
        return null;
    }
}

async function downloadAttachment(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        let ext = 'jpg';
        
        if (contentType.includes('png')) ext = 'png';
        else if (contentType.includes('gif')) ext = 'gif';
        else if (contentType.includes('mp4')) ext = 'mp4';
        else if (contentType.includes('webm')) ext = 'webm';
        else if (contentType.includes('mov')) ext = 'mov';
        
        return {
            buffer: Buffer.from(response.data),
            contentType: contentType,
            ext: ext
        };
    } catch (error) {
        console.error('❌ Errore download file:', error.message);
        return null;
    }
}

async function sendViaWebhook(webhookUrl, messageData, files = []) {
    try {
        const formData = new FormData();
        
        if (messageData.content) {
            formData.append('content', messageData.content);
        }
        
        // Aggiungi files
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            formData.append(`files[${i}]`, file.buffer, {
                filename: file.filename || `file_${Date.now()}.${file.ext}`,
                contentType: file.contentType
            });
        }
        
        formData.append('username', messageData.username || CONFIG.WEBHOOK_NAME);
        if (messageData.avatar_url) {
            formData.append('avatar_url', messageData.avatar_url);
        }
        
        const response = await axios.post(webhookUrl, formData, {
            headers: formData.getHeaders(),
            maxContentLength: 50 * 1024 * 1024, // 50MB
            maxBodyLength: 50 * 1024 * 1024,
            timeout: 60000
        });
        
        return response.data;
    } catch (error) {
        console.error('❌ Errore invio webhook:', error.response?.status || error.message);
        return null;
    }
}

async function fetchChannelMessages(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);
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
                
                const messagesArray = Array.from(messages.values());
                allMessages = [...allMessages, ...messagesArray];
                lastId = messages.last().id;
                
                batchCount++;
                console.log(`   Batch ${batchCount}: ${messages.size} messaggi (totale: ${allMessages.length})`);
                
                if (messages.size < 100) break;
                
                // Pausa per evitare rate limit
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`   ❌ Errore batch ${batchCount}:`, error.message);
                break;
            }
        }
        
        // Inverti per clonare dal più vecchio
        allMessages.reverse();
        console.log(`✅ Totale messaggi: ${allMessages.length}`);
        
        return allMessages;
        
    } catch (error) {
        console.error(`❌ Errore fetch canale ${channelId}:`, error.message);
        return [];
    }
}

async function cloneChannel(sourceChannelId, targetWebhook) {
    try {
        console.log(`\n🚀 INIZIO CLONAZIONE`);
        console.log(`🔗 Webhook target: ${targetWebhook.webhook.url}`);
        
        const messages = await fetchChannelMessages(sourceChannelId);
        
        if (messages.length === 0) {
            console.log(`⚠️ Nessun messaggio da clonare`);
            return { success: 0, error: 0 };
        }
        
        let successCount = 0;
        let errorCount = 0;
        
        // Inizia clonazione
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            
            // Salta messaggi di bot (opzionale)
            if (message.author.bot) continue;
            
            try {
                const messageData = {
                    content: message.content || '',
                    username: `${message.author.username}`,
                    avatar_url: message.author.displayAvatarURL({ extension: 'png', size: 128 })
                };
                
                const files = [];
                
                // Processa allegati
                if (message.attachments.size > 0) {
                    console.log(`   📎 ${message.attachments.size} allegati nel messaggio ${i + 1}`);
                    
                    for (const attachment of message.attachments.values()) {
                        try {
                            if (attachment.size > 25000000) { // 25MB limit
                                console.log(`   ⚠️ File troppo grande (${Math.round(attachment.size/1024/1024)}MB): ${attachment.name}`);
                                continue;
                            }
                            
                            const fileData = await downloadAttachment(attachment.url);
                            if (fileData) {
                                files.push({
                                    ...fileData,
                                    filename: attachment.name || `file_${Date.now()}.${fileData.ext}`
                                });
                            }
                        } catch (error) {
                            console.log(`   ❌ Errore download allegato: ${error.message}`);
                        }
                    }
                }
                
                // Processa embed con immagini
                if (message.embeds.length > 0) {
                    for (const embed of message.embeds) {
                        if (embed.image && embed.image.url) {
                            try {
                                const fileData = await downloadAttachment(embed.image.url);
                                if (fileData) {
                                    files.push({
                                        ...fileData,
                                        filename: `embed_${Date.now()}.${fileData.ext}`
                                    });
                                }
                            } catch (error) {
                                console.log(`   ❌ Errore download embed: ${error.message}`);
                            }
                        }
                    }
                }
                
                // Invia tramite webhook
                await sendViaWebhook(targetWebhook.webhook.url, messageData, files);
                successCount++;
                
                // Progresso ogni 10 messaggi
                if (successCount % 10 === 0) {
                    console.log(`   📊 Progresso: ${successCount}/${messages.length} (${Math.round((successCount/messages.length)*100)}%)`);
                }
                
                // Pausa breve per evitare rate limit
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                errorCount++;
                console.log(`   ❌ Errore messaggio ${i + 1}: ${error.message}`);
                
                // Pausa più lunga in caso di errore
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        console.log(`\n✅ CLONAZIONE COMPLETATA!`);
        console.log(`   Successo: ${successCount}`);
        console.log(`   Errori: ${errorCount}`);
        
        return { success: successCount, error: errorCount };
        
    } catch (error) {
        console.error(`❌ Errore fatale clonazione:`, error);
        return { success: 0, error: 1 };
    }
}

async function startCloningProcess() {
    if (isCloning) {
        console.log('⚠️ Clonazione già in corso!');
        return;
    }
    
    isCloning = true;
    console.log('🚀 AVVIO PROCESSO DI CLONAZIONE');
    
    try {
        // Resetta progresso
        cloningProgress = {
            total: CONFIG.CHANNEL_IDS.length,
            completed: 0,
            channels: {}
        };
        createdChannels = [];
        createdWebhooks = [];
        
        // Verifica server target
        const targetGuild = await client.guilds.fetch(CONFIG.TARGET_GUILD_ID);
        if (!targetGuild) {
            console.error('❌ Non sei nel server target!');
            isCloning = false;
            return;
        }
        
        console.log(`🏰 Server target: ${targetGuild.name}`);
        
        // FASE 1: Crea canali e webhook
        console.log('\n🎯 FASE 1: Creazione canali e webhook');
        const webhookInfos = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length; i++) {
            console.log(`\n🔨 Canale ${i + 1}/${CONFIG.CHANNEL_IDS.length}`);
            
            const webhookInfo = await createChannelAndWebhook(targetGuild, i);
            if (webhookInfo) {
                webhookInfos.push(webhookInfo);
                createdChannels.push(webhookInfo.channel);
                createdWebhooks.push(webhookInfo.webhook);
            }
            
            // Pausa tra creazioni
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`\n✅ Creati ${webhookInfos.length} canali con webhook`);
        
        // FASE 2: Clonazione in parallelo
        console.log('\n🚀 FASE 2: Clonazione contenuti in parallelo');
        console.log('⚠️ Questa operazione potrebbe richiedere molto tempo');
        
        const clonePromises = [];
        const results = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length && i < webhookInfos.length; i++) {
            const promise = (async (index) => {
                console.log(`\n📁 Clonazione canale ${index + 1}...`);
                const result = await cloneChannel(CONFIG.CHANNEL_IDS[index], webhookInfos[index]);
                cloningProgress.completed++;
                results.push({ channelIndex: index, result });
                console.log(`✅ Canale ${index + 1} completato`);
            })(i);
            
            clonePromises.push(promise);
        }
        
        // Attendi completamento di tutte le clonazioni
        await Promise.allSettled(clonePromises);
        
        // FASE 3: Riepilogo
        console.log('\n✨ TUTTE LE CLONAZIONI COMPLETATE!');
        console.log('\n📊 RIEPILOGO FINALE:');
        
        let totalSuccess = 0;
        let totalError = 0;
        
        results.forEach((item, i) => {
            console.log(`\nCanale ${i + 1}:`);
            console.log(`   ✅ Messaggi clonati: ${item.result.success}`);
            console.log(`   ❌ Errori: ${item.result.error}`);
            console.log(`   🔗 Webhook: ${createdWebhooks[i].url}`);
            
            totalSuccess += item.result.success;
            totalError += item.result.error;
        });
        
        console.log(`\n📈 TOTALE GENERALE:`);
        console.log(`   ✅ Successi: ${totalSuccess}`);
        console.log(`   ❌ Errori: ${totalError}`);
        console.log(`   🏁 Canali: ${createdChannels.length}`);
        
        // Salva webhook in file
        const webhookUrls = createdWebhooks.map(w => w.url);
        fs.writeFileSync('webhooks_grindr.json', JSON.stringify({
            timestamp: new Date().toISOString(),
            webhooks: webhookUrls,
            channels: createdChannels.map(c => ({ name: c.name, id: c.id })),
            stats: { success: totalSuccess, error: totalError }
        }, null, 2));
        
        console.log('\n💾 Webhook salvati in webhooks_grindr.json');
        
    } catch (error) {
        console.error('❌ Errore nel processo di clonazione:', error);
    } finally {
        isCloning = false;
    }
}

// Eventi client
client.once('ready', () => {
    console.log('✅ Client pronto!');
    console.log(`👤 Loggato come: ${client.user.tag}`);
    console.log(`🆔 User ID: ${client.user.id}`);
    console.log(`🏰 Server: ${client.guilds.cache.size}`);
    console.log('\n📋 COMANDI DISPONIBILI:');
    console.log('   !start     - Avvia clonazione');
    console.log('   !status    - Mostra stato');
    console.log('   !webhooks  - Mostra webhook creati');
    console.log('   !stop      - Ferma clonazione');
    console.log('\n⚠️  AVVIO MANUALE: Scrivi !start in qualsiasi chat');
});

// Gestione comandi
client.on('messageCreate', async (message) => {
    // Ignora messaggi di altri utenti se non admin
    if (message.author.id !== client.user.id && !canUserRunCommand(message.author.id)) {
        return;
    }
    
    const content = message.content.toLowerCase().trim();
    
    if (content === '!start') {
        if (isCloning) {
            await message.reply('⚠️ Clonazione già in corso!');
            return;
        }
        
        await message.reply('🚀 Avvio clonazione in corso...');
        console.log('\n=== COMANDO START RICEVUTO ===');
        
        // Avvia in background
        startCloningProcess().then(() => {
            console.log('=== CLONAZIONE COMPLETATA ===');
        }).catch(error => {
            console.error('=== ERRORE CLONAZIONE ===', error);
        });
        
    } else if (content === '!status') {
        const statusMessage = `📊 **STATO CLONATORE**\n` +
                             `🔧 Clonazione attiva: ${isCloning ? '✅ SI' : '❌ NO'}\n` +
                             `📁 Canali creati: ${createdChannels.length}\n` +
                             `🔗 Webhook creati: ${createdWebhooks.length}\n` +
                             `🏁 Progresso: ${cloningProgress.completed}/${cloningProgress.total} canali`;
        
        await message.reply(statusMessage);
        
    } else if (content === '!webhooks') {
        if (createdWebhooks.length === 0) {
            await message.reply('❌ Nessun webhook creato ancora');
            return;
        }
        
        const webhookList = createdWebhooks.map((w, i) => 
            `${i + 1}. ${w.url}`
        ).join('\n');
        
        await message.reply(`🔗 **WEBHOOK CREATI:**\n${webhookList}\n\n💾 Salvati in webhooks_grindr.json`);
        
    } else if (content === '!stop') {
        if (!isCloning) {
            await message.reply('⚠️ Nessuna clonazione in corso');
            return;
        }
        
        isCloning = false;
        await message.reply('🛑 Clonazione fermata');
        console.log('=== CLONAZIONE FERMATA MANUALMENTE ===');
        
    } else if (content === '!help') {
        const helpMessage = `📖 **COMANDI DISPONIBILI:**\n` +
                          `!start - Avvia clonazione canali\n` +
                          `!status - Mostra stato corrente\n` +
                          `!webhooks - Mostra webhook creati\n` +
                          `!stop - Ferma clonazione\n` +
                          `!help - Mostra questo messaggio\n\n` +
                          `⚙️ Config: ${CONFIG.CHANNEL_IDS.length} canali da clonare`;
        
        await message.reply(helpMessage);
    }
});

// Gestione errori
process.on('unhandledRejection', (error) => {
    console.error('❌ Errore non gestito:', error);
});

// Login
console.log('🔐 Tentativo di login...');
client.login(CONFIG.USER_TOKEN).catch(error => {
    console.error('❌ Login fallito:', error.message);
    console.log('\n🔧 Possibili cause:');
    console.log('1. Token non valido o scaduto');
    console.log('2. Account bannato o sospeso');
    console.log('3. 2FA attivo');
    console.log('4. Token revocato');
    process.exit(1);
});
