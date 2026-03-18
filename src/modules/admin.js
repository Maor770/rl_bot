'use strict';
const config = require('../config');
const { sendText } = require('../whatsapp');
const { normalizePhone, nowString } = require('../utils');
const db = require('../db/postgres');

async function notifyAdmin(errorText) {
  const adminPhone = normalizePhone(config.ADMIN_PHONE);
  if (!adminPhone) return;
  try {
    const msg = `🚨 *שגיאה בבוט רבי לילדים*\n⏰ ${nowString()}\n❌ ${String(errorText || '').slice(0, 300)}`;
    await sendText(adminPhone, msg);
  } catch (e) {
    console.error('[Admin] Failed to notify admin:', e.message);
  }
}

async function sendManualReplies() {
  const pending = await db.getPendingReplies();
  for (const row of pending) {
    if (!row.phone || !row.admin_answer) continue;
    try {
      await sendText(normalizePhone(row.phone), row.admin_answer);
      await db.markReplySent(row.id);
      console.log(`[Admin] Sent manual reply to ${row.phone}`);
    } catch (e) {
      console.error(`[Admin] Failed to send reply to ${row.phone}:`, e.message);
    }
  }
}

module.exports = { notifyAdmin, sendManualReplies };
