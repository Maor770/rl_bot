'use strict';
const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (err) => {
  console.error('[PG] Unexpected pool error:', err.message);
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// ── INIT ─────────────────────────────────────────────────────────────────────

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      phone VARCHAR(20) PRIMARY KEY,
      name TEXT DEFAULT '',
      first_seen TIMESTAMP DEFAULT NOW(),
      last_interaction TIMESTAMP DEFAULT NOW(),
      state_json JSONB DEFAULT '{}',
      share_tickets INTEGER DEFAULT 0,
      daily_game_notify BOOLEAN DEFAULT FALSE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT NOW(),
      direction TEXT,
      user_phone TEXT,
      message TEXT,
      type TEXT,
      meta_json JSONB DEFAULT '{}'
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS questions_log (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      phone TEXT,
      name TEXT DEFAULT '',
      message_text TEXT DEFAULT '',
      question_type TEXT DEFAULT '',
      bot_reply TEXT DEFAULT '',
      matched_type TEXT DEFAULT '',
      matched_ids TEXT DEFAULT '',
      needs_human BOOLEAN DEFAULT FALSE,
      admin_answer TEXT DEFAULT '',
      send_reply BOOLEAN DEFAULT FALSE,
      reply_sent BOOLEAN DEFAULT FALSE,
      reply_sent_at TIMESTAMP,
      notes TEXT DEFAULT ''
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS children (
      child_id TEXT PRIMARY KEY,
      phone TEXT,
      child_name TEXT DEFAULT '',
      hebrew_birthday TEXT DEFAULT '',
      reminder_time TEXT DEFAULT '17:00',
      diamonds INTEGER DEFAULT 0,
      completed_items TEXT DEFAULT '',
      active_reminders BOOLEAN DEFAULT TRUE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS diamonds_log (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT NOW(),
      phone TEXT,
      child_id TEXT,
      action_type TEXT,
      item_id TEXT,
      diamonds_change INTEGER DEFAULT 0
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS raffles (
      id SERIAL PRIMARY KEY,
      raffle_date DATE,
      status TEXT DEFAULT 'Pending',
      winner_child_id TEXT DEFAULT '',
      coupon_code TEXT DEFAULT '',
      raffle_type TEXT DEFAULT 'Diamonds',
      hebrew_date TEXT DEFAULT ''
    )
  `);

  console.log('[DB] Tables initialized');
}

// ── USERS ─────────────────────────────────────────────────────────────────────

async function getUser(phone) {
  const res = await query('SELECT * FROM users WHERE phone = $1', [phone]);
  return res.rows[0] || null;
}

async function upsertUser(phone, name) {
  await query(`
    INSERT INTO users (phone, name, last_interaction)
    VALUES ($1, $2, NOW())
    ON CONFLICT (phone) DO UPDATE SET
      last_interaction = NOW(),
      name = CASE WHEN $2 != '' THEN $2 ELSE users.name END
  `, [phone, name || '']);
}

async function getUserState(phone) {
  const res = await query('SELECT state_json FROM users WHERE phone = $1', [phone]);
  if (!res.rows[0]) return defaultState();
  try { return { ...defaultState(), ...(res.rows[0].state_json || {}) }; }
  catch (e) { return defaultState(); }
}

async function setUserState(phone, patch) {
  const current = await getUserState(phone);
  const merged = { ...current, ...patch };
  await query(`
    INSERT INTO users (phone, state_json)
    VALUES ($1, $2)
    ON CONFLICT (phone) DO UPDATE SET state_json = $2
  `, [phone, JSON.stringify(merged)]);
  return merged;
}

function defaultState() {
  return {
    started: false,
    hasSeenWelcome: false,
    lastInteractionMs: 0,
    lastMenu: '',
    currentListKey: '',
    currentListTitle: '',
    currentOffset: 0,
    pendingQuery: '',
    expectedInput: '',
    activeChildId: '',
    activeMissionId: '',
    postGameSentAt: 0,
  };
}

async function setUserDailyGameNotify(phone, shouldNotify) {
  await query(`
    INSERT INTO users (phone, daily_game_notify)
    VALUES ($1, $2)
    ON CONFLICT (phone) DO UPDATE SET daily_game_notify = $2
  `, [phone, shouldNotify]);
}

async function getUsersWithNotify() {
  const res = await query('SELECT phone FROM users WHERE daily_game_notify = TRUE');
  return res.rows.map(r => r.phone);
}

async function getShareTickets(phone) {
  const res = await query('SELECT share_tickets FROM users WHERE phone = $1', [phone]);
  return Number((res.rows[0] || {}).share_tickets || 0);
}

async function addShareTicket(phone) {
  await query(`
    INSERT INTO users (phone, share_tickets)
    VALUES ($1, 1)
    ON CONFLICT (phone) DO UPDATE SET share_tickets = users.share_tickets + 1
  `, [phone]);
  const res = await query('SELECT share_tickets FROM users WHERE phone = $1', [phone]);
  return Number((res.rows[0] || {}).share_tickets || 0);
}

async function resetAllShareTickets() {
  await query('UPDATE users SET share_tickets = 0');
}

async function getAllUsers() {
  const res = await query('SELECT * FROM users');
  return res.rows;
}

// ── LOGS ──────────────────────────────────────────────────────────────────────

async function insertLog(direction, userPhone, message, type, meta = {}) {
  await query(
    'INSERT INTO logs (direction, user_phone, message, type, meta_json) VALUES ($1,$2,$3,$4,$5)',
    [direction, userPhone || '', String(message || ''), type, JSON.stringify(meta)]
  );
}

// ── QUESTIONS LOG ─────────────────────────────────────────────────────────────

async function insertQuestion(data) {
  await query(`
    INSERT INTO questions_log
      (phone, name, message_text, question_type, bot_reply, matched_type, matched_ids, needs_human)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [
    data.phone || '',
    data.name || '',
    data.message || '',
    data.questionType || '',
    data.botReply || '',
    data.matchedType || '',
    data.matchedIds || '',
    !!data.needsHumanReply,
  ]);
}

async function getPendingReplies() {
  const res = await query(`
    SELECT id, phone, admin_answer
    FROM questions_log
    WHERE send_reply = TRUE AND reply_sent = FALSE AND admin_answer != ''
  `);
  return res.rows;
}

async function markReplySent(id) {
  await query(
    'UPDATE questions_log SET reply_sent = TRUE, reply_sent_at = NOW() WHERE id = $1',
    [id]
  );
}

// ── CHILDREN ──────────────────────────────────────────────────────────────────

async function getChildrenForUser(phone) {
  const res = await query('SELECT * FROM children WHERE phone = $1', [phone]);
  return res.rows.map(rowToChild);
}

async function getChildById(childId) {
  const res = await query('SELECT * FROM children WHERE child_id = $1', [childId]);
  return res.rows[0] ? rowToChild(res.rows[0]) : null;
}

async function getAllChildrenSorted() {
  const res = await query('SELECT * FROM children ORDER BY diamonds DESC');
  return res.rows.map(rowToChild);
}

async function addChild(phone, childId, name, birthday) {
  await query(`
    INSERT INTO children (child_id, phone, child_name, hebrew_birthday, reminder_time, diamonds, completed_items, active_reminders)
    VALUES ($1,$2,$3,$4,'17:00',0,'',TRUE)
    ON CONFLICT (child_id) DO NOTHING
  `, [childId, phone, name, birthday || '']);
}

async function updateChildReminderTime(childId, time) {
  await query('UPDATE children SET reminder_time = $1 WHERE child_id = $2', [time, childId]);
}

async function rewardDiamonds(childId, amount, type, itemId, phone) {
  await query('UPDATE children SET diamonds = diamonds + $1 WHERE child_id = $2', [amount, childId]);
  await query(
    'INSERT INTO diamonds_log (phone, child_id, action_type, item_id, diamonds_change) VALUES ($1,$2,$3,$4,$5)',
    [phone || '', childId, type, itemId, amount]
  );
}

async function checkIfCompleted(childId, itemId) {
  const child = await getChildById(childId);
  if (!child) return false;
  return String(child.completed || '').split(',').includes(String(itemId));
}

async function markCompleted(childId, itemId) {
  const child = await getChildById(childId);
  if (!child) return;
  const current = String(child.completed || '');
  const updated = current ? `${current},${itemId}` : itemId;
  await query('UPDATE children SET completed_items = $1 WHERE child_id = $2', [updated, childId]);
}

async function deactivateReminders(phone) {
  await query('UPDATE children SET active_reminders = FALSE WHERE phone = $1', [phone]);
}

async function activateReminders(phone) {
  await query('UPDATE children SET active_reminders = TRUE WHERE phone = $1', [phone]);
}

async function getChildrenDueForReminder(hour) {
  // hour format: "17:00"
  const res = await query(
    'SELECT * FROM children WHERE reminder_time = $1 AND active_reminders = TRUE',
    [hour]
  );
  return res.rows.map(rowToChild);
}

async function resetDiamondsForRaffle() {
  // Deduct used tickets (multiples of 500) from all children
  const res = await query('SELECT child_id, diamonds, phone FROM children WHERE diamonds >= 500');
  for (const row of res.rows) {
    const used = Math.floor(row.diamonds / 500) * 500;
    if (used > 0) {
      await query('UPDATE children SET diamonds = diamonds - $1 WHERE child_id = $2', [used, row.child_id]);
      await query(
        'INSERT INTO diamonds_log (phone, child_id, action_type, item_id, diamonds_change) VALUES ($1,$2,$3,$4,$5)',
        [row.phone, row.child_id, 'Raffle_Reset', 'raffle', -used]
      );
    }
  }
}

function rowToChild(row) {
  return {
    childId: row.child_id,
    phone: row.phone,
    name: row.child_name,
    birthday: row.hebrew_birthday || '',
    reminderTime: row.reminder_time || '17:00',
    diamonds: Number(row.diamonds || 0),
    completed: row.completed_items || '',
    active: row.active_reminders !== false,
  };
}

module.exports = {
  initDB, query,
  // Users
  getUser, upsertUser, getUserState, setUserState, defaultState,
  setUserDailyGameNotify, getUsersWithNotify, getShareTickets,
  addShareTicket, resetAllShareTickets, getAllUsers,
  // Logs
  insertLog,
  // Questions
  insertQuestion, getPendingReplies, markReplySent,
  // Children
  getChildrenForUser, getChildById, getAllChildrenSorted,
  addChild, updateChildReminderTime, rewardDiamonds,
  checkIfCompleted, markCompleted,
  deactivateReminders, activateReminders,
  getChildrenDueForReminder, resetDiamondsForRaffle,
};
