'use strict';
const axios = require('axios');
const config = require('./config');
const { normalizePhone } = require('./utils');
const db = require('./db/postgres');

const BASE_URL = 'https://graph.facebook.com/v23.0';

async function sendPayload(payload) {
  const token = config.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error('Missing WhatsApp credentials');

  const url = `${BASE_URL}/${encodeURIComponent(phoneNumberId)}/messages`;
  const res = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function sendText(to, bodyText) {
  const phone = normalizePhone(to);
  await sendPayload({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { preview_url: false, body: String(bodyText || '') },
  });
  await db.insertLog('outbound', phone, bodyText, 'text', {});
}

async function sendButtons(to, bodyText, buttons) {
  const phone = normalizePhone(to);
  const cleanButtons = (buttons || []).slice(0, 3).map(btn => ({
    type: 'reply',
    reply: {
      id: String(btn.id),
      title: Array.from(String(btn.title)).slice(0, 20).join(''),
    },
  }));

  await sendPayload({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(bodyText || 'בחרו אפשרות:') },
      action: { buttons: cleanButtons },
    },
  });
  await db.insertLog('outbound', phone, bodyText, 'buttons', { buttons: cleanButtons });
}

async function sendList(to, bodyText, buttonText, sectionTitle, rows) {
  const phone = normalizePhone(to);
  const cleanRows = (rows || []).slice(0, 10).map(r => ({
    id: String(r.id),
    title: String(r.title).slice(0, 24),
    description: String(r.description || '').slice(0, 72),
  }));

  await sendPayload({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: String(bodyText || 'בחרו אפשרות:') },
      action: {
        button: String(buttonText || 'בחר'),
        sections: [{ title: String(sectionTitle || 'אפשרויות').slice(0, 24), rows: cleanRows }],
      },
    },
  });
  await db.insertLog('outbound', phone, bodyText, 'list', { buttonText, sectionTitle, rowsCount: cleanRows.length });
}

async function sendImage(to, imageUrl, caption = '') {
  const phone = normalizePhone(to);
  await sendPayload({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'image',
    image: { link: imageUrl, caption: String(caption || '') },
  });
  await db.insertLog('outbound', phone, caption || imageUrl, 'image', { url: imageUrl });
}


async function sendTextAndLog(to, bodyText, meta = {}) {
  await sendText(to, bodyText);
  await db.insertLog('bot', normalizePhone(to), bodyText, 'text', meta);
}

async function sendButtonsAndLog(to, bodyText, buttons, meta = {}) {
  await sendButtons(to, bodyText, buttons);
  await db.insertLog('bot', normalizePhone(to), bodyText, 'buttons', meta);
}

async function sendListAndLog(to, bodyText, buttonText, sectionTitle, rows, meta = {}) {
  await sendList(to, bodyText, buttonText, sectionTitle, rows);
  await db.insertLog('bot', normalizePhone(to), bodyText, 'list', { buttonText, sectionTitle, rowsCount: (rows || []).length, ...meta });
}

module.exports = { sendText, sendButtons, sendList, sendImage, sendTextAndLog, sendButtonsAndLog, sendListAndLog };
