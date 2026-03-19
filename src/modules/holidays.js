'use strict';
const sheets = require('../db/sheets');
const wa = require('../whatsapp');
const db = require('../db/postgres');
const { normalizeHolidayName, splitHolidayMulti, boolFromCell } = require('../utils');
const { sendCurrentVideoPage, sendNavigationButtons } = require('./videos');
const dayjs = require('dayjs');

const SPECIAL_LIST_KEYS = { ALL_HOLIDAYS: '__all_holidays__' };

async function holidayHasVideos(name) {
  const normalized = normalizeHolidayName(name);
  const index = await sheets.getVideoIndex();
  return index.some(v => splitHolidayMulti(v['VD Holidays']).includes(normalized));
}

async function getUpcomingHolidayEntries(limit = 3) {
  const rows = await sheets.getHolidaysMaster();
  const today = dayjs().startOf('day');
  const results = [];

  for (const row of rows) {
    const name = normalizeHolidayName(row['Holiday Name'] || '');
    if (!name) continue;
    if (!boolFromCell(row['Active'])) continue;

    const startRaw = row['Start Date'];
    const endRaw = row['End Date'];
    if (!startRaw || !endRaw) continue;

    const startDate = dayjs(startRaw);
    const endDate = dayjs(endRaw);
    if (!startDate.isValid() || !endDate.isValid()) continue;
    if (endDate.isBefore(today)) continue;
    if (name.startsWith('חודש ')) continue;
    if (name === 'ספירת העומר' || name === 'ימי בין המצרים') continue;
    if (!(await holidayHasVideos(name))) continue;

    const icon = String(row['Display Emoji'] || row['Bot Icon'] || row['Icon'] || '📅');
    results.push({ name, startDate, icon });
  }

  results.sort((a, b) => a.startDate.valueOf() - b.startDate.valueOf());
  return results.slice(0, limit);
}

async function getAllHolidayEntries() {
  const rows = await sheets.getHolidaysMaster();
  const today = dayjs().startOf('day');
  const results = [];

  for (const row of rows) {
    const name = normalizeHolidayName(row['Holiday Name'] || '');
    if (!name) continue;
    if (!boolFromCell(row['Active'])) continue;
    if (!(await holidayHasVideos(name))) continue;
    if (name.startsWith('חודש ')) continue;

    const startRaw = row['Start Date'];
    const icon = String(row['Display Emoji'] || row['Bot Icon'] || row['Icon'] || '📅');
    const baseDate = startRaw ? dayjs(startRaw) : dayjs('2099-01-01');

    let sortDate = dayjs().year(today.year()).month(baseDate.month()).date(baseDate.date());
    if (sortDate.isBefore(today)) sortDate = sortDate.add(1, 'year');

    results.push({ name, icon, sortDate });
  }

  results.sort((a, b) => a.sortDate.valueOf() - b.sortDate.valueOf());
  return results;
}

async function sendUpcomingHolidaysMenu(userId) {
  const upcoming = await getUpcomingHolidayEntries(3);
  if (!upcoming.length) {
    return wa.sendTextAndLog(userId, 'לא נמצאו כרגע חגים או ימי דפגרא קרובים עם וידאוים.', { action: 'no_upcoming_holidays' });
  }

  await db.setUserState(userId, { lastMenu: 'holidays_root' });
  await wa.sendButtonsAndLog(userId, 'אלה 3 החגים וימי דפגרא הקרובים:', upcoming.map(e => ({
    id: `holiday:${e.name}`,
    title: `${e.name} ${e.icon}`,
  })), { action: 'upcoming_holidays_buttons' });
}

async function sendAllHolidaysMenu(userId) {
  await db.setUserState(userId, {
    lastMenu: 'holidays_root',
    currentListKey: SPECIAL_LIST_KEYS.ALL_HOLIDAYS,
    currentListTitle: 'כל החגים וימי דפגרא',
    currentOffset: 0,
  });
  await sendHolidayListPage(userId, 0);
}

async function sendHolidayListPage(userId, offset) {
  const entries = await getAllHolidayEntries();
  const safeOffset = Math.max(0, Number(offset || 0));
  const page = entries.slice(safeOffset, safeOffset + 10);

  if (!entries.length) {
    await wa.sendTextAndLog(userId, 'לא נמצאו כרגע חגים עם וידאוים.', { action: 'no_holiday_results' });
    await sendNavigationButtons(userId, false);
    return;
  }

  const rows = page.map(e => ({ id: `holiday:${e.name}`, title: `${e.name} ${e.icon}`, description: '' }));
  await wa.sendListAndLog(
    userId,
    `כל החגים וימי דפגרא\nמציג ${safeOffset + 1}-${safeOffset + page.length} מתוך ${entries.length}`,
    'בחר', 'חגים וימי דפגרא', rows,
    { action: 'all_holidays', offset: safeOffset, total: entries.length }
  );

  await db.setUserState(userId, { currentOffset: safeOffset });
  await sendNavigationButtons(userId, safeOffset + 10 < entries.length);
}

async function sendHolidayVideos(userId, holidayName) {
  const normalized = normalizeHolidayName(holidayName);
  const index = await sheets.getVideoIndex();
  const items = index.filter(v => splitHolidayMulti(v['VD Holidays']).includes(normalized));

  await db.setUserState(userId, {
    lastMenu: 'holidays_root',
    currentListKey: `holiday:${normalized}`,
    currentListTitle: `📅 ${normalized}`,
    currentOffset: 0,
  });

  const state = await db.getUserState(userId);
  await sendCurrentVideoPage(userId, 0, state, items);
}

async function getNextRaffleDateText() {
  const rows = await sheets.getHolidaysMaster(); // Raffles are in postgres
  return ''; // Handled in game.js
}

module.exports = {
  getUpcomingHolidayEntries, getAllHolidayEntries,
  sendUpcomingHolidaysMenu, sendAllHolidaysMenu,
  sendHolidayListPage, sendHolidayVideos,
};
