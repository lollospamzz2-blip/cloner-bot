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
        let batchCount = 0;
        
        while (true) {
            try {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;
                
                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;
                
                const messagesArray = Array.from(messages.values());
                allMessages = allMessages.concat(messagesArray);
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
        console.log(`\n🚀 INIZIO CLONAZIONE CANALE`);
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
            
            // Salta messaggi di bot
            if (message.author.bot) continue;
            
            try {
                const messageData = {
                    content: message.content || '',
                    username: message.author.username,
                    avatar_url: message.author.displayAvatarURL({ format: 'png' })
                };
                
                const files = [];
                
                // Processa allegati
                if (message.attachments.size > 0) {
                    for (const attachment of message.attachments.values()) {
                        try {
                            if (attachment.size > 8000000) { // 8MB limit
                                console.log(`   ⚠️ File troppo grande: ${attachment.name}`);
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
                await new Promise(resolve => setTimeout(resolve, 300));
                
            } catch (error) {
                errorCount++;
                console.log(`   ❌ Errore messaggio ${i + 1}: ${error.message}`);
                
                // Pausa più lunga in caso di errore
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        console.log(`\n✅ CLONAZIONE COMPLETATA!`);
        console.log(`   Successo: ${successCount}, Errori: ${errorCount}`);
        
        return { success: successCount, error: errorCount };
        
    } catch (error) {
        console.error(`❌ Errore fatale clonazione:`, error);
        return { success: 0, error: 1 };
    }
}

async function startCloning() {
    if (isCloning) {
        console.log('⚠️ Clonazione già in corso!');
        return;
    }
    
    isCloning = true;
    console.log('\n' + '='.repeat(50));
    console.log('🚀 AVVIO CLONAZIONE AUTOMATICA');
    console.log('='.repeat(50) + '\n');
    
    try {
        // Resetta
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
        console.log(`🎯 Canali da creare: ${CONFIG.CHANNEL_IDS.length}\n`);
        
        // FASE 1: Crea canali e webhook
        console.log('🎯 FASE 1: Creazione canali GRINDR\n');
        const webhookInfos = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length; i++) {
            console.log(`🔨 Creazione canale ${i + 1}/${CONFIG.CHANNEL_IDS.length}`);
            
            const webhookInfo = await createChannelAndWebhook(targetGuild, i);
            if (webhookInfo) {
                webhookInfos.push(webhookInfo);
                createdChannels.push(webhookInfo.channel);
                createdWebhooks.push(webhookInfo.webhook);
                console.log(`✅ Canale ${i + 1} creato\n`);
            }
            
            // Pausa tra creazioni
            await new Promise(resolve => setTimeout(resolve, 800));
        }
        
        console.log(`\n✨ ${webhookInfos.length} canali creati con successo!\n`);
        
        // FASE 2: Clonazione in parallelo
        console.log('🚀 FASE 2: Clonazione contenuti in parallelo\n');
        
        const clonePromises = [];
        const results = [];
        
        for (let i = 0; i < CONFIG.CHANNEL_IDS.length && i < webhookInfos.length; i++) {
            const promise = (async (index) => {
                console.log(`📁 Inizio clonazione canale ${index + 1}...`);
                const result = await cloneChannel(CONFIG.CHANNEL_IDS[index], webhookInfos[index]);
                results.push({ index, result });
                console.log(`\n✅ Canale ${index + 1} clonato\n`);
            })(i);
            
            clonePromises.push(promise);
        }
        
        // Attendi completamento
        await Promise.allSettled(clonePromises);
        
        // FASE 3: Riepilogo
        console.log('='.repeat(50));
        console.log('✨ TUTTE LE CLONAZIONI COMPLETATE!');
        console.log('='.repeat(50) + '\n');
        
        let totalSuccess = 0;
        let totalError = 0;
        
        console.log('📊 RIEPILOGO FINALE:\n');
        
        results.forEach((item, i) => {
            console.log(`Canale ${i + 1} (#${createdChannels[i].name}):`);
            console.log(`   ✅ ${item.result.success} messaggi clonati`);
            console.log(`   ❌ ${item.result.error} errori`);
            console.log(`   🔗 ${createdWebhooks[i].url}\n`);
            
            totalSuccess += item.result.success;
            totalError += item.result.error;
        });
        
        console.log('📈 TOTALE GENERALE:');
        console.log(`   ✅ ${totalSuccess} successi`);
        console.log(`   ❌ ${totalError} errori`);
        console.log(`   🏁 ${createdChannels.length} canali\n`);
        
        // Salva webhook
        const webhookData = {
            timestamp: new Date().toISOString(),
            webhooks: createdWebhooks.map(w => w.url),
            channels: createdChannels.map(c => ({ name: c.name, id: c.id })),
            stats: { success: totalSuccess, error: totalError }
        };
        
        fs.writeFileSync('webhooks_grindr.json', JSON.stringify(webhookData, null, 2));
        console.log('💾 Webhook salvati in webhooks_grindr.json\n');
        console.log('🎉 PROCESSO COMPLETATO CON SUCCESSO!\n');
        
    } catch (error) {
        console.error('❌ Errore nel processo:', error);
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
            console.log('🔧 Configuralo nelle variabili d\'ambiente di Render');
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
    
    if (input === 'webhooks') {
        if (createdWebhooks.length > 0) {
            console.log('\n🔗 WEBHOOK CREATI:');
            createdWebhooks.forEach((w, i) => {
                console.log(`${i + 1}. ${w.url}`);
            });
        } else {
            console.log('\n❌ Nessun webhook creato');
        }
    }
    
    if (input === 'exit' || input === 'quit') {
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
    console.log('2. Account bannato o sospeso');
    console.log('3. 2FA attivo');
    console.log('4. Token revocato');
    process.exit(1);
});
