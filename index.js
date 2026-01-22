require('dotenv').config();

const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.USER_TOKEN;

console.log('🔍 DEBUG: USER_TOKEN presente?', !!TOKEN);
console.log('🔍 DEBUG: Token length:', TOKEN ? TOKEN.length : 'N/A');
console.log('🔍 DEBUG: Variabili disponibili:', Object.keys(process.env).filter(k => k.includes('USER') || k.includes('TOKEN')));

if (!TOKEN) {
  console.error('❌ Errore: USER_TOKEN non configurato!');
  console.error('❌ Aggiungi USER_TOKEN nelle variabili d\'ambiente di Render');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// Configurazione hardcoded
const CONFIG = {
  SOURCE_GUILD_ID: '1430987988606779455',
  CHANNEL_IDS: [
    '1431350770460004373',
    '1431350918267404501',
    '1431350851259072714'
  ],
  TARGET_GUILD_ID: process.env.TARGET_GUILD_ID || null
};

let tempDir = './temp_media';

// Assicurati che esista la cartella temp
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

client.once('ready', async () => {
  console.log(`✅ Account connesso come ${client.user.tag}`);
  console.log('⚠️  USO A TUO RISCHIO - Viola i ToS di Discord!\n');
  console.log('🚀 Inizio processo di clonazione automatico...\n');

  try {
    await startAutoCloning();
  } catch (error) {
    console.error('❌ Errore nel processo di clonazione:', error);
    process.exit(1);
  }
});

/**
 * Processo automatico di clonazione
 */
async function startAutoCloning() {
  try {
    // Step 1: Fetch guild e canali
    console.log('📡 Step 1: Caricamento guild e canali...');
    const sourceGuild = await client.guilds.fetch(CONFIG.SOURCE_GUILD_ID);
    
    if (!CONFIG.TARGET_GUILD_ID) {
      console.error('❌ TARGET_GUILD_ID non configurato nelle variabili d\'ambiente!');
      process.exit(1);
    }
    
    const targetGuild = await client.guilds.fetch(CONFIG.TARGET_GUILD_ID);

    console.log(`✓ Guild source: ${sourceGuild.name}`);
    console.log(`✓ Guild target: ${targetGuild.name}\n`);

    // Step 2: Clona canali
    console.log('🔄 Step 2: Clonazione canali...');
    const channelMapping = {};

    // Clona tutti i canali in parallelo
    const cloneTasks = CONFIG.CHANNEL_IDS.map(async (channelId) => {
      try {
        const sourceChannel = sourceGuild.channels.cache.get(channelId);
        if (!sourceChannel) {
          console.log(`⚠️ Canale ${channelId} non trovato`);
          return null;
        }

        const newName = `GRINDR_${sourceChannel.name}`;
        
        let newChannel = await targetGuild.channels.create({
          name: newName,
          type: ChannelType.GuildText,
          topic: sourceChannel.topic || '',
          nsfw: sourceChannel.nsfw,
          rateLimitPerUser: sourceChannel.rateLimitPerUser || 0
        });

        // Copia permessi
        try {
          for (const [targetId, overwrite] of sourceChannel.permissionOverwrites.cache) {
            await newChannel.permissionOverwrites.create(targetId, {
              allow: overwrite.allow,
              deny: overwrite.deny
            });
          }
        } catch (err) {
          console.log(`⚠️ Permessi non copiati per ${newName}`);
        }

        channelMapping[channelId] = newChannel;
        console.log(`✓ Canale clonato: ${newName}`);

        return { sourceChannel, newChannel };

      } catch (error) {
        console.error(`✗ Errore clonazione canale ${channelId}:`, error.message);
        return null;
      }
    });

    const cloneResults = await Promise.all(cloneTasks);
    console.log(`\n✅ Canali clonati: ${cloneResults.filter(r => r !== null).length}/${CONFIG.CHANNEL_IDS.length}\n`);

    // Step 3: Download media e upload diretto
    console.log('📥 Step 3: Scaricamento e upload media...');
    
    for (const result of cloneResults) {
      if (!result) continue;

      const { sourceChannel, newChannel } = result;

      console.log(`\n📤 Elaborazione canale: ${sourceChannel.name}`);
      await downloadAndUploadMediaDirect(sourceChannel, newChannel);
    }

    console.log('\n✅ Processo completato con successo!');
    console.log('🎉 Tutti i canali sono stati clonati e riempiti di contenuto');

    // Pulizia
    cleanupTempDir();
    process.exit(0);

  } catch (error) {
    console.error('❌ Errore fatale:', error);
    cleanupTempDir();
    process.exit(1);
  }
}

/**
 * Scarica media e li invia direttamente al canale
 */
async function downloadAndUploadMediaDirect(sourceChannel, targetChannel) {
  try {
    let messageCount = 0;
    let mediaCount = 0;
    let lastMessageId = null;

    while (true) {
      const options = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;

      const messages = await sourceChannel.messages.fetch(options);

      if (messages.size === 0) break;

      messageCount += messages.size;

      for (const [, message] of messages) {
        const uploadTasks = [];

        // Processa attachments
        for (const [, attachment] of message.attachments) {
          if (isMediaFile(attachment.name)) {
            uploadTasks.push(
              downloadAndUploadFileDirect(
                attachment.url,
                attachment.name,
                targetChannel,
                message.author.username
              )
                .then(() => mediaCount++)
                .catch(err => console.error(`✗ Errore upload: ${err.message}`))
            );
          }
        }

        // Processa embed images
        for (const embed of message.embeds) {
          if (embed.image?.url) {
            uploadTasks.push(
              downloadAndUploadFileDirect(
                embed.image.url,
                `embed_${Date.now()}.png`,
                targetChannel,
                message.author.username
              )
                .then(() => mediaCount++)
                .catch(err => console.error(`✗ Errore upload: ${err.message}`))
            );
          }
        }

        if (uploadTasks.length > 0) {
          console.log(`   ⬇️ Trovati ${uploadTasks.length} media...`);
          await Promise.all(uploadTasks);
        }
      }

      lastMessageId = messages.last().id;
      console.log(`   ✓ Elaborati ${messages.size} messaggi`);

      await delay(1500); // Delay per evitare rate limit
    }

    console.log(`   📊 Totale: ${messageCount} messaggi, ${mediaCount} media uploadati`);

  } catch (error) {
    console.error(`Errore durante download/upload: ${error.message}`);
  }
}

/**
 * Scarica e invia file direttamente al canale
 */
async function downloadAndUploadFileDirect(fileUrl, filename, targetChannel, authorName) {
  try {
    const newFilename = `GRINDR_${authorName}_${filename}`;
    const filepath = path.join(tempDir, newFilename);

    // Scarica il file
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(filepath, response.data);

    // Invia il file
    try {
      await targetChannel.send({
        files: [filepath]
      });
    } catch (err) {
      // Se il file è troppo grande, prova con un semplice link
      if (err.message.includes('too large')) {
        await targetChannel.send(`**${newFilename}**\n${fileUrl}`);
      } else {
        throw err;
      }
    }

    // Elimina file temporaneo
    fs.unlinkSync(filepath);

    process.stdout.write('.');

  } catch (error) {
    throw new Error(`Errore invio diretto ${filename}: ${error.message}`);
  }
}

/**
 * Controlla se il file è media
 */
function isMediaFile(filename) {
  const mediaExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.mkv', '.avi'];
  return mediaExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pulizia directory temporanea
 */
function cleanupTempDir() {
  try {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tempDir, file));
      }
      fs.rmdirSync(tempDir);
      console.log('✓ Directory temporanea pulita');
    }
  } catch (error) {
    console.error('Errore durante cleanup:', error.message);
  }
}

client.login(TOKEN);
