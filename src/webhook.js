'use strict';
const db = require('./db/postgres');
const wa = require('./whatsapp');
const { normalizePhone, extractContactName, isGreetingText, isMenuRequestText, normalizeHebrewSearch } = require('./utils');
const { routeSelection, sendWelcomeAndMainMenu, sendMainMenuButtonsOnly, handleFreeText } = require('./router');
const { sendVideoByNumber } = require('./modules/videos');
const { detectNoise } = require('./modules/search');
const { processReferral, handleOnboardingFlow } = require('./modules/game');
const { insertLog } = require('./db/postgres');
const { markLogRead, markLogClicked } = require('./db/campaignMigrations');
const config = require('./config');

const SESSION_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

function getMessageText(message) {
  if (!message) return '';
  switch (String(message.type || '')) {
    case 'text':        return (message.text && message.text.body) || '';
    case 'button':      return (message.button && message.button.text) || '';
    case 'interactive':
      if (message.interactive?.button_reply) return message.interactive.button_reply.title || '';
      if (message.interactive?.list_reply)   return message.interactive.list_reply.title || '';
      return '';
    default: return '';
  }
}

function getButtonId(message) {
  const interactive = message?.interactive || {};
  if (interactive.button_reply) return interactive.button_reply.id || '';
  if (interactive.list_reply)   return interactive.list_reply.id || '';
  return '';
}

// ── CAMPAIGN STATUS UPDATE (read receipts) ────────────────────────────────────
async function handleStatusUpdate(status) {
  if (!status || !status.id) return;
  try {
    if (status.status === 'read') {
      await markLogRead(status.id);
    }
  } catch (e) {
    // Silent — don't break main webhook flow
  }
}

async function handleIncomingMessage(message, contact) {
  const from = normalizePhone(message.from || '');
  if (!from) return;

  await insertLog('inbound', from, getMessageText(message), message.type || 'unknown', {});

  const profileName = extractContactName(contact);
  const btnId    = getButtonId(message);
  const btnTitle = message?.interactive?.button_reply?.title || message?.interactive?.list_reply?.title || '';
  const textBody = getMessageText(message);

  // ── BUTTON / LIST REPLY ───────────────────────────────────────────────────
  if (btnId) {
    await db.upsertUser(from, profileName);
    await db.setUserState(from, { lastInteractionMs: Date.now() });

    // Track campaign button click (context.id = message_id of the template we sent)
    try {
      const contextMsgId = message.context?.id || '';
      if (contextMsgId) await markLogClicked(contextMsgId, btnTitle);
    } catch (e) {}

    return routeSelection(from, btnId, btnTitle);
  }

  const normalized = String(textBody || '').trim();
  if (!normalized) return;

  // ── VERSION COMMAND ───────────────────────────────────────────────────────
  if (normalizeHebrewSearch(normalized) === 'version') {
    let deployedAt = 'לא ידוע';
    try {
      deployedAt = require('./version.js');
      const d = new Date(deployedAt);
      deployedAt = d.toLocaleString('he-IL', { timeZone: config.TZ });
    } catch (e) {}
    return wa.sendText(from,
      `⚙️ *רבי לילדים Bot*\n📦 גרסה: 13.2.0\n📅 עודכן: ${deployedAt}\n✅ סטטוס: פעיל`
    );
  }

  // Load state
  const state = await db.getUserState(from);
  const hasSeenWelcome    = !!state.hasSeenWelcome;
  const lastInteractionMs = Number(state.lastInteractionMs || 0);
  const now               = Date.now();
  const isReturningAfterBreak = hasSeenWelcome && lastInteractionMs > 0 && (now - lastInteractionMs) >= SESSION_TIMEOUT_MS;

  // Update user
  await db.setUserState(from, { lastInteractionMs: now });
  await db.upsertUser(from, profileName);

  // ── REFERRAL ──────────────────────────────────────────────────────────────
  if (normalized.startsWith('שלום הגעתי דרך')) {
    const rawReferrer = normalized.replace('שלום הגעתי דרך', '').trim();
    const referrerPhone = normalizePhone(rawReferrer.replace(/[^\d]/g, ''));
    if (referrerPhone && referrerPhone !== from) {
      await processReferral(from, referrerPhone);
    }
    return sendWelcomeAndMainMenu(from);
  }

  // ── OPT OUT ───────────────────────────────────────────────────────────────
  const optOutWords = ['הסר', 'עצור', 'די', 'stop'];
  if (optOutWords.includes(normalizeHebrewSearch(normalized))) {
    await db.deactivateReminders(from);
    return wa.sendTextAndLog(from, 'הבנתי! עצרתי את התזכורות היומיות. תוכלו להפעיל אותן מחדש דרך הגדרות המשחק 🤫', { action: 'opt_out_reminders' });
  }

  // ── GREETING / MENU ───────────────────────────────────────────────────────
  if (isGreetingText(normalized) || isMenuRequestText(normalized)) {
    return sendWelcomeAndMainMenu(from);
  }

  // ── ONBOARDING STATE MACHINE ──────────────────────────────────────────────
  const freshState = await db.getUserState(from);

  // פידבק — קבלת טקסט חופשי
  if (freshState.expectedInput === 'AWAITING_FEEDBACK') {
    await db.setUserState(from, { expectedInput: '' });
    const feedbackText = normalized;
    const sheets = require('./db/sheets');
    const { nowString } = require('./utils');
    try {
      await sheets.appendRow('Feedback', [nowString(), from, profileName, feedbackText]);
    } catch (e) {
      console.error('[Feedback] Sheets error:', e.message);
    }
    try {
      const adminPhone = normalizePhone(config.ADMIN_PHONE);
      if (adminPhone) {
        await wa.sendText(adminPhone,
          `💬 *פידבק חדש מהבוט*\n👤 ${profileName || from}\n📱 ${from}\n\n${feedbackText}`
        );
      }
    } catch (e) {
      console.error('[Feedback] Admin notify error:', e.message);
    }
    await wa.sendTextAndLog(from,
      '🙏 תודה רבה על הפידבק!\nזה עוזר לנו לשפר ולהמשיך לגדול 😊',
      { action: 'feedback_received' }
    );
    return;
  }

  // חיפוש חופשי — קבלת שאילתא
  if (freshState.expectedInput === 'FREE_SEARCH_PROMPT') {
    await db.setUserState(from, { expectedInput: '' });
    return handleFreeText(from, profileName, normalized);
  }

  if (freshState.expectedInput) {
    return handleOnboardingFlow(from, normalized, freshState);
  }

  // ── NEW USER ──────────────────────────────────────────────────────────────
  if (!hasSeenWelcome) {
    await sendWelcomeAndMainMenu(from);
    await wa.sendTextAndLog(from,
      '💬 קיבלתי את ההודעה שלך!\nכדי שאוכל לחפש בצורה הטובה ביותר, כתבו שוב את מה שאתם מחפשים. 🔍',
      { action: 'first_message_not_greeting', query: normalized }
    );
    return;
  }

  // ── RETURNING AFTER BREAK ─────────────────────────────────────────────────
  if (isReturningAfterBreak) {
    await db.setUserState(from, { pendingQuery: normalized });
    return wa.sendButtonsAndLog(from,
      '👋 ברוכים השבים!\nמה תרצו לעשות?',
      [
        { id: 'wb_last_menu', title: 'תפריט אחרון 📋' },
        { id: 'wb_search',    title: 'חיפוש חופשי 🔍' },
        { id: 'nav_home',     title: 'תפריט ראשי 🏠' },
      ],
      { action: 'welcome_back', query: normalized }
    );
  }

  // ── VIDEO BY NUMBER ───────────────────────────────────────────────────────
  const numMatch = normalized.match(/(?:וידאו|סרטון|תכנית|פרק|מספר)\s*(?:מספר\s*)?(\d+)/);
  if (numMatch) return sendVideoByNumber(from, numMatch[1]);

  // ── NOISE DETECTION ───────────────────────────────────────────────────────
  const noiseResponse = detectNoise(normalizeHebrewSearch(normalized));
  if (noiseResponse) {
    await wa.sendTextAndLog(from, noiseResponse, { action: 'noise_response', query: normalized });
    return sendMainMenuButtonsOnly(from);
  }

  // ── FREE TEXT SEARCH ──────────────────────────────────────────────────────
  return handleFreeText(from, profileName, normalized);
}

async function handleWebhookPayload(payload, phoneNumberId) {
  const entries = payload.entry || [];
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      const value = change.value || {};

      const incomingId = value.metadata?.phone_number_id;
      if (phoneNumberId && incomingId && incomingId !== phoneNumberId) {
        console.log(`[Webhook] Skipping — phone_id ${incomingId} != ours ${phoneNumberId}`);
        continue;
      }

      // ── STATUS UPDATES (read receipts) ────────────────────────────────────
      const statuses = value.statuses || [];
      for (const s of statuses) {
        try { await handleStatusUpdate(s); } catch (e) {}
      }

      const messages = value.messages || [];
      const contacts = value.contacts || [];
      console.log(`[Webhook] Processing ${messages.length} message(s)`);

      for (const message of messages) {
        console.log(`[Webhook] From: ${message.from}, type: ${message.type}`);
        try {
          await handleIncomingMessage(message, contacts[0] || {});
        } catch (err) {
          console.error('[Webhook] Error:', err.message, err.stack);
          const { notifyAdmin } = require('./modules/admin');
          await notifyAdmin(`Error for ${message.from}: ${err.message}`).catch(() => {});
        }
      }
    }
  }
}

module.exports = { handleWebhookPayload };
