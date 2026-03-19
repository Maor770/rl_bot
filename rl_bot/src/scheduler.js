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

function startScheduler() {
  console.log('[Scheduler] Starting cron jobs...');

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
