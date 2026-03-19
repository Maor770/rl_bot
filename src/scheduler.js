'use strict';
const cron = require('node-cron');
const dayjs = require('dayjs');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);
dayjs.extend(timezone);

const config = require('./config');
const { sendScheduledReminders, getTodayRaffleType, sendFomoReminders, executeRaffle } = require('./modules/game');
const { sendManualReplies } = require('./modules/admin');
const { runSync } = require('./modules/sync');
const db = require('./db/postgres');
const wa = require('./whatsapp');

const POST_GAME_TIMEOUT_MS = 5 * 60 * 1000; // 5 דקות
const postGameSent = new Set(); // מניעת כפילויות באותה session

async function sendPostGameMessages() {
  const now = Date.now();
  try {
    const result = await db.query(
      `SELECT phone, state_json FROM users
       WHERE state_json->>'hasSeenWelcome' = 'true'
         AND state_json->>'lastInteractionMs' IS NOT NULL
         AND (state_json->>'postGameSentAt') IS NULL
         OR (state_json->>'postGameSentAt')::bigint < (state_json->>'lastInteractionMs')::bigint`
    );
    for (const row of result.rows) {
      const phone = row.phone;
      if (postGameSent.has(phone)) continue;
      let state = {};
      try { state = row.state_json || {}; } catch (e) { continue; }
      const lastMs = Number(state.lastInteractionMs || 0);
      if (!lastMs) continue;
      const elapsed = now - lastMs;
      if (elapsed < POST_GAME_TIMEOUT_MS || elapsed > POST_GAME_TIMEOUT_MS * 12) continue; // 5 דקות עד שעה
      const postGameSentAt = Number(state.postGameSentAt || 0);
      if (postGameSentAt >= lastMs) continue; // כבר נשלח אחרי האינטראקציה האחרונה
      const expectedInput = String(state.expectedInput || '');
      if (expectedInput) continue; // משתמש באמצע תהליך
      postGameSent.add(phone);
      try {
        await wa.sendButtonsAndLog(phone,
          'היי 👋\n' +
          'כאן חנוך מרבי לילדים 😊\n\n' +
          'שמחנו שהשתמשתם בבוט — נשמח לשמוע איך היה!\n' +
          'יש הצעות לשיפור? *ספרו לנו* 👇\n\n' +
          'ואם נהנתם — *אנא שתפו* את ההודעה המוכנה עם הורים נוספים\n' +
          'כדי שעוד ילדים יהנו 🎉\n\n' +
          '(ויש גם הגרלה בין כל מי שמשתף! 🎟️)',
          [
            { id: 'game_feedback', title: '💬 ספרו לנו מה חשבתם' },
            { id: 'game_referral', title: '📲 אני רוצה לשתף!' },
          ],
          { action: 'post_game_message' }
        );
        await db.setUserState(phone, { postGameSentAt: now });
        console.log(`[PostGame] Sent to ${phone}`);
      } catch (e) {
        console.error(`[PostGame] Error for ${phone}:`, e.message);
      }
      setTimeout(() => postGameSent.delete(phone), 60 * 60 * 1000); // נקה אחרי שעה
    }
  } catch (e) {
    console.error('[PostGame] Query error:', e.message);
  }
}

function startScheduler() {
  console.log('[Scheduler] Starting cron jobs...');

  // ── POST GAME MESSAGE — כל דקה ───────────────────────────────────────────
  cron.schedule('* * * * *', async () => {
    try { await sendPostGameMessages(); }
    catch (e) { console.error('[Scheduler] postGame error:', e.message); }
  }, { timezone: config.TZ });

  // ── HOURLY GAME ENGINE ────────────────────────────────────────────────────
  cron.schedule('0 * * * *', async () => {
    const now = dayjs().tz(config.TZ);
    const currentHour = `${now.hour()}:00`;
    const todayStr = now.format('YYYY-MM-DD');
    console.log(`[Scheduler] Hourly tick — ${currentHour}`);

    try { await sendScheduledReminders(currentHour); }
    catch (e) { console.error('[Scheduler] sendScheduledReminders error:', e.message); }

    try {
      const raffleType = await getTodayRaffleType(todayStr);
      if (raffleType) {
        if (now.hour() === 15) await sendFomoReminders(raffleType);
        if (now.hour() === 18) await executeRaffle(raffleType);
      }
    } catch (e) { console.error('[Scheduler] Raffle error:', e.message); }
  }, { timezone: config.TZ });

  // ── MANUAL REPLIES — כל 2 דקות ───────────────────────────────────────────
  cron.schedule('*/2 * * * *', async () => {
    try { await sendManualReplies(); }
    catch (e) { console.error('[Scheduler] sendManualReplies error:', e.message); }
  }, { timezone: config.TZ });

  // ── SYNC PostgreSQL → Sheets — כל 10 דקות ────────────────────────────────
  cron.schedule('*/10 * * * *', async () => {
    try { await runSync(); }
    catch (e) { console.error('[Scheduler] sync error:', e.message); }
  }, { timezone: config.TZ });

  console.log('[Scheduler] All cron jobs registered');
}

module.exports = { startScheduler };
