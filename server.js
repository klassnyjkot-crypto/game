// server.js — Telegram bot + static site + file-based user storage (no DB)
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Telegraf } = require('telegraf');
const cors = require('cors');
const crypto = require('crypto');

// --- Настройки через переменные окружения (Render)
const BOT_TOKEN = process.env.BOT_TOKEN;
const REQUIRED_CHANNELS = (process.env.REQUIRED_CHANNELS || '') // comma separated, e.g. "mychannel,sponsor1"
  .split(',').map(s => s.trim()).filter(Boolean);
const WEB_APP_URL = process.env.WEB_APP_URL || ''; // e.g. https://your-service.onrender.com
const CLOTHING_LINK = process.env.CLOTHING_LINK || 'https://example.com/clothing';
const TECH_LINK = process.env.TECH_LINK || 'https://example.com/tech';
const PROMO_INTERVAL_MINUTES = Number(process.env.PROMO_INTERVAL_MINUTES || 1440); // default 24h
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // secret for admin API

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is not set. Set it in environment variables.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadUsers() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return []; // empty
  }
}
function saveUsers(users) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

let users = loadUsers(); // array of { telegram_id, username, first_name, token, last_seen }

function findUserById(tgId) {
  return users.find(u => u.telegram_id === tgId);
}
function addOrUpdateUser(from) {
  const tgId = from.id;
  let u = findUserById(tgId);
  if (!u) {
    u = {
      telegram_id: tgId,
      username: from.username || null,
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      token: crypto.randomBytes(10).toString('hex'),
      last_seen: new Date().toISOString()
    };
    users.push(u);
    saveUsers(users);
    return u;
  } else {
    u.username = from.username || u.username;
    u.first_name = from.first_name || u.first_name;
    u.last_name = from.last_name || u.last_name;
    u.last_seen = new Date().toISOString();
    saveUsers(users);
    return u;
  }
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Проверка подписки на все требуемые каналы
async function isMemberOfAllChannels(tgId) {
  if (!REQUIRED_CHANNELS.length) return true;
  for (const chRaw of REQUIRED_CHANNELS) {
    const ch = chRaw.startsWith('@') ? chRaw : `@${chRaw}`;
    try {
      const member = await bot.telegram.getChatMember(ch, tgId);
      const status = member && member.status;
      // считаем подписанными: member, creator, administrator, restricted
      if (status === 'left' || status === 'kicked' || !status) return false;
    } catch (e) {
      console.error('getChatMember error for', ch, e.message);
      // если бот не может проверить (не добавлен в канал) — считаем не подписанным
      return false;
    }
  }
  return true;
}

// --- Клавиатура меню
function mainMenuInline(token) {
  const playUrl = WEB_APP_URL ? `${WEB_APP_URL}?token=${token}` : `/?token=${token}`;
  return {
    inline_keyboard: [
      [{ text: 'Играть', web_app: { url: playUrl } }],
      [{ text: 'Каталог одежды', callback_data: 'catalog' }, { text: 'Купить технику', callback_data: 'tech' }]
    ]
  };
}

// /start handler
bot.start(async (ctx) => {
  const from = ctx.from;
  const u = addOrUpdateUser(from);
  const ok = await isMemberOfAllChannels(from.id);
  if (ok) {
    await ctx.reply('Добро пожаловать! Меню:', { reply_markup: mainMenuInline(u.token) });
  } else {
    const buttons = REQUIRED_CHANNELS.map(ch => ([{ text: `Подписаться: ${ch}`, url: `https://t.me/${ch.replace('@','')}` }]));
    buttons.push([{ text: 'Проверить подписку', callback_data: 'check_subs' }]);
    await ctx.reply('Для доступа к боту необходимо подписаться на наши каналы:', { reply_markup: { inline_keyboard: buttons } });
  }
});

// /menu command
bot.command('menu', async (ctx) => {
  const from = ctx.from;
  const u = addOrUpdateUser(from);
  const ok = await isMemberOfAllChannels(from.id);
  if (ok) {
    await ctx.reply('Меню:', { reply_markup: mainMenuInline(u.token) });
  } else {
    const buttons = REQUIRED_CHANNELS.map(ch => ([{ text: `Подписаться: ${ch}`, url: `https://t.me/${ch.replace('@','')}` }]));
    buttons.push([{ text: 'Проверить подписку', callback_data: 'check_subs' }]);
    await ctx.reply('Пожалуйста, подпишитесь на наши каналы чтобы продолжить:', { reply_markup: { inline_keyboard: buttons } });
  }
});

// callback handlers
bot.action('check_subs', async (ctx) => {
  const from = ctx.from;
  const u = addOrUpdateUser(from);
  const ok = await isMemberOfAllChannels(from.id);
  if (ok) {
    try {
      await ctx.editMessageText('Вы подписаны! Вот меню:', { reply_markup: mainMenuInline(u.token) });
    } catch (e) {
      await ctx.reply('Вы подписаны! Вот меню:', { reply_markup: mainMenuInline(u.token) });
    }
  } else {
    await ctx.answerCbQuery('Вы ещё не подписались на все указанные каналы.');
  }
});

bot.action('catalog', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(`*Каталог одежды*\nПосмотреть и купить: ${CLOTHING_LINK}`, { disable_web_page_preview: false });
});
bot.action('tech', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(`*Купить технику*\nКаталог: ${TECH_LINK}`, { disable_web_page_preview: false });
});

// --- HTTP API: endpoint for admin broadcast
app.post('/admin/broadcast', async (req, res) => {
  const provided = req.headers['x-admin-token'] || req.query.admin_token;
  if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  let sent = 0, failed = 0;
  // iterate a copy to avoid race conditions
  const usersCopy = users.slice();
  for (const user of usersCopy) {
    try {
      // Optional: check subscription before send; skip if not subscribed
      const subscribed = await isMemberOfAllChannels(user.telegram_id).catch(()=>false);
      if (!subscribed) continue;
      await bot.telegram.sendMessage(user.telegram_id, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Играть', web_app: { url: `${WEB_APP_URL}?token=${user.token}` } }],
            [{ text: 'Каталог одежды', url: CLOTHING_LINK }, { text: 'Купить технику', url: TECH_LINK }]
          ]
        }
      });
      sent++;
    } catch (e) {
      console.error('broadcast failed to', user.telegram_id, e.message);
      failed++;
    }
  }
  return res.json({ ok: true, sent, failed });
});

// health /ping
app.get('/ping', (req, res) => res.send({ ok: true }));

// start express and bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('HTTP server listening on', PORT);
  // launch bot (polling) — polling keeps it alive reliably
  await bot.launch();
  console.log('Bot launched (polling). Total users:', users.length);
});

// graceful shutdown
process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

// --- scheduled promo (optional)
const PROMO_MESSAGES = [
  '🔥 Новая подборка техники — заходи в каталог!',
  '🧥 Скидки на одежду у наших спонсоров — смотри каталог!',
  '⚡ Игра бросает вызов — побей рекорд и получи скидку!'
];
if (PROMO_INTERVAL_MINUTES > 0 && ADMIN_TOKEN) {
  setInterval(async () => {
    const text = PROMO_MESSAGES[Math.floor(Math.random()*PROMO_MESSAGES.length)];
    // send only to currently subscribed users
    for (const u of users.slice()) {
      try {
        const subscribed = await isMemberOfAllChannels(u.telegram_id).catch(()=>false);
        if (!subscribed) continue;
        await bot.telegram.sendMessage(u.telegram_id, text, {
          disable_notification: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Играть', web_app: { url: `${WEB_APP_URL}?token=${u.token}` } }],
              [{ text: 'Каталог одежды', url: CLOTHING_LINK }, { text: 'Купить технику', url: TECH_LINK }]
            ]
          }
        });
      } catch (e) {
        console.error('promo send failed to', u.telegram_id, e.message);
      }
    }
  }, Math.max(1, PROMO_INTERVAL_MINUTES) * 60 * 1000);
}
