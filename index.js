const { Client } = require('discord.js-selfbot-v13');
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
    TARGET_GUILD_ID: process.env.TARGET_GUILD_ID
};

// Verifica token utente
if (!CONFIG.USER_TOKEN) {
    console.error('❌ ERRORE: USER_TOKEN mancante!');
    console.log('\n🔧 Per ottenere il token utente:');
    console.log('1. Accedi a Discord Web');
    console.log('2. Premi F12 → Application → Local Storage');
    console.log('3. Cerca "token" e copia il valore');
    console.log('⚠️ AVVISO: Usare token utente VIOLA i ToS di Discord!');
    process.exit(1);
}

// Crea client selfbot
const client = new Client({
    checkUpdate: false
});

// Stato
let isCloning = false;
let createdChannels = [];
let createdWebhooks = [];

async function createChannelAndWebhook(guild, index) {
    try {
        const channelName = `${CONFIG.WEBHOOK_NAME}-${index + 1}`;
        console.log(`📁 Creando canale: ${channelName}...`);
        
        const channel = await guild.channels.create(channelName, {
            type: 'text',
            topic: `Clonato da canale #${index + 1}`,
            nsfw: true
        });
        
        console.log(`🔧 Creando webhook in #${channel.name}...`);
        const webhook = await channel.createWebhook(CONFIG.WEBHOOK_NAME, {
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
            headers: {
                'Authorization': CONFIG.USER_TOKEN,
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const contentType = response.headers['content-type'] || 'image/jpeg';
        let ext = 'jpg';
        
        if (contentType.includes('png')) ext = 'png';
        else if (contentType.includes('gif')) ext = 'gif';
        else if (contentType.includes('mp4')) ext = 'mp4';
        else if (contentType.includes('webm')) ext = 'webm';
        
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

async function sendViaWebhook(webhookUrl, messageData, files = []) {
    try {
        const formData = new FormData();
        
        if (messageData.content) {
            formData.append('content', messageData.content);
        }
        
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
            headers: formData.getHeaders()
        });
        
        return response.data;
    } catch (error) {
        console.error('❌ Errore invio webhook:', error.message);
        return null;
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
        
        while (true) {
            try {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;
                
                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;
                
                allMessages = [...allMessages, ...Array.from(messages.values())];
                lastId = messages.last().id;
                
                console.log(`   Batch: ${messages.size} messaggi (totale: ${allMessages.length})`);
                
                if (messages.size < 100) break;
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`   ❌ Errore batch:`, error.message);
                break;
            }
        }
        
        allMessages.reverse();
        console.log(`✅ Totale messaggi: ${allMessages.length}`);
        return allMessages;
        
    } catch (error) {
        console.error(`❌ Errore fetch canale:`, error.message);
        return [];
    }
}

async function cloneChannel(sourceChannelId, targetWebhook) {
    try {
        console.log(`\n🚀 INIZIO CLONAZIONE`);
        
        const messages = await fetchChannelMessages(sourceChannelId);
        if (messages.length === 0) {
            console.log(`⚠️ Nessun messaggio da clonare`);
            return { success: 0, error: 0 };
        }
        
        let successCount = 0;
        let errorCount = 0;
        
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            
            if (message.author.bot) continue;
            
            try {
                const messageData = {
                    content: message.content || '',
                    username: message.author.username,
                    avatar_url: message.author.displayAvatarURL({ format: 'png' })
                };
                
                const files = [];
                
                // Allegati
                if (message.attachments.size > 0) {
                    for (const attachment of message.attachments.values()) {
                        if (attachment.size > 8000000) continue;
                        
                        const fileData = await downloadAttachment(attachment.url);
                        if (fileData) {
                            files.push({
                                ...fileData,
                                filename: attachment.name || `file_${Date.now()}.${fileData.ext}`
                            });
                        }
                    }
                }
                
                // Embed
                if (message.embeds.length > 0) {
                    for (const embed of message.embeds) {
                        if (embed.image && embed.image.url) {
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
                
                await sendViaWebhook(targetWebhook.webhook.url, messageData, files);
                successCount++;
                
                if (successCount % 10 === 0) {
                    console.log(`   📊 Progresso: ${successCount}/${messages.length}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 300));
                
            } catch (error) {
                errorCount++;
                console.log(`   ❌ Errore messaggio ${i + 1}: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        console.log(`\n✅ CLONAZIONE COMPLETATA!`);
        console.log(`   Successo: ${successCount}, Errori: ${errorCount}`);
        
        return { success: successCount, error: errorCount };
        
    } catch (error) {
        console.error(`❌ Errore fatale:`, error);
        return { success: 0, error: 1 };
    }
}

async function startCloning() {
    if (isCloning) {
        console.log('⚠️ Già in corso!');
        return;
    }
    
    isCloning = true;
    console.log('\n🚀 AVVIO CLONAZIONE AUTOMATICA\n');
    
    try {
        createdChannels = [];
        createdWebhooks = [];
        
        // Verifica server target
        const targetGuild = client.guilds.cache.get(CONFIG.TARGET_GUILD_ID);
        if (!targetGuild) {
            console.error('❌ Non sei nel server target!');
            console.log(`🔧 Entra nel server con ID: ${CONFIG.TARGET_GUILD_ID}`);
            isCloning = false;
            return;
        }
        
        console.log(`🏰 Server target: ${targetGuild.name}`);
        
        // Crea canali e webhook
        console.log('\n🎯 FASE 1: Creazione canali GRINDR');
        const webhookInfos = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length; i++) {
            console.log(`\n🔨 Canale ${i + 1}/${CONFIG.CHANNEL_IDS.length}`);
            
            const webhookInfo = await createChannelAndWebhook(targetGuild, i);
            if (webhookInfo) {
                webhookInfos.push(webhookInfo);
                createdChannels.push(webhookInfo.channel);
                createdWebhooks.push(webhookInfo.webhook);
            }
            
            await new Promise(resolve => setTimeout(resolve, 800));
        }
        
        console.log(`\n✅ ${webhookInfos.length} canali creati`);
        
        // Clonazione in parallelo
        console.log('\n🚀 FASE 2: Clonazione in parallelo');
        const clonePromises = [];
        const results = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length && i < webhookInfos.length; i++) {
            const promise = (async (index) => {
                console.log(`\n📁 Avvio clonazione canale ${index + 1}...`);
                const result = await cloneChannel(CONFIG.CHANNEL_IDS[index], webhookInfos[index]);
                results.push({ index, result });
                console.log(`✅ Canale ${index + 1} completato`);
            })(i);
            
            clonePromises.push(promise);
        }
        
        await Promise.allSettled(clonePromises);
        
        // Riepilogo
        console.log('\n✨ TUTTO COMPLETATO!\n');
        
        let totalSuccess = 0;
        let totalError = 0;
        
        results.forEach((item, i) => {
            console.log(`Canale ${i + 1}:`);
            console.log(`   ✅ ${item.result.success} messaggi`);
            console.log(`   ❌ ${item.result.error} errori`);
            console.log(`   🔗 ${createdWebhooks[i].url}`);
            
            totalSuccess += item.result.success;
            totalError += item.result.error;
        });
        
        console.log(`\n📊 TOTALE: ${totalSuccess} successi, ${totalError} errori`);
        
        // Salva webhook
        const webhookData = {
            timestamp: new Date().toISOString(),
            webhooks: createdWebhooks.map(w => w.url),
            channels: createdChannels.map(c => ({ name: c.name, id: c.id })),
            stats: { success: totalSuccess, error: totalError }
        };
        
        fs.writeFileSync('webhooks_grindr.json', JSON.stringify(webhookData, null, 2));
        console.log('\n💾 Webhook salvati in webhooks_grindr.json');
        
    } catch (error) {
        console.error('❌ Errore:', error);
    } finally {
        isCloning = false;
    }
}

// Quando il client è pronto
client.on('ready', () => {
    console.log('='.repeat(50));
    console.log(`✅ ACCOUNT PRONTO: ${client.user.tag}`);
    console.log('='.repeat(50));
    console.log(`🆔 User ID: ${client.user.id}`);
    console.log(`🏰 Server: ${client.guilds.cache.size}`);
    console.log(`🎯 Canali da clonare: ${CONFIG.CHANNEL_IDS.length}`);
    console.log(`🔧 Target Server: ${CONFIG.TARGET_GUILD_ID || 'Non configurato'}`);
    console.log('='.repeat(50) + '\n');
    
    console.log('⏱️ Avvio automatico in 5 secondi...\n');
    
    setTimeout(() => {
        if (CONFIG.TARGET_GUILD_ID) {
            startCloning();
        } else {
            console.log('❌ TARGET_GUILD_ID mancante!');
            console.log('🔧 Configuralo in Render.com');
        }
    }, 5000);
});

// Comandi da console
process.stdin.on('data', (data) => {
    const input = data.toString().trim().toLowerCase();
    
    if (input === 'start') {
        console.log('\n🚀 Comando start ricevuto');
        startCloning();
    }
    
    if (input === 'status') {
        console.log('\n📊 STATO:');
        console.log(`   Clonazione: ${isCloning ? 'Attiva' : 'Inattiva'}`);
        console.log(`   Canali: ${createdChannels.length}`);
        console.log(`   Webhook: ${createdWebhooks.length}`);
    }
    
    if (input === 'exit') {
        console.log('\n👋 Uscita...');
        client.destroy();
        process.exit(0);
    }
});

// Login
console.log('🔐 Login con account utente...');
console.log('⚠️ AVVISO: Selfbot viola i ToS di Discord!\n');

client.login(CONFIG.USER_TOKEN).catch(error => {
    console.error('❌ Login fallito:', error.message);
    console.log('\n🔧 Possibili cause:');
    console.log('1. Token invalido o scaduto');
    console.log('2. Account bannato');
    console.log('3. 2FA attivo');
    console.log('4. Token revocato');
    process.exit(1);
});
