const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TOKEN = process.env.USER_TOKEN?.trim();

console.log('🔍 Token ricevuto:', !!TOKEN);
console.log('🔍 Lunghezza token:', TOKEN?.length);

if (!TOKEN || TOKEN.length < 50) {
  console.error('❌ TOKEN non valido!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

const CONFIG = {
  SOURCE_GUILD_ID: '1430987988606779455',
  CHANNEL_IDS: [
    '1431350770460004373',
    '1431350918267404501',
    '1431350851259072714'
  ],
  TARGET_GUILD_ID: process.env.TARGET_GUILD_ID?.trim()
};

let tempDir = './temp_media';

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

client.once('ready', async () => {
  console.log(`\n✅ CONNESSO: ${client.user.username}#${client.user.discriminator}`);
  console.log('⚠️  Usando account user - Viola ToS di Discord!\n');
  console.log('🚀 Inizio clonazione...\n');

  try {
    await startCloning();
  } catch (error) {
    console.error('❌ Errore:', error.message);
    process.exit(1);
  }
});

client.on('error', error => {
  console.error('❌ Errore client:', error);
});

client.on('shardError', error => {
  console.error('❌ Errore shard:', error);
});

async function startCloning() {
  try {
    console.log('📡 Caricamento guild...');
    const sourceGuild = await client.guilds.fetch(CONFIG.SOURCE_GUILD_ID);
    const targetGuild = await client.guilds.fetch(CONFIG.TARGET_GUILD_ID);

    console.log(`✓ Source: ${sourceGuild.name}`);
    console.log(`✓ Target: ${targetGuild.name}\n`);

    console.log('🔄 Clonazione canali...');
    const cloneTasks = CONFIG.CHANNEL_IDS.map(async (channelId) => {
      try {
        const sourceChannel = sourceGuild.channels.cache.get(channelId);
        if (!sourceChannel) {
          console.log(`⚠️ Canale ${channelId} non trovato`);
          return null;
        }

        const newName = `GRINDR_${sourceChannel.name}`;
        const newChannel = await targetGuild.channels.create({
          name: newName,
          type: ChannelType.GuildText,
          topic: sourceChannel.topic || '',
          nsfw: sourceChannel.nsfw
        });

        try {
          for (const [targetId, overwrite] of sourceChannel.permissionOverwrites.cache) {
            await newChannel.permissionOverwrites.create(targetId, {
              allow: overwrite.allow,
              deny: overwrite.deny
            });
          }
        } catch (e) {
          console.log(`⚠️ Permessi non copiati per ${newName}`);
        }

        console.log(`✓ Clonato: ${newName}`);
        return { sourceChannel, newChannel };
      } catch (error) {
        console.error(`✗ Errore canale ${channelId}:`, error.message);
        return null;
      }
    });

    const results = await Promise.all(cloneTasks);
    const cloned = results.filter(r => r !== null);
    console.log(`\n✅ Canali clonati: ${cloned.length}/${CONFIG.CHANNEL_IDS.length}\n`);

    console.log('📥 Scaricamento media...');
    for (const result of cloned) {
      if (!result) continue;
      const { sourceChannel, newChannel } = result;
      console.log(`\n📤 Elaborazione: ${sourceChannel.name}`);
      await downloadAndUpload(sourceChannel, newChannel);
    }

    console.log('\n✅ COMPLETATO!');
    cleanupTemp();
    process.exit(0);

  } catch (error) {
    console.error('❌ Errore fatale:', error);
    cleanupTemp();
    process.exit(1);
  }
}

async function downloadAndUpload(sourceChannel, targetChannel) {
  try {
    let msgCount = 0;
    let mediaCount = 0;
    let lastId = null;

    while (true) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;

      const msgs = await sourceChannel.messages.fetch(opts);
      if (msgs.size === 0) break;

      msgCount += msgs.size;

      for (const [, msg] of msgs) {
        const tasks = [];

        for (const [, att] of msg.attachments) {
          if (isMedia(att.name)) {
            tasks.push(
              uploadFile(att.url, att.name, targetChannel, msg.author.username)
                .then(() => mediaCount++)
                .catch(e => console.error(`✗ ${e.message}`))
            );
          }
        }

        for (const emb of msg.embeds) {
          if (emb.image?.url) {
            tasks.push(
              uploadFile(emb.image.url, `embed_${Date.now()}.png`, targetChannel, msg.author.username)
                .then(() => mediaCount++)
                .catch(e => console.error(`✗ ${e.message}`))
            );
          }
        }

        if (tasks.length > 0) {
          console.log(`⬇️ ${tasks.length} media`);
          await Promise.all(tasks);
        }
      }

      lastId = msgs.last().id;
      console.log(`✓ ${msgs.size} messaggi`);
      await delay(1500);
    }

    console.log(`📊 ${msgCount} msg, ${mediaCount} media`);
  } catch (error) {
    console.error(`Errore download:`, error.message);
  }
}

async function uploadFile(url, filename, channel, author) {
  try {
    const name = `GRINDR_${author}_${filename}`;
    const filepath = path.join(tempDir, name);

    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(filepath, res.data);

    try {
      await channel.send({ files: [filepath] });
    } catch (err) {
      if (err.message.includes('too large')) {
        await channel.send(`**${name}**\n${url}`);
      } else {
        throw err;
      }
    }

    fs.unlinkSync(filepath);
    process.stdout.write('.');
  } catch (error) {
    throw new Error(`Upload ${filename}: ${error.message}`);
  }
}

function isMedia(filename) {
  const ext = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.mkv', '.avi'];
  return ext.some(e => filename.toLowerCase().endsWith(e));
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cleanupTemp() {
  try {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      files.forEach(f => fs.unlinkSync(path.join(tempDir, f)));
      fs.rmdirSync(tempDir);
      console.log('✓ Pulizia completata');
    }
  } catch (e) {
    console.error('Errore cleanup:', e.message);
  }
}

console.log('🔐 Accesso...');
client.login(TOKEN).catch(err => {
  console.error('❌ Login fallito:', err.message);
  process.exit(1);
});
