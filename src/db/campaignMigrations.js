'use strict';
const { query } = require('./postgres');

async function runCampaignMigrations() {
  // Campaigns
  await query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      message_type     TEXT NOT NULL DEFAULT 'utility',  -- 'utility' | 'marketing'
      template_name    TEXT DEFAULT '',
      body_text        TEXT DEFAULT '',
      image_url        TEXT DEFAULT '',
      buttons          JSONB DEFAULT '[]',
      contact_list     TEXT DEFAULT '',         -- 'upload' or sheet name
      country_filter   TEXT DEFAULT 'all',      -- 'all' | 'israel' | 'us' | 'canada' | 'europe'
      scheduled_date   DATE,
      send_hour_local  INTEGER DEFAULT 10,      -- 9–21
      rate_per_minute  INTEGER DEFAULT 20,
      status           TEXT DEFAULT 'draft',    -- draft | approved | sending | done | failed | paused
      meta_template_status TEXT DEFAULT '',     -- pending | approved | rejected
      total_recipients INTEGER DEFAULT 0,
      sent_count       INTEGER DEFAULT 0,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_at       TIMESTAMP DEFAULT NOW()
    )
  `);

  // One row per recipient per campaign
  await query(`
    CREATE TABLE IF NOT EXISTS campaign_logs (
      id             SERIAL PRIMARY KEY,
      campaign_id    INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      phone          TEXT NOT NULL,
      display_name   TEXT DEFAULT '',
      timezone_group TEXT DEFAULT 'israel',
      message_id     TEXT DEFAULT '',   -- Meta message ID — for read receipt matching
      status         TEXT DEFAULT 'pending', -- pending | sent | read | clicked | failed
      button_clicked TEXT DEFAULT '',   -- which button title was clicked
      sent_at        TIMESTAMP,
      read_at        TIMESTAMP,
      clicked_at     TIMESTAMP,
      error_text     TEXT DEFAULT '',
      created_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_cl_campaign_id  ON campaign_logs(campaign_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cl_phone        ON campaign_logs(phone)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cl_message_id   ON campaign_logs(message_id) WHERE message_id != ''`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cl_status       ON campaign_logs(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)`);

  console.log('[CampaignMigrations] Done');
}

// ── Campaign DB helpers ───────────────────────────────────────────────────────

async function getCampaign(id) {
  const res = await query('SELECT * FROM campaigns WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function listCampaigns() {
  const res = await query('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 100');
  return res.rows;
}

async function createCampaign(data) {
  const res = await query(`
    INSERT INTO campaigns
      (name, message_type, template_name, body_text, image_url, buttons,
       contact_list, country_filter, scheduled_date, send_hour_local, rate_per_minute)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [
    data.name || 'קמפיין חדש',
    data.message_type || 'utility',
    data.template_name || '',
    data.body_text || '',
    data.image_url || '',
    JSON.stringify(data.buttons || []),
    data.contact_list || '',
    data.country_filter || 'all',
    data.scheduled_date || null,
    Number(data.send_hour_local || 10),
    Number(data.rate_per_minute || 20),
  ]);
  return res.rows[0];
}

async function updateCampaign(id, data) {
  const fields = [];
  const vals = [];
  let idx = 1;

  const allowed = [
    'name','message_type','template_name','body_text','image_url',
    'contact_list','country_filter','scheduled_date',
    'send_hour_local','rate_per_minute','status','meta_template_status',
    'total_recipients','sent_count'
  ];

  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      vals.push(data[key]);
    }
  }
  // buttons is JSONB
  if (data.buttons !== undefined) {
    fields.push(`buttons = $${idx++}`);
    vals.push(JSON.stringify(data.buttons));
  }

  if (!fields.length) return getCampaign(id);

  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(
    `UPDATE campaigns SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return res.rows[0];
}

async function insertCampaignLog(campaignId, phone, displayName, timezoneGroup) {
  const res = await query(`
    INSERT INTO campaign_logs (campaign_id, phone, display_name, timezone_group)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [campaignId, phone, displayName || '', timezoneGroup || 'israel']);
  return res.rows[0];
}

async function markLogSent(logId, messageId) {
  await query(
    `UPDATE campaign_logs SET status='sent', message_id=$1, sent_at=NOW() WHERE id=$2`,
    [messageId || '', logId]
  );
}

async function markLogFailed(logId, errorText) {
  await query(
    `UPDATE campaign_logs SET status='failed', error_text=$1 WHERE id=$2`,
    [String(errorText || '').slice(0, 500), logId]
  );
}

async function markLogRead(messageId) {
  await query(
    `UPDATE campaign_logs SET status='read', read_at=NOW()
     WHERE message_id=$1 AND status='sent'`,
    [messageId]
  );
}

async function markLogClicked(messageId, buttonTitle) {
  await query(
    `UPDATE campaign_logs
     SET status='clicked', button_clicked=$1, clicked_at=NOW()
     WHERE message_id=$2`,
    [buttonTitle || '', messageId]
  );
}

async function getCampaignStats(campaignId) {
  const res = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status != 'pending') AS total_sent,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent,
      COUNT(*) FILTER (WHERE status = 'read')     AS read_count,
      COUNT(*) FILTER (WHERE status = 'clicked')  AS clicked,
      COUNT(*) FILTER (WHERE status = 'failed')   AS failed,
      COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
      COUNT(*)                                     AS total,
      AVG(EXTRACT(EPOCH FROM (read_at - sent_at))/60)
        FILTER (WHERE read_at IS NOT NULL AND sent_at IS NOT NULL)
        AS avg_min_to_read,
      AVG(EXTRACT(EPOCH FROM (clicked_at - read_at))/60)
        FILTER (WHERE clicked_at IS NOT NULL AND read_at IS NOT NULL)
        AS avg_min_to_click
    FROM campaign_logs
    WHERE campaign_id = $1
  `, [campaignId]);

  const byGroup = await query(`
    SELECT timezone_group, status, COUNT(*) as cnt
    FROM campaign_logs
    WHERE campaign_id = $1
    GROUP BY timezone_group, status
    ORDER BY timezone_group, status
  `, [campaignId]);

  const byButton = await query(`
    SELECT button_clicked, COUNT(*) as cnt
    FROM campaign_logs
    WHERE campaign_id = $1 AND status='clicked' AND button_clicked != ''
    GROUP BY button_clicked
    ORDER BY cnt DESC
  `, [campaignId]);

  return {
    summary: res.rows[0],
    byGroup: byGroup.rows,
    byButton: byButton.rows,
  };
}

async function getPendingLogs(campaignId) {
  const res = await query(
    `SELECT * FROM campaign_logs WHERE campaign_id=$1 AND status='pending' ORDER BY id`,
    [campaignId]
  );
  return res.rows;
}

async function getGlobalStats() {
  const [
    totalUsers, activeToday, activeWeek,
    totalMessages, messagesToday,
    totalSearches, noMatch,
    postGameClicks,
    topButtons
  ] = await Promise.all([
    query(`SELECT COUNT(*) FROM users`),
    query(`SELECT COUNT(*) FROM users WHERE last_interaction >= NOW() - INTERVAL '1 day'`),
    query(`SELECT COUNT(*) FROM users WHERE last_interaction >= NOW() - INTERVAL '7 days'`),
    query(`SELECT COUNT(*) FROM logs WHERE direction='inbound'`),
    query(`SELECT COUNT(*) FROM logs WHERE direction='inbound' AND timestamp >= NOW() - INTERVAL '1 day'`),
    query(`SELECT COUNT(*) FROM questions_log`),
    query(`SELECT COUNT(*) FROM questions_log WHERE matched_type='none'`),
    query(`SELECT COUNT(*) FROM logs WHERE meta_json->>'action'='post_game_message' AND direction='bot'`),
    query(`
      SELECT meta_json->>'action' as action, COUNT(*) as cnt
      FROM logs WHERE direction='bot' AND meta_json->>'action' IS NOT NULL
      GROUP BY action ORDER BY cnt DESC LIMIT 10
    `),
  ]);

  // Peak hours
  const peakHours = await query(`
    SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as cnt
    FROM logs WHERE direction='inbound'
    AND timestamp >= NOW() - INTERVAL '7 days'
    GROUP BY hour ORDER BY hour
  `);

  // New users over time (last 30 days)
  const newUsersDaily = await query(`
    SELECT DATE(first_seen) as date, COUNT(*) as cnt
    FROM users
    WHERE first_seen >= NOW() - INTERVAL '30 days'
    GROUP BY date ORDER BY date
  `);

  // Search success rate
  const searchSuccess = await query(`
    SELECT
      COUNT(*) FILTER (WHERE matched_type != 'none') as success,
      COUNT(*) FILTER (WHERE matched_type = 'none')  as fail,
      COUNT(*) as total
    FROM questions_log
  `);

  // Top search terms that failed
  const topFailed = await query(`
    SELECT message_text, COUNT(*) as cnt
    FROM questions_log WHERE matched_type='none'
    GROUP BY message_text ORDER BY cnt DESC LIMIT 10
  `);

  return {
    users: {
      total: totalUsers.rows[0].count,
      activeToday: activeToday.rows[0].count,
      activeWeek: activeWeek.rows[0].count,
    },
    messages: {
      total: totalMessages.rows[0].count,
      today: messagesToday.rows[0].count,
    },
    searches: {
      total: totalSearches.rows[0].count,
      noMatch: noMatch.rows[0].count,
      successRate: searchSuccess.rows[0],
    },
    postGame: {
      sent: postGameClicks.rows[0].count,
    },
    peakHours: peakHours.rows,
    newUsersDaily: newUsersDaily.rows,
    topButtons: topButtons.rows,
    topFailed: topFailed.rows,
  };
}

module.exports = {
  runCampaignMigrations,
  getCampaign, listCampaigns, createCampaign, updateCampaign,
  insertCampaignLog, markLogSent, markLogFailed,
  markLogRead, markLogClicked,
  getCampaignStats, getPendingLogs, getGlobalStats,
};
