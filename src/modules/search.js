'use strict';
const axios = require('axios');
const sheets = require('../db/sheets');
const db = require('../db/postgres');
const wa = require('../whatsapp');
const { normalizeHebrewSearch, tokenizeHebrew, extractJsonObject, isMeaningfulHebrewQuery, normalizePhone } = require('../utils');
const { formatSingleVideoAnswer } = require('./videos');
const { getAllHolidayEntries } = require('./holidays');
const config = require('../config');

// ── BOT INFO CARD (נשלח ל-OpenAI כ-context) ──────────────────────────────────

const BOT_INFO = `
אתה עוזר חכם של הבוט "רבי לילדים" — ספריית וידאו לילדים עם מערכת משחק.

מידע על הבוט:
- שם: רבי לילדים
- מה הוא עושה: מוצא תוכניות וידאו חינוכיות לילדים חרדים/חסידים
- ניתן לחפש לפי נושא, חג, שם, דמות ועוד
- ניתן לקבל רשימות לפי קטגוריה (לחיות משיח, סיפורים, ניגונים, חגים, נושאים נוספים)

מערכת המשחק:
- ילדים אוספים יהלומים 💎 על ידי השלמת משימות יומיות ומשחק טריוויה
- כל 500 יהלומים = כרטיס אחד להגרלת היהלומים
- ישנן שתי הגרלות נפרדות: הגרלת יהלומים + הגרלת שיתופים
- ניתן לרשום מספר ילדים לכל מספר טלפון
- לאחר כל הגרלה, יהלומים שהומרו לכרטיסים יורדים מהקופה

הגדרות זמינות (דרך תפריט המשחק → הגדרות):
- שינוי שם ילד
- שינוי תאריך לידה
- הפעלה/כיבוי תזכורות יומיות
- שינוי שעת תזכורת

שיתוף:
- כל מספר טלפון מקבל קישור שיתוף אישי
- כשמישהו מצטרף דרך הקישור, המשתף מקבל כרטיס להגרלת השיתופים
`.trim();

// ── KNOWLEDGE BASE SEARCH ─────────────────────────────────────────────────────

async function searchKnowledge(messageText) {
  const q = normalizeHebrewSearch(messageText);
  if (!q || q.length < 2) return null;

  const rows = await sheets.getKnowledgeRows();
  if (!rows.length) return null;

  const tokens = tokenizeHebrew(q);
  let best = null;
  let bestScore = 0;

  for (const row of rows) {
    if (String(row['Active'] || '').toUpperCase() === 'FALSE') continue;
    const question = normalizeHebrewSearch(row['Question Pattern'] || row['Question'] || '');
    const keywords = normalizeHebrewSearch(row['Keywords'] || '');
    const answer = String(row['Answer'] || '').trim();
    if (!question || !answer) continue;

    let score = 0;
    for (const tok of tokens) {
      if (question.includes(tok)) score += 2;
      if (keywords.includes(tok)) score += 1;
    }
    // Full phrase match bonus
    if (question.includes(q)) score += 5;
    if (keywords.includes(q)) score += 3;

    if (score > bestScore && score >= 2) {
      bestScore = score;
      best = answer;
    }
  }

  return best;
}

// ── FAQ PATTERN MATCHING (מיידי, ללא AI) ─────────────────────────────────────

async function handleSmartFaq(userId, messageText) {
  const q = normalizeHebrewSearch(messageText);
  if (!q) return null;

  // ── כמה יהלומים / נקודות יש לי ──────────────────────────────────────────
  const diamondPatterns = ['כמה יהלומים', 'כמה נקודות', 'כמה ניקוד', 'היהלומים שלי', 'הנקודות שלי', 'כמה יש לי'];
  if (diamondPatterns.some(p => q.includes(normalizeHebrewSearch(p)))) {
    const state = await db.getUserState(userId);
    const childId = state.activeChildId;
    if (!childId) return null; // No active child — let normal flow handle
    const child = await db.getChildById(childId);
    if (!child) return null;
    const tickets = Math.floor(child.diamonds / 500);
    await wa.sendTextAndLog(userId,
      `💎 *היהלומים של ${child.name}:*\n\n` +
      `יש לך כרגע *${child.diamonds} יהלומים* 💎\n` +
      `זה שווה *${tickets} כרטיסים* להגרלה הקרובה 🎟️\n\n` +
      `💡 כל 500 יהלומים = כרטיס אחד`,
      { action: 'faq_diamonds', childId }
    );
    return true;
  }

  // ── מה הדירוג שלי / איפה אני בטבלה ──────────────────────────────────────
  const rankPatterns = ['הדירוג שלי', 'איפה אני', 'המיקום שלי', 'בטבלה', 'לוח תוצאות'];
  if (rankPatterns.some(p => q.includes(normalizeHebrewSearch(p)))) {
    const state = await db.getUserState(userId);
    const childId = state.activeChildId;
    if (!childId) return null;
    const { showLeaderboard } = require('./game');
    await showLeaderboard(userId);
    return true;
  }

  // ── מה הלינק שלי / קישור שיתוף ──────────────────────────────────────────
  const linkPatterns = ['הלינק שלי', 'הקישור שלי', 'קישור שיתוף', 'לינק שיתוף', 'להפיץ', 'לשתף'];
  if (linkPatterns.some(p => q.includes(normalizeHebrewSearch(p)))) {
    const { getShareLink } = require('./game');
    const link = getShareLink(userId);
    await wa.sendTextAndLog(userId,
      `📲 *הקישור האישי שלכם לשיתוף:*\n\n${link}\n\n` +
      `כל מי שיצטרף דרך הקישור הזה יזכה אתכם בכרטיס ל*הגרלת השיתופים*! 🎟️`,
      { action: 'faq_share_link' }
    );
    return true;
  }

  // ── מתי ההגרלה ───────────────────────────────────────────────────────────
  const rafflePatterns = ['מתי הגרלה', 'מתי ההגרלה', 'הגרלה הבאה', 'מתי יודעים'];
  if (rafflePatterns.some(p => q.includes(normalizeHebrewSearch(p)))) {
    const { getNextRaffleDateText } = require('./game');
    const nextRaffle = await getNextRaffleDateText();
    const text = nextRaffle
      ? `🎟️ *ההגרלה הקרובה:* ${nextRaffle}\n\n💡 כל 500 יהלומים = כרטיס אחד לזכייה!`
      : '🎟️ עדיין אין תאריך מוגדר להגרלה הבאה. נעדכן בקרוב!';
    await wa.sendTextAndLog(userId, text, { action: 'faq_raffle_date' });
    return true;
  }

  // ── רוצה לשנות שם / שגיתי בשם ───────────────────────────────────────────
  const editNamePatterns = ['לשנות שם', 'שגיתי בשם', 'לתקן שם', 'שם לא נכון', 'שם שגוי', 'עריכת שם'];
  if (editNamePatterns.some(p => q.includes(normalizeHebrewSearch(p)))) {
    await wa.sendButtonsAndLog(userId,
      '✏️ כדי לשנות שם, כנסו להגדרות המשחק:',
      [
        { id: 'game_settings', title: 'הגדרות ⚙️' },
        { id: 'nav_home', title: 'תפריט ראשי 🏠' },
      ],
      { action: 'faq_edit_name' }
    );
    return true;
  }

  // ── רוצה לשנות תאריך לידה ────────────────────────────────────────────────
  const editBdayPatterns = ['לשנות תאריך', 'שגיתי בתאריך', 'לתקן תאריך', 'תאריך לידה שגוי'];
  if (editBdayPatterns.some(p => q.includes(normalizeHebrewSearch(p)))) {
    await wa.sendButtonsAndLog(userId,
      '🎂 כדי לשנות תאריך לידה, כנסו להגדרות המשחק:',
      [
        { id: 'game_settings', title: 'הגדרות ⚙️' },
        { id: 'nav_home', title: 'תפריט ראשי 🏠' },
      ],
      { action: 'faq_edit_birthday' }
    );
    return true;
  }

  // ── כיצד מרוויחים יהלומים ────────────────────────────────────────────────
  const earnPatterns = ['איך מרוויחים', 'איך מקבלים יהלומים', 'איך צוברים', 'איך עובד המשחק'];
  if (earnPatterns.some(p => q.includes(normalizeHebrewSearch(p)))) {
    await wa.sendTextAndLog(userId,
      '💎 *איך מרוויחים יהלומים?*\n\n' +
      '🎯 *משימות יומיות* — השלימו משימה וקבלו יהלומים!\n' +
      '🧠 *טריוויה* — ענו נכון על שאלה = 10 יהלומים\n\n' +
      '💡 כל 500 יהלומים = כרטיס אחד להגרלה!\n' +
      '📲 כל מי שמצטרף דרך הקישור שלכם = כרטיס להגרלת השיתופים',
      { action: 'faq_how_to_earn' }
    );
    return true;
  }

  return null;
}

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
    const rebbe = normalizeHebrewSearch(v['Bot Rebbe'] || v['Bot Subcategory'] || '');

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

// ── OPENAI (וידאו + שאלות כלליות) ────────────────────────────────────────────

async function tryOpenAIAnswer(messageText, userId) {
  if (!config.AI_ENABLED || !config.OPENAI_API_KEY) return null;

  const candidates = await rankVideos(messageText, 8);
  const knowledgeRows = await sheets.getKnowledgeRows();

  // Build knowledge context
  const knowledgeContext = knowledgeRows
    .filter(r => String(r['Active'] || '').toUpperCase() !== 'FALSE' && r['Question'] && r['Answer'])
    .slice(0, 30)
    .map(r => `ש: ${r['Question']}\nת: ${r['Answer']}`)
    .join('\n\n');

  const candidateLines = candidates.map((v, idx) =>
    `${idx + 1}. ID=${v['VD ID'] || ''} | Title=${v['Video Name'] || ''} | Holidays=${v['VD Holidays'] || ''} | Search=${v['Search Text'] || ''} | Desc=${v['Video Description'] || ''}`
  ).join('\n');

  const systemPrompt =
    `${BOT_INFO}\n\n` +
    `=== שאלות ותשובות נפוצות ===\n${knowledgeContext || 'אין כרגע'}\n\n` +
    `=== הוראות ===\n` +
    `1. אם השאלה היא על וידאו ספציפי — החזר JSON: {"type":"video","pick":"VD_ID","intro":"טקסט קצר"}\n` +
    `2. אם השאלה כללית על הבוט/המשחק — החזר JSON: {"type":"answer","text":"תשובה בעברית"}\n` +
    `3. אם לא יודע — החזר JSON: {"type":"none"}\n` +
    `החזר JSON בלבד, ללא טקסט נוסף.`;

  const userPrompt = `שאלת המשתמש:\n${messageText}\n\nוידאוים זמינים:\n${candidateLines}`;

  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: config.OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    }, {
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
    });

    const text = String(((res.data.choices || [])[0] || {}).message?.content || '').trim();
    if (!text) return null;

    const parsed = extractJsonObject(text);
    if (!parsed || !parsed.type) return null;

    if (parsed.type === 'video' && parsed.pick && parsed.pick !== 'NONE') {
      const picked = candidates.find(v => String(v['VD ID'] || '') === String(parsed.pick));
      if (picked) return { mode: 'video', video: picked, introText: String(parsed.intro || '').trim() };
    }

    if (parsed.type === 'answer' && parsed.text) {
      return { mode: 'answer', text: String(parsed.text).trim() };
    }

    return null;
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
      text: '📚 נראה שאתם מחפשים רשימה כללית של תוכניות.\n\nכדי להגיע לכל התוכניות בצורה מסודרת, כדאי לבחור נושא דרך התפריט למטה. 😊',
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

module.exports = { rankVideos, localSmartAnswer, tryOpenAIAnswer, detectMenuGuidance, detectNoise, handleSmartFaq, searchKnowledge };
