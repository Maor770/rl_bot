'use strict';
const { google } = require('googleapis');
const db = require('../db/postgres');
const config = require('../config');

let _auth = null;

function getAuth() {
  if (_auth) return _auth;
  const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(raw);
  _auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return _auth;
}

async function clearAndWrite(sheets, spreadsheetId, sheetName, headers, rows) {
  // Clear sheet first
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: sheetName,
  });

  if (!rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers, ...rows] },
  });
}

async function syncUsersSheet(sheets, spreadsheetId) {
  const res = await db.query(`
    SELECT 
      phone,
      name,
      first_seen,
      last_interaction,
      share_tickets,
      daily_game_notify,
      state_json->>'lastMenu' as last_menu,
      state_json->>'hasSeenWelcome' as has_seen_welcome
    FROM users
    ORDER BY last_interaction DESC
    LIMIT 5000
  `);

  const headers = ['Phone', 'Name', 'First Seen', 'Last Interaction', 'Share Tickets', 'Daily Game Notify', 'Last Menu', 'Has Seen Welcome'];
  const rows = res.rows.map(r => [
    r.phone || '',
    r.name || '',
    r.first_seen ? new Date(r.first_seen).toLocaleString('he-IL') : '',
    r.last_interaction ? new Date(r.last_interaction).toLocaleString('he-IL') : '',
    r.share_tickets || 0,
    r.daily_game_notify ? 'TRUE' : 'FALSE',
    r.last_menu || '',
    r.has_seen_welcome || 'FALSE',
  ]);

  await clearAndWrite(sheets, spreadsheetId, 'Users_DB', headers, rows);
  console.log(`[Sync] Users: ${rows.length} rows`);
}

async function syncChildrenSheet(sheets, spreadsheetId) {
  const res = await db.query(`
    SELECT 
      c.child_id,
      c.phone,
      c.child_name,
      c.hebrew_birthday,
      c.reminder_time,
      c.diamonds,
      c.active_reminders,
      u.name as parent_name
    FROM children c
    LEFT JOIN users u ON u.phone = c.phone
    ORDER BY c.diamonds DESC
  `);

  const headers = ['Child ID', 'Phone', 'Child Name', 'Birthday', 'Reminder Time', 'Diamonds', 'Active Reminders', 'Parent Name'];
  const rows = res.rows.map(r => [
    r.child_id || '',
    r.phone || '',
    r.child_name || '',
    r.hebrew_birthday || '',
    r.reminder_time || '',
    r.diamonds || 0,
    r.active_reminders ? 'TRUE' : 'FALSE',
    r.parent_name || '',
  ]);

  await clearAndWrite(sheets, spreadsheetId, 'Children_DB', headers, rows);
  console.log(`[Sync] Children: ${rows.length} rows`);
}

async function syncLogsSheet(sheets, spreadsheetId) {
  // Last 2000 logs only
  const res = await db.query(`
    SELECT timestamp, direction, user_phone, message, type
    FROM logs
    ORDER BY timestamp DESC
    LIMIT 2000
  `);

  const headers = ['Timestamp', 'Direction', 'Phone', 'Message', 'Type'];
  const rows = res.rows.map(r => [
    r.timestamp ? new Date(r.timestamp).toLocaleString('he-IL') : '',
    r.direction || '',
    r.user_phone || '',
    String(r.message || '').slice(0, 200),
    r.type || '',
  ]);

  await clearAndWrite(sheets, spreadsheetId, 'Logs_DB', headers, rows);
  console.log(`[Sync] Logs: ${rows.length} rows`);
}

async function syncQuestionsSheet(sheets, spreadsheetId) {
  const res = await db.query(`
    SELECT 
      created_at, phone, name, message_text,
      question_type, bot_reply, matched_type,
      needs_human, send_reply, reply_sent
    FROM questions_log
    ORDER BY created_at DESC
    LIMIT 2000
  `);

  const headers = ['Created At', 'Phone', 'Name', 'Message', 'Type', 'Bot Reply', 'Matched Type', 'Needs Human', 'Send Reply', 'Reply Sent'];
  const rows = res.rows.map(r => [
    r.created_at ? new Date(r.created_at).toLocaleString('he-IL') : '',
    r.phone || '',
    r.name || '',
    String(r.message_text || '').slice(0, 300),
    r.question_type || '',
    String(r.bot_reply || '').slice(0, 300),
    r.matched_type || '',
    r.needs_human ? 'TRUE' : 'FALSE',
    r.send_reply ? 'TRUE' : 'FALSE',
    r.reply_sent ? 'TRUE' : 'FALSE',
  ]);

  await clearAndWrite(sheets, spreadsheetId, 'Questions_DB', headers, rows);
  console.log(`[Sync] Questions: ${rows.length} rows`);
}

async function syncStatsSheet(sheets, spreadsheetId) {
  const [
    totalUsers, newToday, newWeek,
    totalChildren, totalDiamonds,
    totalLogs, logsToday,
    totalQuestions, needsHuman
  ] = await Promise.all([
    db.query('SELECT COUNT(*) FROM users'),
    db.query("SELECT COUNT(*) FROM users WHERE first_seen >= NOW() - INTERVAL '1 day'"),
    db.query("SELECT COUNT(*) FROM users WHERE first_seen >= NOW() - INTERVAL '7 days'"),
    db.query('SELECT COUNT(*) FROM children'),
    db.query('SELECT COALESCE(SUM(diamonds), 0) FROM children'),
    db.query('SELECT COUNT(*) FROM logs'),
    db.query("SELECT COUNT(*) FROM logs WHERE timestamp >= NOW() - INTERVAL '1 day'"),
    db.query('SELECT COUNT(*) FROM questions_log'),
    db.query('SELECT COUNT(*) FROM questions_log WHERE needs_human = TRUE AND reply_sent = FALSE'),
  ]);

  const now = new Date().toLocaleString('he-IL');
  const headers = ['Metric', 'Value', 'Updated At'];
  const rows = [
    ['סה"כ משתמשים', totalUsers.rows[0].count, now],
    ['משתמשים חדשים היום', newToday.rows[0].count, now],
    ['משתמשים חדשים השבוע', newWeek.rows[0].count, now],
    ['סה"כ ילדים רשומים', totalChildren.rows[0].count, now],
    ['סה"כ יהלומים', totalDiamonds.rows[0].coalesce, now],
    ['סה"כ הודעות', totalLogs.rows[0].count, now],
    ['הודעות היום', logsToday.rows[0].count, now],
    ['סה"כ חיפושים', totalQuestions.rows[0].count, now],
    ['ממתינים לתשובה אנושית', needsHuman.rows[0].count, now],
  ];

  await clearAndWrite(sheets, spreadsheetId, 'Stats_DB', headers, rows);
  console.log('[Sync] Stats updated');
}

async function runSync() {
  if (!config.SPREADSHEET_ID) {
    console.log('[Sync] No SPREADSHEET_ID — skipping');
    return;
  }

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    await Promise.all([
      syncStatsSheet(sheets, config.SPREADSHEET_ID),
      syncUsersSheet(sheets, config.SPREADSHEET_ID),
      syncChildrenSheet(sheets, config.SPREADSHEET_ID),
      syncLogsSheet(sheets, config.SPREADSHEET_ID),
      syncQuestionsSheet(sheets, config.SPREADSHEET_ID),
    ]);

    console.log('[Sync] All sheets synced successfully');
  } catch (e) {
    console.error('[Sync] Error:', e.message);
  }
}

module.exports = { runSync };
