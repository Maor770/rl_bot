// src/modules/contactParser.js
const fs   = require('fs');
const path = require('path');
const sheets = require('../db/sheets');

/**
 * Normalize a raw phone string to digits-only with country code.
 * Returns null if unparseable.
 */
function normalizePhone(raw) {
  if (!raw || !String(raw).trim()) return null;

  let phone = String(raw).trim();

  // Multiple numbers in one field — take first Israeli, else first
  if (phone.includes(':::')) {
    const parts = phone.split(':::').map(p => p.trim());
    const israeli = parts.map(normalizePhone).find(p => p && p.startsWith('972'));
    return israeli || normalizePhone(parts[0]);
  }

  // Strip everything except digits
  const digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 7) return null;

  // Already has 972
  if (digits.startsWith('972') && digits.length >= 11) return digits;

  // Israeli local: 0x → 972x
  if (digits.startsWith('0') && digits.length === 10) return '972' + digits.slice(1);

  // Israeli without leading 0: 5xxxxxxxx (9 digits)
  if (digits.startsWith('5') && digits.length === 9) return '972' + digits;

  // US/Canada with 1: 1xxxxxxxxxx (11 digits)
  if (digits.startsWith('1') && digits.length === 11) return digits;

  // US/Canada without 1: xxxxxxxxxx (10 digits, starts with area code)
  if (!digits.startsWith('1') && digits.length === 10) return '1' + digits;

  // Other international (already has country code)
  if (digits.length >= 10) return digits;

  return null;
}

/**
 * Build a display name from raw CSV row fields.
 * Handles cases where the name is embedded in the ID column.
 */
function extractName(idCol, firstName, lastName) {
  const id = String(idCol || '').trim();
  let first = String(firstName || '').trim();
  let last  = String(lastName  || '').trim();

  const hPattern = /H\d+/g;
  const hasH = hPattern.test(id);

  if (hasH) {
    const namePart = id.replace(/H\d+/g, '').replace(/\s+/g, ' ').trim();
    if (namePart && !first && !last) {
      const parts = namePart.split(' ');
      first = parts[0];
      last  = parts.slice(1).join(' ');
    }
  } else if (id && !first && !last) {
    // Pure name in ID column
    const parts = id.split(' ');
    first = parts[0];
    last  = parts.slice(1).join(' ');
  }

  return {
    first_name:   first,
    last_name:    last,
    display_name: [first, last].filter(Boolean).join(' ')
  };
}

/**
 * Parse a CSV file (Google Contacts export format).
 * Returns array of { phone, first_name, last_name, display_name }
 */
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines   = content.split('\n');
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);
  const phone1Idx = headers.findIndex(h => h.trim() === 'Phone 1 - Value');
  if (phone1Idx === -1) throw new Error('CSV missing "Phone 1 - Value" column');

  const results  = [];
  const seenPhones = new Set();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    const rawPhone  = cols[phone1Idx] || '';
    const idCol     = cols[0] || '';
    const firstName = cols[1] || '';
    const lastName  = cols[2] || '';

    const phone = normalizePhone(rawPhone);
    if (!phone) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);

    const name = extractName(idCol, firstName, lastName);
    results.push({ phone, ...name });
  }

  return results;
}

/**
 * Parse a single CSV line (handles quoted fields).
 */
function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Load contacts from a Google Sheet.
 * Expected columns: phone, first_name, last_name, display_name
 * (same format as our cleaned CSV output)
 */
async function loadFromSheet(sheetName) {
  const sheets = getSheets();
  const rows   = await sheets.getRows(sheetName); // returns array of row objects
  const results  = [];
  const seenPhones = new Set();

  for (const row of rows) {
    const phone = normalizePhone(row.phone || row['Phone 1 - Value'] || '');
    if (!phone) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);

    results.push({
      phone,
      first_name:   String(row.first_name  || '').trim(),
      last_name:    String(row.last_name   || '').trim(),
      display_name: String(row.display_name || [row.first_name, row.last_name].filter(Boolean).join(' ')).trim()
    });
  }

  return results;
}

/**
 * Load contacts from an uploaded file path.
 * Auto-detects CSV.
 */
function loadFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return parseCSV(filePath);
  throw new Error(`Unsupported file type: ${ext}`);
}

/**
 * Get a summary breakdown of contacts by timezone group.
 */
function getContactsSummary(contacts) {
  const { groupContactsByTimezone, getGroupLabel } = require('./timezoneMapper');
  const grouped = groupContactsByTimezone(contacts);
  const summary = [];

  for (const [group, members] of Object.entries(grouped)) {
    summary.push({
      group,
      label: getGroupLabel(group),
      count: members.length
    });
  }

  summary.sort((a, b) => b.count - a.count);
  return summary;
}

module.exports = {
  normalizePhone,
  extractName,
  parseCSV,
  loadFromFile,
  loadFromSheet,
  getContactsSummary,
};
