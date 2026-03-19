'use strict';
const { google } = require('googleapis');
const cache = require('../cache');
const config = require('../config');

let _auth = null;

function getAuth() {
  if (_auth) return _auth;
  const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(raw);
  _auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return _auth;
}

async function getSheetValues(sheetName) {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: sheetName,
  });
  return res.data.values || [];
}

function rowsToObjects(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map(h => String(h || ''));
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

// ── VIDEO INDEX ────────────────────────────────────────────────────────────────

async function getVideoIndex() {
  const cached = cache.get('VIDEO_INDEX');
  if (cached) return cached;

  const values = await getSheetValues('Video_Index');
  const rows = rowsToObjects(values).filter(r => r['VD ID']);
  cache.set('VIDEO_INDEX', rows, 21600);
  return rows;
}

// ── KNOWLEDGE ──────────────────────────────────────────────────────────────────

async function getKnowledgeRows() {
  const cached = cache.get('KNOWLEDGE');
  if (cached) return cached;

  const values = await getSheetValues('Knowledge');
  const rows = rowsToObjects(values).filter(r => r['ID']);
  cache.set('KNOWLEDGE', rows, 21600);
  return rows;
}

// ── HOLIDAYS MASTER ────────────────────────────────────────────────────────────

async function getHolidaysMaster() {
  const cached = cache.get('HOLIDAYS');
  if (cached) return cached;

  const values = await getSheetValues('Holidays_Master');
  const rows = rowsToObjects(values);
  cache.set('HOLIDAYS', rows, 3600);
  return rows;
}

// ── TRIVIA ─────────────────────────────────────────────────────────────────────

async function getTriviaRows() {
  const cached = cache.get('TRIVIA');
  if (cached) return cached;

  const values = await getSheetValues('Trivia');
  const rows = rowsToObjects(values);
  cache.set('TRIVIA', rows, 3600);
  return rows;
}

// ── MISSIONS BANK ──────────────────────────────────────────────────────────────

async function getMissionsBank() {
  const cached = cache.get('MISSIONS');
  if (cached) return cached;

  const values = await getSheetValues('Missions_Bank');
  const rows = rowsToObjects(values);
  cache.set('MISSIONS', rows, 3600);
  return rows;
}

// ── COUPONS BANK ──────────────────────────────────────────────────────────────

async function getCouponsBank() {
  // Not cached — needs fresh data for raffle
  const values = await getSheetValues('Coupons_Bank');
  return rowsToObjects(values);
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────

async function getSettings() {
  const cached = cache.get('SETTINGS');
  if (cached) return cached;

  const values = await getSheetValues('Settings');
  const map = {};
  (values || []).forEach(row => {
    if (row[0]) map[String(row[0])] = row[1] !== undefined ? row[1] : '';
  });
  cache.set('SETTINGS', map, 21600);
  return map;
}

async function getSetting(key) {
  const map = await getSettings();
  return String(map[key] || '');
}

// ── AUTO MESSAGES ─────────────────────────────────────────────────────────────

async function getAutoMessages() {
  const values = await getSheetValues('Auto_Messages');
  return rowsToObjects(values);
}

function clearAllCaches() {
  cache.clear();
  console.log('[Sheets] All caches cleared');
}

module.exports = {
  getVideoIndex, getKnowledgeRows, getHolidaysMaster,
  getTriviaRows, getMissionsBank, getCouponsBank,
  getSettings, getSetting, getAutoMessages,
  clearAllCaches,
};
