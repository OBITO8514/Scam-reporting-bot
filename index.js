require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const nodemailer = require('nodemailer');

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing');

const OWNER_IDS = (process.env.OWNER_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const REPORT_TO = process.env.REPORT_TO || 'abuse@telegram.org';
const REPORTER_NAME = process.env.REPORTER_NAME || 'Telegram User';
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // Gmail limit is 25MB

// Load up to 5 Gmail accounts
const accounts = [];
for (let i = 1; i <= 5; i++) {
  const user = process.env[`GMAIL_${i}_USER`];
  const pass = process.env[`GMAIL_${i}_PASS`];
  if (user && pass) {
    accounts.push({
      user,
      transporter: nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass: pass.replace(/\s+/g, '') },
      }),
    });
  }
}
if (!accounts.length) throw new Error('No Gmail accounts configured');

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map(); // userId -> { step, data, files }

// ---------- HELPERS ----------
const isOwner = (ctx) =>
  !OWNER_IDS.length || OWNER_IDS.includes(String(ctx.from.id));

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function buildReport(ctx, d) {
  const reporterHandle = ctx.from.username ? `@${ctx.from.username}` : 'no username';
  return {
    subject: `Scam Report: Telegram account ${d.scammer}`,
    text: `Hello Telegram Abuse Team,

I am writing to report a Telegram account that scammed me. Details are below.

REPORTED ACCOUNT
Username / ID: ${d.scammer}

WHAT HAPPENED
${d.story}

AMOUNT LOST
${d.amount}

DATE OF INCIDENT
${d.date}

EVIDENCE
${d.fileCount ? `${d.fileCount} file(s) attached (screenshots / proof of the conversation and payment).` : 'No attachments.'}

REPORTER
Name: ${REPORTER_NAME}
Telegram: ${reporterHandle}
Telegram ID: ${ctx.from.id}

I kindly request that you investigate this account and take appropriate action, including suspension or a ban, to protect other users from being scammed. I can provide further evidence if needed.

Thank you.
${REPORTER_NAME}`,
  };
}

async function downloadFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- COMMANDS ----------
bot.start((ctx) => {
  if (!isOwner(ctx)) return ctx.reply('This bot is private.');
  return ctx.reply(
    'Scam Report Bot\n\n/report - start a new report\n/cancel - cancel the current report\n/accounts - show Gmail accounts in use'
  );
});

bot.command('accounts', (ctx) => {
  if (!isOwner(ctx)) return;
  ctx.reply(`Sending from ${accounts.length} account(s):\n` + accounts.map((a, i) => `${i + 1}. ${a.user}`).join('\n'));
});

bot.command('report', (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('This bot is private.');
  sessions.set(ctx.from.id, { step: 'scammer', data: {}, files: [], bytes: 0 });
  ctx.reply("Send the scammer's @username or ID.");
});

bot.command('cancel', (ctx) => {
  sessions.delete(ctx.from.id);
  ctx.reply('Report cancelled.');
});

bot.command('done', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s || s.step !== 'evidence') return;
  await showPreview(ctx, s);
});

// ---------- FLOW ----------
async function showPreview(ctx, s) {
  s.data.fileCount = s.files.length;
  s.step = 'confirm';
  const r = buildReport(ctx, s.data);
  const preview = `To: ${REPORT_TO}\nSubject: ${r.subject}\n\n${r.text}`;
  await ctx.reply(preview.slice(0, 3900));
  await ctx.reply(
    `Send this from ${accounts.length} Gmail account(s)?`,
    Markup.inlineKeyboard([
      Markup.button.callback('Send now', 'send'),
      Markup.button.callback('Cancel', 'cancel'),
    ])
  );
}

bot.on('text', async (ctx) => {
  if (!isOwner(ctx)) return;
  const s = sessions.get(ctx.from.id);
  if (!s) return;
  const t = ctx.message.text.trim();

  switch (s.step) {
    case 'scammer':
      s.data.scammer = t;
      s.step = 'story';
      return ctx.reply('Explain what happened, step by step.');
    case 'story':
      s.data.story = t;
      s.step = 'amount';
      return ctx.reply('How much did you lose? (amount and currency)');
    case 'amount':
      s.data.amount = t;
      s.step = 'date';
      return ctx.reply('Date of the incident?');
    case 'date':
      s.data.date = t;
      s.step = 'evidence';
      return ctx.reply(`Send screenshots or files as proof (up to ${MAX_FILES}). Send /done when finished.`);
    case 'evidence':
      return ctx.reply('Send a photo or file, or /done to continue.');
  }
});

async function addEvidence(ctx, fileId, name, size) {
  const s = sessions.get(ctx.from.id);
  if (!s || s.step !== 'evidence') return;
  if (s.files.length >= MAX_FILES) return ctx.reply(`Maximum of ${MAX_FILES} files reached. Send /done.`);
  if (s.bytes + (size || 0) > MAX_TOTAL_BYTES) return ctx.reply('Total attachment size is too large. Send /done.');
  try {
    const content = await downloadFile(ctx, fileId);
    s.files.push({ filename: name, content });
    s.bytes += content.length;
    ctx.reply(`Saved ${s.files.length}/${MAX_FILES}. Send more or /done.`);
  } catch (e) {
    ctx.reply('Could not download that file. Try again.');
  }
}

bot.on('photo', (ctx) => {
  if (!isOwner(ctx)) return;
  const p = ctx.message.photo[ctx.message.photo.length - 1];
  return addEvidence(ctx, p.file_id, `evidence_${Date.now()}.jpg`, p.file_size);
});

bot.on('document', (ctx) => {
  if (!isOwner(ctx)) return;
  const d = ctx.message.document;
  return addEvidence(ctx, d.file_id, d.file_name || `evidence_${Date.now()}`, d.file_size);
});

// ---------- SEND ----------
bot.action('cancel', async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.answerCbQuery();
  ctx.editMessageText('Report cancelled.');
});

bot.action('send', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  await ctx.answerCbQuery();
  if (!s || s.step !== 'confirm') return;
  s.step = 'sending';
  await ctx.editMessageText('Sending...');

  const r = buildReport(ctx, s.data);
  const results = await Promise.allSettled(
    accounts.map((a) =>
      a.transporter.sendMail({
        from: `"${REPORTER_NAME}" <${a.user}>`,
        to: REPORT_TO,
        subject: r.subject,
        text: r.text,
        attachments: s.files,
      })
    )
  );

  const lines = results.map((res, i) =>
    res.status === 'fulfilled'
      ? `✅ ${accounts[i].user}`
      : `❌ ${accounts[i].user}: ${esc(res.reason && res.reason.message ? res.reason.message : 'failed').slice(0, 120)}`
  );
  sessions.delete(ctx.from.id);
  ctx.reply(`Report sent to ${REPORT_TO}\n\n${lines.join('\n')}`);
});

bot.catch((err) => console.error('Bot error:', err));

// ---------- START ----------
http
  .createServer((_, res) => res.end('Scam Report Bot running'))
  .listen(process.env.PORT || 3000);

bot.launch().then(() => console.log(`Bot running with ${accounts.length} Gmail account(s)`));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
