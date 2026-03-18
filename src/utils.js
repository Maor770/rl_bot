'use strict';
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const config = require('./config');

const HOLIDAY_ALIASES = {
  'לג בעומר': 'ל"ג בעומר',
  'ל״ג בעומר': 'ל"ג בעומר',
  'ל"ג בעומר': 'ל"ג בעומר',
  'יט כסלו': 'י"ט כסלו',
  'י״ט כסלו': 'י"ט כסלו',
  'י"ט כסלו': 'י"ט כסלו',
  'יא ניסן': 'י"א ניסן',
  "יא' ניסן": 'י"א ניסן',
  'י״א ניסן': 'י"א ניסן',
  'י"א ניסן': 'י"א ניסן',
  'יב - יג תמוז': 'י"ב-י"ג תמוז',
  'יב-יג תמוז': 'י"ב-י"ג תמוז',
  'י״ב - י״ג תמוז': 'י"ב-י"ג תמוז',
  'י"ב - י"ג תמוז': 'י"ב-י"ג תמוז',
  'י"ב-י"ג תמוז': 'י"ב-י"ג תמוז',
  "יב' - יג' תמוז": 'י"ב-י"ג תמוז',
  "Sefiras Ha'Omer": 'ספירת העומר',
  'Sefiras HaOmer': 'ספירת העומר',
  'Sefirat HaOmer': 'ספירת העומר',
  "Sefirat Ha'Omer": 'ספירת העומר',
  "sefiras ha'omer": 'ספירת העומר',
  'sefiras haomer': 'ספירת העומר',
  'zayin cheshvan': "ז' חשוון",
  'Zayin Cheshvan': "ז' חשוון",
  '7 Cheshvan': "ז' חשוון",
};

function normalizePhone(value) {
  const s = String(value || '').replace(/[^\d]/g, '');
  if (!s) return '';
  if (s.startsWith('972')) return s;
  if (s.startsWith('0')) return '972' + s.substring(1);
  return s;
}

function nowString() {
  return dayjs().tz(config.TZ).format('YYYY-MM-DD HH:mm:ss');
}

function normalizeHebrewSearch(text) {
  return String(text || '')
    .replace(/["״׳']/g, '')
    .replace(/[(){}\[\]]/g, ' ')
    .replace(/[\/\\|,+_*~`]+/g, ' ')
    .replace(/[!?.:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenizeHebrew(text) {
  return normalizeHebrewSearch(text)
    .split(' ')
    .map(x => String(x || '').trim())
    .filter(x => x.length >= 2);
}

function normalizeHolidayName(name) {
  const clean = String(name || '').trim();
  return HOLIDAY_ALIASES[clean] || clean;
}

function splitHolidayMulti(raw) {
  return String(raw || '').trim()
    .split(',')
    .map(x => normalizeHolidayName(String(x || '').trim()))
    .filter(x => !!x);
}

function boolFromCell(value) {
  if (typeof value === 'boolean') return value;
  const t = String(value || '').trim().toLowerCase();
  return t === 'true' || t === 'yes' || t === '1' || t === 'כן';
}

function safeJsonStringify(obj) {
  try { return JSON.stringify(obj || {}); } catch (e) { return '{}'; }
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.substring(start, end + 1)); } catch (e) { return null; }
}

function buildDisplayVideoLink(videoNumber, directLink, websiteBaseUrl) {
  if (String(directLink || '').trim()) return String(directLink).trim();
  const base = (websiteBaseUrl || config.WEBSITE_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/watch?v=${encodeURIComponent(String(videoNumber || '').trim())}`;
}

function isGreetingText(text) {
  const t = normalizeHebrewSearch(text);
  return ['שלום', 'היי', 'הי', 'hello', 'hi', 'shalom', 'start', 'התחל', 'תפריט'].includes(t);
}

function isMenuRequestText(text) {
  const t = normalizeHebrewSearch(text);
  return t === 'menu' || t === 'main menu' || t === 'תפריט ראשי';
}

function isMeaningfulHebrewQuery(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const normalized = normalizeHebrewSearch(t);
  if (!normalized || normalized.length <= 1) return false;
  if (/^[0-9\s.,\-_!?]+$/.test(normalized)) return false;
  const letters = normalized.replace(/[^a-zA-Zא-ת]/g, '');
  return letters.length >= 2;
}

function parseHebrewBirthday(text) {
  const input = normalizeHebrewSearch(text).replace(/^[בלה]\s*/, '');
  const hebrewDays = ['א','ב','ג','ד','ה','ו','ז','ח','ט','י','יא','יב','יג','יד','טו','טז','יז','יח','יט','כ','כא','כב','כג','כד','כה','כו','כז','כח','כט','ל'];
  const hebrewMonths = ['תשרי','חשון','חשוון','כסלו','טבת','שבט','אדר','אדר א','אדר ב','ניסן','אייר','סיון','סיוון','תמוז','אב','מנחם אב','אלול'];
  let foundDay = '', foundMonth = '';
  for (let d = hebrewDays.length - 1; d >= 0; d--) {
    if (input.startsWith(hebrewDays[d]) || input.includes(' ' + hebrewDays[d] + ' ')) {
      foundDay = hebrewDays[d]; break;
    }
  }
  for (const m of hebrewMonths) {
    if (input.includes(m)) { foundMonth = m; break; }
  }
  return (foundDay && foundMonth) ? `${foundDay} ${foundMonth}` : null;
}

function extractContactName(contact) {
  try { return String(((contact || {}).profile || {}).name || '').trim(); } catch (e) { return ''; }
}

function toMilliseconds(amount, unit) {
  const n = Number(amount || 0);
  switch (String(unit || '').toLowerCase()) {
    case 'minutes': return n * 60 * 1000;
    case 'hours':   return n * 60 * 60 * 1000;
    case 'days':    return n * 24 * 60 * 60 * 1000;
    default:        return n * 60 * 1000;
  }
}

module.exports = {
  normalizePhone, nowString, normalizeHebrewSearch, tokenizeHebrew,
  normalizeHolidayName, splitHolidayMulti, boolFromCell, safeJsonStringify,
  extractJsonObject, buildDisplayVideoLink, isGreetingText, isMenuRequestText,
  isMeaningfulHebrewQuery, parseHebrewBirthday, extractContactName, toMilliseconds,
  HOLIDAY_ALIASES,
};
