import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// ===== ENV CHECK =====
const REQUIRED_ENVS = [
  'BOT_TOKEN',
  'ADMIN_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`❌ Missing env: ${key}`);
    process.exit(1);
  }
}

// ===== SUPABASE =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===== BOT =====
const bot = new Telegraf(process.env.BOT_TOKEN);

// 🔥 IMPORTANT: clear any old webhook / polling lock
await bot.telegram.deleteWebhook({ drop_pending_updates: true });

// ===== BASIC COMMANDS =====
bot.start(async (ctx) => {
  await ctx.reply('✅ Bot çalışıyor');
});

bot.command('admin', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) {
    return ctx.reply('⛔ Yetkin yok');
  }
  await ctx.reply('👑 Admin paneli aktif');
});

// ===== LAUNCH =====
await bot.launch();
console.log('🤖 Bot (Supabase) çalışıyor');

// ===== OPTIONAL WEBAPP (keeps Render happy if needed) =====
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => {
  console.log(`🌐 Health server running on ${PORT}`);
});

// ===== GRACEFUL SHUTDOWN =====
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
