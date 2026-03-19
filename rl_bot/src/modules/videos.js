'use strict';
const sheets = require('../db/sheets');
const db = require('../db/postgres');
const wa = require('../whatsapp');
const { normalizeHebrewSearch, tokenizeHebrew, splitHolidayMulti, normalizeHolidayName, buildDisplayVideoLink } = require('../utils');
const config = require('../config');

// ── LIST KEY MATCHING ─────────────────────────────────────────────────────────

function videoMatchesListKey(video, listKey) {
  const v = video || {};
  const g = normalizeHebrewSearch(v['VD Categories'] || '');
  const c = normalizeHebrewSearch(v['Bot Main Category'] || '');
  const s = normalizeHebrewSearch(v['Bot Sub Category'] || '');

  const eq = (a, b) => normalizeHebrewSearch(a) === normalizeHebrewSearch(b);

  switch (String(listKey || '')) {
    case 'story_kedumim':     return eq(g, 'סיפורים') && eq(c, 'מקורות קדומים');
    case 'story_chassidim':   return eq(g, 'סיפורים') && eq(c, 'סיפורי חסידים');
    case 'moshiach_bring':    return eq(g, 'לחיות משיח') && eq(c, 'מביאים את משיח');
    case 'moshiach_temple':   return eq(g, 'לחיות משיח') && eq(c, 'בית המקדש והגאולה');
    case 'moshiach_rebbe':    return eq(g, 'לחיות משיח') && eq(c, 'הרבי כמלך המשיח');
    case 'moshiach_geulah_life': return eq(g, 'לחיות משיח') && eq(c, 'חיים של גאולה');
    case 'niggun_holidays':   return eq(g, 'זמן ניגונים') && eq(c, 'ניגוני חגים');
    case 'niggun_moshiach':   return eq(g, 'זמן ניגונים') && eq(c, 'ניגוני משיח');
    case 'niggun_simcha':     return eq(g, 'זמן ניגונים') && eq(c, 'ניגוני שמחה');
    case 'niggun_dveikus':    return eq(g, 'זמן ניגונים') && eq(c, 'ניגוני דבקות');
    case 'niggun_chabad':     return eq(g, 'זמן ניגונים') && eq(c, 'ניגוני חב״ד');
    case 'topic_tzivos':      return eq(g, 'נושאים') && eq(c, 'צבאות השם');
    case 'topic_hiskashrus':  return eq(g, 'נושאים') && eq(c, 'התקשרות לרבי');
    case 'topic_middos':      return eq(g, 'נושאים') && eq(c, 'מידות טובות');
    case 'topic_pride':       return eq(g, 'נושאים') && eq(c, 'גאווה יהודית');
    case 'topic_torah':       return eq(g, 'נושאים') && eq(c, 'תורה ומצוות');
    case 'topic_girls':       return eq(g, 'נושאים') && eq(c, 'בנות ישראל');
    case 'topic_12psukim':    return eq(g, 'נושאים') && eq(c, 'י״ב הפסוקים');
    case 'topic_weekly':      return eq(g, 'נושאים') && eq(c, 'התוכנית השבועית');
    case 'topic_kids_action': return eq(g, 'נושאים') && eq(c, 'ילדים בפעולה');
    default: return false;
  }
}

// ── ITEM FILTERING ────────────────────────────────────────────────────────────

async function getItemsForListKey(listKey, state) {
  const index = await sheets.getVideoIndex();

  if (listKey.startsWith('holiday:')) {
    const holidayName = normalizeHolidayName(listKey.substring('holiday:'.length));
    return index.filter(v => splitHolidayMulti(v['VD Holidays']).includes(holidayName));
  }

  if (listKey.startsWith('rebbe:')) {
    const rebbeName = listKey.substring('rebbe:'.length);
    return index.filter(v =>
      normalizeHebrewSearch(v['VD Categories']) === normalizeHebrewSearch('סיפורים') &&
      normalizeHebrewSearch(v['Bot Main Category']) === normalizeHebrewSearch('רבותינו נשיאינו') &&
      normalizeHebrewSearch(v['Bot Sub Category']) === normalizeHebrewSearch(rebbeName)
    );
  }

  return index.filter(v => videoMatchesListKey(v, listKey));
}

// ── VIDEO LINK ────────────────────────────────────────────────────────────────

function getVideoLink(item) {
  return buildDisplayVideoLink(item['Video Number'], item['Display Link'] || item['Video Link']);
}

// ── PAGING ────────────────────────────────────────────────────────────────────

async function sendCurrentVideoPage(userId, offset, state, prefetchedItems = null) {
  const listTitle = state.currentListTitle || 'וידאוים';
  const safeOffset = Math.max(0, Number(offset || 0));

  const items = prefetchedItems || await getItemsForListKey(state.currentListKey, state);
  const pageSize = items.length <= 12 ? 12 : 10;
  const page = items.slice(safeOffset, safeOffset + pageSize);

  if (!items.length) {
    await wa.sendTextAndLog(userId, `לא נמצאו כרגע וידאוים עבור ${listTitle}.`, { action: 'no_video_results', list_key: state.currentListKey });
    await sendNavigationButtons(userId, false);
    return;
  }

  if (!page.length) {
    await wa.sendTextAndLog(userId, 'אין עוד וידאוים ברשימה זו.', { action: 'empty_video_page' });
    await sendNavigationButtons(userId, false);
    return;
  }

  const lines = [`*${listTitle}*`, `סה״כ ${items.length} וידאוים`, ''];
  for (const item of page) {
    const icon = String(item['Bot Icon'] || '🎬');
    lines.push(`${icon} *${item['Video Name']}*`);
    lines.push(getVideoLink(item));
    lines.push('');
  }

  lines.push(`מציג ${safeOffset + 1}-${safeOffset + page.length} מתוך ${items.length}`);
  lines.push('');

  const key = String(state.currentListKey || '');
  if (key.startsWith('story_') || key.startsWith('rebbe:')) {
    lines.push('🎨 הידעת? כמעט לכל תוכניות הסיפורים שלנו יש גם דפי צביעה להורדה!');
    lines.push('🖍️ אפשר לחפש באתר במדור "דפי צביעה".');
    lines.push('');
  }

  lines.push('✨ רשימה זו נוצרה באמצעות הבוט החדש של "רבי לילדים"');
  lines.push(`📲 לחיפוש מהיר ונוח בוואטסאפ:\nhttps://wa.me/${config.BOT_PUBLIC_WHATSAPP_NUMBER}?text=שלום`);

  await wa.sendTextAndLog(userId, lines.join('\n'), { action: 'video_results', list_key: key, offset: safeOffset, total: items.length });

  await db.setUserState(userId, { currentOffset: safeOffset });
  await sendNavigationButtons(userId, safeOffset + pageSize < items.length);
}

async function sendNavigationButtons(userId, hasMore) {
  const buttons = [];
  if (hasMore) buttons.push({ id: 'nav_more', title: '➕ עוד' });
  buttons.push({ id: 'nav_back', title: '↩️ חזרה' });
  buttons.push({ id: 'nav_home', title: '🏠 תפריט ראשי' });
  await wa.sendButtonsAndLog(userId, '‏', buttons.slice(0, 3), { action: 'navigation_buttons', has_more: hasMore });
}

// ── BY NUMBER ─────────────────────────────────────────────────────────────────

async function sendVideoByNumber(userId, videoNumber) {
  const num = String(videoNumber || '').trim();
  const index = await sheets.getVideoIndex();
  const found = index.find(v => String(v['Video Number'] || '').trim() === num);

  if (found) {
    const text = formatSingleVideoAnswer(found, `🎬 מצאתי את תוכנית מספר ${num}:`);
    await wa.sendTextAndLog(userId, text, { action: 'video_by_number', video_number: num });
    await db.insertQuestion({ phone: userId, name: '', message: 'תוכנית מספר ' + num, questionType: 'free_text', botReply: text, matchedType: 'video', matchedIds: found['VD ID'] || '' });
  } else {
    const notFoundText = `😔 לא מצאתי תוכנית עם מספר ${num}.\n\n💡 ייתכן שהמספר שגוי, או שהתוכנית עדיין לא נוספה לבוט.\nאפשר לנסות לחפש לפי שם או נושא 🙂`;
    await wa.sendTextAndLog(userId, notFoundText, { action: 'video_by_number_not_found', video_number: num });
    await sendNavigationButtons(userId, false);
  }
}

// ── FORMAT ────────────────────────────────────────────────────────────────────

function formatSingleVideoAnswer(video, introText = '') {
  const lines = [];
  if (introText) { lines.push(introText); lines.push(''); }
  lines.push(`🎬 *${String(video['Video Name'] || 'וידאו מומלץ')}*`);
  if (String(video['Video Description'] || '').trim()) {
    lines.push(String(video['Video Description']).trim());
  }
  const link = getVideoLink(video);
  if (link) { lines.push(''); lines.push(link); }
  return lines.join('\n');
}

module.exports = { videoMatchesListKey, getItemsForListKey, sendCurrentVideoPage, sendNavigationButtons, sendVideoByNumber, formatSingleVideoAnswer };
