'use strict';
require('dotenv').config();
const express = require('express');
const config  = require('./config');
const { initDB } = require('./db/postgres');
const { handleWebhookPayload } = require('./webhook');
const { startScheduler } = require('./scheduler');
const { notifyAdmin } = require('./modules/admin');

const app = express();
app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', version: '13.0.0', bot: 'רבי לילדים' });
});

// ── WEBHOOK VERIFY ────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
    console.log('[Webhook] Verified');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook] Verification failed');
  return res.sendStatus(403);
});

// ── WEBHOOK RECEIVE ───────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond immediately so Meta doesn't retry
  res.sendStatus(200);

  const phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID;

  try {
    await handleWebhookPayload(req.body, phoneNumberId);
  } catch (err) {
    console.error('[Server] Unhandled webhook error:', err.message, err.stack);
    notifyAdmin(`Unhandled error: ${err.message}`).catch(() => {});
  }
});

// ── ADMIN: CACHE CLEAR ────────────────────────────────────────────────────────
app.post('/admin/clear-cache', (req, res) => {
  const { clearAllCaches } = require('./db/sheets');
  clearAllCaches();
  res.json({ ok: true, message: 'Cache cleared' });
});

// ── STARTUP ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    startScheduler();

    app.listen(config.PORT, () => {
      console.log(`[Server] רבי לילדים Bot v13 running on port ${config.PORT}`);
      console.log(`[Server] Timezone: ${config.TZ}`);
    });
  } catch (err) {
    console.error('[Server] Startup error:', err.message);
    process.exit(1);
  }
}

start();
