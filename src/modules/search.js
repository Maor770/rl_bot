'use strict';
const axios = require('axios');
const sheets = require('../db/sheets');
const db = require('../db/postgres');
const wa = require('../whatsapp');
const { normalizeHebrewSearch, tokenizeHebrew, extractJsonObject, isMeaningfulHebrewQuery } = require('../utils');
const { formatSingleVideoAnswer } = require('./videos');
const { getAllHolidayEntries } = require('./holidays');
const config = require('../config');

// ── RANKING ───────────────────────────────────────────────────────────────────

async function rankVideos(messageText, limit = 5) {
  const q = normalizeHebrewSearch(messageText);
  if (!q) return [];

  const tokens = tokenizeHebrew(q);
  const videos = await sheets.getVideoIndex();

  const results = videos.map(v => {
    const title = normalizeHebrewSearch(v['Video Name'] || '');
    const searchText = normalizeHebrewSearch(v['Search Text'] || '');
    const holidays = normalizeHebrewSearch(v['VD Holidays'] || '');
    const desc = normalizeHebrewSearch(v['Video Description'] || '');
    const rebbe = normalizeHebrewSearch(v['Bot Subcategory'] || '');

    let score = 0;
    for (const tok of tokens) {
      if (!tok) continue;
      if (title.includes(tok)) score += 3.0;
      if (searchText.includes(tok)) score += 2.2;
      if (desc.includes(tok)) score += 1.8;
      if (holidays.includes(tok)) score += 1.5;
      if (rebbe.includes(tok)) score += 1.3;
    }

    const joined = tokens.join(' ');
    if (joined && title.includes(joined)) score += 3.5;
    if (joined && searchText.includes(joined)) score += 3.0;
    if (joined && desc.includes(joined)) score += 2.5;

    if (tokens.length >= 2) {
      const allIn = tokens.every(tok => title.includes(tok) || searchText.includes(tok) || desc.includes(tok));
      if (allIn) score += 2.5;
    }

    return { ...v, __score: score };
  });

  return results
    .filter(v => v.__score > 0)
    .sort((a, b) => b.__score - a.__score)
    .slice(0, limit);
}

// ── LOCAL SMART ANSWER ────────────────────────────────────────────────────────

async function localSmartAnswer(messageText) {
  const ranked = await rankVideos(messageText, 5);
  if (!ranked.length) return null;

  const best = ranked[0];
  const bestScore = Number(best.__score || 0);
  const secondScore = ranked[1] ? Number(ranked[1].__score || 0) : 0;

  if (bestScore < 2) return null;
  if (secondScore > 0 && bestScore < secondScore + 0.4) return null;

  return { kind: 'single_video', video: best };
}

// ── OPENAI ────────────────────────────────────────────────────────────────────

async function tryOpenAIAnswer(messageText) {
  if (!config.AI_ENABLED || !config.OPENAI_API_KEY) return null;

  const candidates = await rankVideos(messageText, 8);
  if (!candidates.length) return null;

  const candidateLines = candidates.map((v, idx) =>
    `${idx + 1}. ID=${v['VD ID'] || ''} | Title=${v['Video Name'] || ''} | Rebbe=${v['Bot Subcategory'] || ''} | Holidays=${v['VD Holidays'] || ''} | Search=${v['Search Text'] || ''} | Description=${v['Video Description'] || ''}`
  ).join('\n');

  const systemPrompt = 'אתה עוזר לבחור וידאו אחד מדויק בלבד מתוך רשימת מועמדים של ספריית וידאו לילדים. המטרה היא לבחור רק אם יש התאמה טובה וברורה לשאילתת המשתמש. אם אין התאמה טובה מספיק, תחזיר NONE. תחזיר JSON בלבד בפורמט {"pick":"VD_ID או NONE","intro":"טקסט קצר בעברית"}';
  const userPrompt = `שאילתת המשתמש:\n${messageText}\n\nמועמדים:\n${candidateLines}\n\nבחר תוצאה אחת בלבד אם היא באמת מדויקת.`;

  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: config.OPENAI_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.1,
    }, {
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
    });

    const text = String(((res.data.choices || [])[0] || {}).message?.content || '').trim();
    if (!text) return null;

    const parsed = extractJsonObject(text);
    if (!parsed || !parsed.pick || parsed.pick === 'NONE') return null;

    const picked = candidates.find(v => String(v['VD ID'] || '') === String(parsed.pick));
    if (!picked) return null;

    return { mode: 'video', video: picked, introText: String(parsed.intro || '').trim() };
  } catch (e) {
    console.error('[Search] OpenAI error:', e.message);
    return null;
  }
}

// ── MENU GUIDANCE ─────────────────────────────────────────────────────────────

async function detectMenuGuidance(messageText) {
  const q = normalizeHebrewSearch(messageText);
  if (!q) return null;

  const holidayEntries = await getAllHolidayEntries();
  for (const entry of holidayEntries) {
    const hName = normalizeHebrewSearch(entry.name);
    if (q.includes(hName) && (q.includes('כל') || q.includes('וידאו') || q.includes('סרט') || q.includes('רשימה'))) {
      return {
        routeId: 'main_holidays',
        text: '📚 נראה שאתם מחפשים רשימה כללית של תוכניות בנושא הזה.\n\nכדי להגיע לכל התוכניות בצורה מסודרת, כדאי לבחור בתפריט "חגים וימי דפגרא", ואז לבחור את החג המתאים. 😊',
      };
    }
  }

  if ((q.includes('כל') || q.includes('רשימה') || q.includes('וידאו')) &&
      (q.includes(normalizeHebrewSearch('הרבי')) || q.includes(normalizeHebrewSearch('רבי')))) {
    return {
      routeId: 'main_topics',
      text: '📚 נראה שאתם מחפשים רשימה כללית של תוכניות.\n\nכדי להגיע לכל התוכניות בצורה מסודרת, כדאי לבחור נושא דרך התפריט למטה - שם תמצאו את כל הרשימות המלאות בצורה נוחה וברורה. 😊',
    };
  }

  return null;
}

// ── NOISE DETECTION ───────────────────────────────────────────────────────────

function detectNoise(normalizedText) {
  const t = normalizedText || '';
  const testPhrases = ['בדיקה', 'טסט', 'test', 'testing', 'ping', 'check', 'עובד', 'עובד?', 'האם עובד'];
  if (testPhrases.includes(t)) return '✅ הבוט פועל ועובד!\nהנה התפריט — במה אפשר לעזור? 😊';

  const vagueRequest = ['אפשר סרטון', 'יש סרטון', 'תן סרטון', 'תשלח סרטון', 'יש לך משהו', 'מה יש', 'מה יש לך', 'תציע משהו', 'תמצא לי משהו', 'אפשר משהו'];
  if (vagueRequest.includes(t)) return '😊 בשמחה!\nעל איזה נושא תרצו סרטון? בחרו מהתפריט למטה:';

  const helpPhrases = ['לא עובד', 'לא מגיב', 'לא מגיעה', 'לא עונה', 'שבור', 'תקוע'];
  if (helpPhrases.includes(t)) return '😅 אם משהו לא עבד — נסו שוב!\nאם הבעיה ממשיכה, כתבו לנו ישירות 🙏\nבינתיים — הנה התפריט:';

  const vaguePhrases = ['מה אומר', 'מה אומרת', 'מה יש פה', 'מה זה', 'מה הבוט'];
  if (vaguePhrases.includes(t)) return '👋 אני בוט של "רבי לילדים" — אני עוזר למצוא תוכניות וסרטונים לילדים!\nכתבו מה אתם מחפשים, או בחרו מהתפריט 😊';

  return null;
}

module.exports = { rankVideos, localSmartAnswer, tryOpenAIAnswer, detectMenuGuidance, detectNoise };
