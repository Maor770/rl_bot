'use strict';
const axios = require('axios');
const config = require('../config');
const { query } = require('../db/postgres');
const {
  createCampaign, updateCampaign, getCampaign,
  insertCampaignLog, markLogSent, markLogFailed,
  getPendingLogs, getCampaignStats
} = require('../db/campaignMigrations');
const { groupContactsByTimezone, filterContactsByCountry, getScheduledUTC } = require('./timezoneMapper');
const { loadFromFile } = require('./contactParser');

const BASE_URL = 'https://graph.facebook.com/v23.0';
const FAILURE_THRESHOLD = 0.05; // 5%

// ── META TEMPLATE API ────────────────────────────────────────────────────────

async function createMetaTemplate(campaign) {
  const token = config.WHATSAPP_ACCESS_TOKEN;

  // Get WABA ID (needed for template creation)
  const wabaRes = await axios.get(
    `${BASE_URL}/${config.WHATSAPP_PHONE_NUMBER_ID}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const wabaId = wabaRes.data?.data?.[0]?.id || wabaRes.data?.id;
  if (!wabaId) throw new Error('Could not get WABA ID');

  const components = [];

  // Header (image)
  if (campaign.image_url) {
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [campaign.image_url] }
    });
  }

  // Body
  components.push({
    type: 'BODY',
    text: campaign.body_text || '',
  });

  // Buttons
  const buttons = (campaign.buttons || []).slice(0, 3);
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map(btn => {
        if (btn.type === 'url') {
          return { type: 'URL', text: btn.label, url: btn.value };
        }
        if (btn.type === 'call') {
          return { type: 'PHONE_NUMBER', text: btn.label, phone_number: btn.value };
        }
        // quick_reply
        return { type: 'QUICK_REPLY', text: btn.label };
      })
    });
  }

  const payload = {
    name: campaign.template_name,
    language: 'he',
    category: campaign.message_type === 'marketing' ? 'MARKETING' : 'UTILITY',
    components,
  };

  const res = await axios.post(
    `${BASE_URL}/${wabaId}/message_templates`,
    payload,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  return res.data;
}

async function checkTemplateStatus(templateName) {
  const token = config.WHATSAPP_ACCESS_TOKEN;
  const wabaRes = await axios.get(
    `${BASE_URL}/${config.WHATSAPP_PHONE_NUMBER_ID}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const wabaId = wabaRes.data?.id;
  if (!wabaId) return null;

  const res = await axios.get(
    `${BASE_URL}/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const templates = res.data?.data || [];
  const t = templates.find(t => t.name === templateName);
  return t ? t.status : null; // APPROVED | PENDING | REJECTED
}

// ── SEND SINGLE TEMPLATE MESSAGE ─────────────────────────────────────────────

async function sendTemplateMessage(to, campaign) {
  const token = config.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID;

  const components = [];

  // Header image component
  if (campaign.image_url) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: campaign.image_url } }]
    });
  }

  // Button parameters (for quick_reply buttons)
  const buttons = (campaign.buttons || []).filter(b => b.type === 'quick_reply');
  buttons.forEach((btn, i) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: i,
      parameters: [{ type: 'payload', payload: btn.value || btn.label }]
    });
  });

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'template',
    template: {
      name: campaign.template_name,
      language: { code: 'he' },
      components: components.length ? components : undefined,
    },
  };

  const res = await axios.post(
    `${BASE_URL}/${encodeURIComponent(phoneNumberId)}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  // Return Meta message ID
  return res.data?.messages?.[0]?.id || '';
}

// ── PREPARE CAMPAIGN (load contacts, write pending logs) ──────────────────────

async function prepareCampaign(campaignId, contacts) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const filtered = filterContactsByCountry(contacts, campaign.country_filter);
  const grouped  = groupContactsByTimezone(filtered);

  let total = 0;
  for (const [group, members] of Object.entries(grouped)) {
    for (const contact of members) {
      await insertCampaignLog(campaignId, contact.phone, contact.display_name, group);
      total++;
    }
  }

  await updateCampaign(campaignId, { total_recipients: total, status: 'approved' });
  console.log(`[Broadcast] Campaign ${campaignId} prepared — ${total} recipients`);
  return { total, grouped };
}

// ── EXECUTE SEND (called by scheduler) ───────────────────────────────────────

async function executeCampaignGroup(campaignId, timezoneGroup) {
  const campaign = await getCampaign(campaignId);
  if (!campaign || campaign.status === 'paused' || campaign.status === 'done') return;

  const pending = (await getPendingLogs(campaignId))
    .filter(r => r.timezone_group === timezoneGroup);

  if (!pending.length) {
    console.log(`[Broadcast] No pending for campaign ${campaignId} group ${timezoneGroup}`);
    return;
  }

  console.log(`[Broadcast] Sending ${pending.length} messages for campaign ${campaignId} (${timezoneGroup})`);

  await updateCampaign(campaignId, { status: 'sending' });

  const delayMs = Math.max(1000, Math.round(60000 / (campaign.rate_per_minute || 20)));

  let sentCount = 0;
  let failCount = 0;

  for (const log of pending) {
    // Re-check campaign hasn't been paused
    const fresh = await getCampaign(campaignId);
    if (fresh?.status === 'paused') {
      console.log(`[Broadcast] Campaign ${campaignId} paused — stopping`);
      break;
    }

    // Failure rate check
    const total = sentCount + failCount;
    if (total >= 20 && failCount / total > FAILURE_THRESHOLD) {
      console.error(`[Broadcast] Failure rate too high (${failCount}/${total}) — pausing campaign ${campaignId}`);
      await updateCampaign(campaignId, { status: 'paused' });
      break;
    }

    try {
      const messageId = await sendTemplateMessage(log.phone, campaign);
      await markLogSent(log.id, messageId);
      sentCount++;
    } catch (err) {
      const errText = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      await markLogFailed(log.id, errText);
      failCount++;
      console.error(`[Broadcast] Failed ${log.phone}:`, errText);
    }

    // Rate limiting
    await sleep(delayMs);
  }

  // Update sent_count
  await updateCampaign(campaignId, { sent_count: campaign.sent_count + sentCount });

  // Check if all done
  const remaining = await getPendingLogs(campaignId);
  const stillPending = remaining.filter(r => r.status === 'pending');
  if (!stillPending.length) {
    await updateCampaign(campaignId, { status: 'done' });
    console.log(`[Broadcast] Campaign ${campaignId} completed`);
  }

  console.log(`[Broadcast] Group ${timezoneGroup}: sent=${sentCount} failed=${failCount}`);
}

// ── SCHEDULER TICK (called every minute from scheduler) ──────────────────────

async function broadcastSchedulerTick() {
  const now = new Date();

  // Find campaigns that are approved and due to send
  const res = await query(`
    SELECT c.*
    FROM campaigns c
    WHERE c.status = 'approved'
    AND c.scheduled_date IS NOT NULL
  `);

  for (const campaign of res.rows) {
    const { groupContactsByTimezone, GROUP_TO_TIMEZONE, getScheduledUTC } = require('./timezoneMapper');

    // Check each timezone group
    const groups = ['israel', 'europe', 'east', 'central', 'mountain', 'pacific', 'canada_east', 'canada_west', 'other'];
    for (const group of groups) {
      const sendTime = getScheduledUTC(
        campaign.scheduled_date.toISOString().split('T')[0],
        campaign.send_hour_local,
        group
      );

      const diff = now - sendTime;
      // Within 3-minute window of scheduled time
      if (diff >= 0 && diff < 3 * 60 * 1000) {
        console.log(`[Broadcast] Triggering campaign ${campaign.id} for group ${group}`);
        executeCampaignGroup(campaign.id, group).catch(e =>
          console.error(`[Broadcast] Error for campaign ${campaign.id} group ${group}:`, e.message)
        );
      }
    }
  }
}

// ── PREVIEW (send to ADMIN_PHONE) ─────────────────────────────────────────────

async function sendPreviewToAdmin(campaign) {
  const adminPhone = String(config.ADMIN_PHONE || '').replace(/\D/g, '');
  if (!adminPhone) throw new Error('ADMIN_PHONE not configured');

  const messageId = await sendTemplateMessage(adminPhone, campaign);
  return { success: true, messageId, phone: adminPhone };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  createMetaTemplate,
  checkTemplateStatus,
  sendTemplateMessage,
  prepareCampaign,
  executeCampaignGroup,
  broadcastSchedulerTick,
  sendPreviewToAdmin,
};
