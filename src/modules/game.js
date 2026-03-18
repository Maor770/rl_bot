'use strict';
const db = require('../db/postgres');
const sheets = require('../db/sheets');
const wa = require('../whatsapp');
const { normalizePhone, nowString, parseHebrewBirthday, normalizeHebrewSearch } = require('../utils');
const config = require('../config');
const dayjs = require('dayjs');

// ── RAFFLE DATE ───────────────────────────────────────────────────────────────

async function getNextRaffleDateText() {
  const today = dayjs().startOf('day');
  const res = await db.query(
    'SELECT raffle_date, hebrew_date FROM raffles WHERE raffle_date >= $1 AND status = $2 ORDER BY raffle_date ASC LIMIT 1',
    [today.format('YYYY-MM-DD'), 'Pending']
  );
  if (!res.rows.length) return '';
  const row = res.rows[0];
  if (row.hebrew_date) return String(row.hebrew_date);
  const d = dayjs(row.raffle_date);
  const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  return `יום ${dayNames[d.day()]}, ${d.format('DD/MM')}`;
}

async function getTodayRaffleType(dateStr) {
  const res = await db.query(
    'SELECT raffle_type FROM raffles WHERE raffle_date = $1 AND status = $2',
    [dateStr, 'Pending']
  );
  return res.rows.length ? String(res.rows[0].raffle_type || 'Diamonds') : null;
}

// ── FLOW ENTRY ────────────────────────────────────────────────────────────────

async function startDailyGameFlow(userId) {
  const children = await db.getChildrenForUser(userId);

  if (!children.length) {
    await wa.sendTextAndLog(userId,
      'ברוכים הבאים למשחק היומי של *רבי לילדים*! 🎉💎\n' +
      'בוא נתחיל לאסוף יהלומים ולזכות בפרסים, *מה השם שלך?*\n\n' +
      '(כתבו לי בהודעה את שם הילד או הילדה ואת שם המשפחה)',
      { action: 'game_start_no_children' }
    );
    await db.setUserState(userId, { expectedInput: 'REGISTER_CHILD_NAME' });
    return;
  }

  if (children.length === 1) return showChildGameMenu(userId, children[0].childId);

  const rows = children.map(c => ({ id: `select_child:${c.childId}`, title: `${c.name} 💎${c.diamonds}`, description: '' }));
  rows.push({ id: 'game_add_child', title: 'הוספת ילד נוסף ➕', description: '' });
  rows.push({ id: 'game_settings', title: 'הגדרות ⚙️', description: '' });

  await wa.sendListAndLog(userId, 'במי נבחר היום? 🎲', 'בחר משתמש', 'פרופילים', rows, { action: 'game_select_child' });
}

async function showChildGameMenu(userId, childId) {
  const child = await db.getChildById(childId);
  if (!child) return startDailyGameFlow(userId);
  await db.setUserState(userId, { activeChildId: childId });

  await wa.sendButtonsAndLog(userId,
    `היי *${child.name}*! 👋\nיש לך בקופה *${child.diamonds} יהלומים* 💎\n\nמה תרצו לעשות עכשיו?`,
    [
      { id: 'game_missions', title: 'המשימות היומיות 🎯' },
      { id: 'game_trivia', title: 'משחק טריוויה 🧠' },
      { id: 'game_referral', title: 'שתף וזכה 📲' },
    ],
    { action: 'game_child_menu', childId, diamonds: child.diamonds }
  );
}

// ── ONBOARDING ────────────────────────────────────────────────────────────────

async function handleOnboardingFlow(userId, input, state) {
  if (state.expectedInput === 'REGISTER_CHILD_NAME') {
    const childName = String(input || '').trim();
    if (!childName || childName.length < 2) {
      await wa.sendTextAndLog(userId, 'אנא כתבו שם תקין (לפחות 2 תווים)', { action: 'game_invalid_name' });
      return;
    }
    await db.setUserState(userId, { expectedInput: 'REGISTER_CHILD_BIRTHDAY', tempChildName: childName });
    await wa.sendTextAndLog(userId,
      `שמחים להכיר, *${childName}*! 🎉\n\nעכשיו — מתי יום הולדתך העברי?\nלדוגמה: כ׳ אדר, ה׳ ניסן, י״ג תשרי`,
      { action: 'game_ask_birthday' }
    );
    return;
  }

  if (state.expectedInput === 'REGISTER_CHILD_BIRTHDAY') {
    const childName2 = state.tempChildName || 'ילד';
    const bday = parseHebrewBirthday(input) || String(input || '').trim();
    const childId = `${normalizePhone(userId)}_${Date.now()}`;

    await db.addChild(normalizePhone(userId), childId, childName2, bday);
    await db.setUserState(userId, { expectedInput: '', activeChildId: childId, tempChildName: '' });

    await wa.sendButtonsAndLog(userId, 'מעולה! הפרופיל שלך מוכן! 🎉\n\nמה תרצו לעשות עכשיו?', [
      { id: 'game_add_child', title: 'הוסף ילד ➕' },
      { id: 'game_set_reminders', title: 'הגדרת תזכורות ⏰' },
    ], { action: 'game_profile_ready', childId });
    return;
  }

  if (state.expectedInput === 'SET_REMINDER_TIME') {
    const hour = parseInt(input, 10);
    if (isNaN(hour) || hour < 8 || hour > 21) {
      await wa.sendTextAndLog(userId, 'אנא כתבו שעה בין 8 ל-21, למשל: 17', { action: 'game_invalid_time' });
      return;
    }
    const time = `${hour}:00`;
    const childId2 = state.activeChildId || '';

    if (childId2) {
      await db.updateChildReminderTime(childId2, time);
    } else {
      const all = await db.getChildrenForUser(normalizePhone(userId));
      for (const c of all) await db.updateChildReminderTime(c.childId, time);
    }

    await db.setUserState(userId, { expectedInput: '' });
    const nextRaffle = await getNextRaffleDateText();

    await wa.sendButtonsAndLog(userId,
      `מצוין! נזכיר לכם כל יום ב-${time} 🔔\n\n` +
      (nextRaffle ? `🎟️ *הגרלת היהלומים* הבאה: *${nextRaffle}*\n\n` : '') +
      '⚠️ שימו לב: כדי שהבוט ימשיך לשלוח תזכורות, לחצו על הכפתור בהודעה שתקבלו.\n\n' +
      '💡 אפשר לשנות את השעה בכל שלב דרך הגדרות המשחק.\n\nמוכנים לשחק? 🎲',
      [
        { id: childId2 ? `select_child:${childId2}` : 'main_general', title: 'בואו נשחק! 🎲' },
        { id: 'nav_home', title: 'תפריט ראשי 🏠' },
      ],
      { action: 'game_reminder_set', time }
    );
    return;
  }

  await db.setUserState(userId, { expectedInput: '' });
}

// ── MISSIONS ──────────────────────────────────────────────────────────────────

async function showDailyMissions(userId) {
  const state = await db.getUserState(userId);
  const childId = state.activeChildId;
  if (!childId) return startDailyGameFlow(userId);

  const missions = await getAvailableMissions(childId);
  if (!missions.length) {
    await wa.sendButtonsAndLog(userId, '🌟 כל הכבוד! סיימת את כל המשימות להיום!\nחזרו מחר למשימות חדשות.', [
      { id: 'game_leaderboard', title: 'הדירוג שלי 🏆' },
      { id: `select_child:${childId}`, title: 'חזרה למשחק 🎲' },
      { id: 'nav_home', title: 'תפריט ראשי 🏠' },
    ], { action: 'game_all_missions_done', childId });
    return;
  }

  const rows = missions.slice(0, 10).map(m => ({
    id: `do_mission:${m.missionId}`,
    title: String(m.title || m.content || '').slice(0, 24),
    description: String(m.content || '').slice(0, 72),
  }));
  await wa.sendListAndLog(userId, '🎯 המשימות שמחכות לכם היום:', 'בחר משימה', 'משימות', rows, { action: 'game_show_missions', childId, count: missions.length });
}

async function showActionMission(userId, missionId) {
  const state = await db.getUserState(userId);
  const childId = state.activeChildId;
  if (!childId) return startDailyGameFlow(userId);

  if (await db.checkIfCompleted(childId, missionId)) {
    return wa.sendButtonsAndLog(userId, 'כבר קיבלת יהלומים על המשימה הזו היום! נסה משימה אחרת 😉💎', [
      { id: 'game_missions', title: 'משימה נוספת 🎯' },
      { id: 'game_leaderboard', title: 'הדירוג שלי 🏆' },
      { id: `select_child:${childId}`, title: 'חזרה למשחק 🎲' },
    ], { action: 'game_mission_already_done', childId, missionId });
  }

  const mission = await getMissionById(missionId);
  if (!mission) return wa.sendTextAndLog(userId, 'שגיאה - נסו שוב.', { action: 'game_mission_error' });

  const reward = Number(mission.reward || 10);
  await wa.sendButtonsAndLog(userId,
    `${mission.content}\n\nאם תשלימו את המשימה תקבלו *${reward} יהלומים* 💎`,
    [
      { id: `confirm_mission:${missionId}`, title: 'השלמתי המשימה ✅' },
      { id: 'game_missions', title: 'משימה אחרת 🎯' },
    ],
    { action: 'confirm_mission_prompt', childId, missionId }
  );
}

async function executeActionMission(userId, missionId) {
  const state = await db.getUserState(userId);
  const childId = state.activeChildId;
  if (!childId) return startDailyGameFlow(userId);
  if (await db.checkIfCompleted(childId, missionId)) return;

  const mission = await getMissionById(missionId);
  const reward = mission ? Number(mission.reward || 10) : 10;
  const successMsg = mission ? (mission.successMessage || 'כל הכבוד!') : 'כל הכבוד!';
  const child = await db.getChildById(childId);

  await db.rewardDiamonds(childId, reward, 'Action_Mission', missionId, child?.phone || userId);
  await db.markCompleted(childId, missionId);

  const nextRaffle = await getNextRaffleDateText();
  await wa.sendButtonsAndLog(userId,
    `🌟 ${successMsg}\nהוספתי *${reward} יהלומים* 💎 לקופה שלכם!` +
    (nextRaffle ? `\n\n🎟️ *הגרלת היהלומים* הבאה: *${nextRaffle}*` : ''),
    [
      { id: 'game_missions', title: 'משימה נוספת 🎯' },
      { id: 'game_leaderboard', title: 'הדירוג שלי 🏆' },
      { id: `select_child:${childId}`, title: 'חזרה למשחק 🎲' },
    ],
    { action: 'game_mission_complete', childId, missionId, reward }
  );
}

// ── TRIVIA ────────────────────────────────────────────────────────────────────

async function showDailyTriviaProgram(userId) {
  const state = await db.getUserState(userId);
  const childId = state.activeChildId;
  if (!childId) return startDailyGameFlow(userId);

  const triviaList = await getAvailableTrivia(childId);
  if (!triviaList.length) {
    await wa.sendButtonsAndLog(userId, '🌟 כל הכבוד! ענית על כל שאלות הטריוויה להיום!\nחזרו מחר לתוכנית חדשה.', [
      { id: 'game_leaderboard', title: 'הדירוג שלי 🏆' },
      { id: `select_child:${childId}`, title: 'חזרה למשחק 🎲' },
    ], { action: 'game_all_trivia_done', childId });
    return;
  }

  const activeProgNum = triviaList[0].programNum;
  const activeProgTitle = triviaList[0].programTitle;
  const progQs = triviaList.filter(q => q.programNum === activeProgNum);

  let hasEasy = false, hasMed = false, hasHard = false;
  const exactLevelStrings = {};
  for (const q of progQs) {
    exactLevelStrings[q.level] = true;
    if (q.level.includes('קל')) hasEasy = true;
    if (q.level.includes('בינוני')) hasMed = true;
    if (q.level.includes('קשה')) hasHard = true;
  }

  const btns = [];
  if (hasEasy) btns.push({ id: `triv_lvl:${activeProgNum}:קל`, title: 'קל 🟢' });
  if (hasMed) btns.push({ id: `triv_lvl:${activeProgNum}:בינוני`, title: 'בינוני 🟡' });
  if (hasHard) btns.push({ id: `triv_lvl:${activeProgNum}:קשה`, title: 'קשה 🔴' });

  if (!btns.length) {
    Object.keys(exactLevelStrings).slice(0, 3).forEach(k => {
      btns.push({ id: `triv_lvl:${activeProgNum}:${k.slice(0, 8)}`, title: k });
    });
  }

  await wa.sendButtonsAndLog(userId,
    `🧠 *הטריוויה היומית!*\n\n🎬 מתוך תוכנית מס': *${activeProgNum} - ${activeProgTitle}*\nנשארו לך עוד *${progQs.length}* שאלות פתוחות להיום.\n\nבאיזו דרגת קושי תרצו לשחק עכשיו?`,
    btns,
    { action: 'game_trivia_daily_program', childId, progNum: activeProgNum }
  );
}

async function startVideoTrivia(userId, progNum, lvlMatch) {
  const state = await db.getUserState(userId);
  const childId = state.activeChildId;
  if (!childId) return startDailyGameFlow(userId);

  const triviaList = await getAvailableTrivia(childId);
  const q = triviaList.find(t => t.programNum === progNum && t.level.includes(lvlMatch));

  if (!q) {
    return wa.sendButtonsAndLog(userId, 'כבר ענית על השאלות ברמה הזו! נסו דרגת קושי אחרת 😉', [
      { id: 'game_trivia', title: 'חזרה לרמות 🧠' },
    ], { action: 'game_trivia_level_done', childId, progNum });
  }

  await db.setUserState(userId, { activeMissionId: q.missionId });
  const sourceDisplay = q.source ? `\n\n💡 *מקור:* ${q.source}` : '';

  await wa.sendButtonsAndLog(userId,
    `שאלת טריוויה מס' ${q.idNum}:\n\n👈 *${q.content}*\n\nא. ${q.option1}\nב. ${q.option2}\nג. ${q.option3}${sourceDisplay}\n\n👈 בחרו את התשובה הנכונה מהכפתורים למטה`,
    [
      { id: `ans_trivia:${q.missionId}:1`, title: "תשובה א'" },
      { id: `ans_trivia:${q.missionId}:2`, title: "תשובה ב'" },
      { id: `ans_trivia:${q.missionId}:3`, title: "תשובה ג'" },
    ],
    { action: 'game_trivia_question', childId, missionId: q.missionId }
  );
}

async function evaluateTriviaAnswer(userId, missionId, answerNum) {
  const state = await db.getUserState(userId);
  const childId = state.activeChildId;
  if (!childId) return startDailyGameFlow(userId);

  if (await db.checkIfCompleted(childId, missionId)) {
    return wa.sendButtonsAndLog(userId, 'כבר ענית על השאלה הזו! נסו שאלה אחרת 😉', [
      { id: 'game_trivia', title: 'שאלה נוספת 🧠' },
    ], { action: 'game_trivia_already_done', childId, missionId });
  }

  const allTrivia = await sheets.getTriviaRows();
  const triviaNum = missionId.replace('TRIVIA_', '');
  const row = allTrivia.find(r => String(r["מס'"] || '') === triviaNum);
  if (!row) return wa.sendTextAndLog(userId, 'שגיאה - לא מצאתי את השאלה. נסו שוב.', { action: 'game_trivia_error' });

  const q = {
    option1: String(row['תשובה א'] || ''),
    option2: String(row['תשובה ב'] || ''),
    option3: String(row['תשובה ג'] || ''),
    correctOption: String(row['תשובה נכונה'] || ''),
    source: String(row['מקור'] || ''),
    reward: 10,
  };

  let expected = '1';
  const rawCorrect = q.correctOption.trim().replace(/['"]/g, '');
  if (rawCorrect === 'א' || rawCorrect === '1' || rawCorrect === q.option1) expected = '1';
  else if (rawCorrect === 'ב' || rawCorrect === '2' || rawCorrect === q.option2) expected = '2';
  else if (rawCorrect === 'ג' || rawCorrect === '3' || rawCorrect === q.option3) expected = '3';

  const isCorrect = String(answerNum) === expected;
  const sourceText = q.source ? `\n💡 *מקור:* ${q.source}` : '';
  const child = await db.getChildById(childId);

  await db.markCompleted(childId, missionId);
  await db.setUserState(userId, { activeMissionId: '' });

  if (isCorrect) {
    await db.rewardDiamonds(childId, q.reward, 'Trivia', missionId, child?.phone || userId);
    const nextRaffle = await getNextRaffleDateText();
    await wa.sendButtonsAndLog(userId,
      `🎉 תשובה נכונה!\nהוספתי *${q.reward} יהלומים* 💎 לקופה שלכם!${sourceText}` +
      (nextRaffle ? `\n🎟️ *הגרלת היהלומים* הבאה: *${nextRaffle}*` : ''),
      [
        { id: 'game_trivia', title: 'שאלה נוספת 🔄' },
        { id: 'game_leaderboard', title: 'הדירוג שלי 🏆' },
        { id: `select_child:${childId}`, title: 'חזרה למשחק 🎲' },
      ],
      { action: 'game_trivia_correct', childId, missionId, reward: q.reward }
    );
  } else {
    const correctText = expected === '1' ? `א. ${q.option1}` : (expected === '2' ? `ב. ${q.option2}` : `ג. ${q.option3}`);
    await wa.sendButtonsAndLog(userId,
      `😅 לא נורא... התשובה הנכונה היא: *${correctText}*.\n${sourceText}\n\nאתם מוזמנים לצפות שוב בתוכנית ולגלות דברים חדשים! 📺`,
      [
        { id: 'game_trivia', title: 'שאלה נוספת 🔄' },
        { id: 'game_leaderboard', title: 'הדירוג שלי 🏆' },
        { id: `select_child:${childId}`, title: 'חזרה למשחק 🎲' },
      ],
      { action: 'game_trivia_wrong', childId, missionId, answer: answerNum }
    );
  }
}

// ── LEADERBOARD ───────────────────────────────────────────────────────────────

async function showLeaderboard(userId) {
  const state = await db.getUserState(userId);
  const childId = state.activeChildId;
  if (!childId) return startDailyGameFlow(userId);

  const child = await db.getChildById(childId);
  const allChildren = await db.getAllChildrenSorted();
  const rank = allChildren.findIndex(c => c.childId === childId) + 1;

  const lines = ['🏆 *טבלת הדירוג*\n'];
  const top = allChildren.slice(0, 10);
  top.forEach((c, j) => {
    const medal = j === 0 ? '🥇' : j === 1 ? '🥈' : j === 2 ? '🥉' : `${j + 1}.`;
    const isMe = c.childId === childId ? ' ⬅️' : '';
    lines.push(`${medal} ${c.name} - ${c.diamonds} 💎${isMe}`);
  });

  if (rank > 10 && child) lines.push(`\n...\n${rank}. ${child.name} - ${child.diamonds} 💎 ⬅️`);
  lines.push('\n💡 כל 500 יהלומים = כרטיס ל*הגרלת היהלומים* הקרובה!\n⚠️ *חשוב לדעת:* לאחר כל הגרלה, יהלומים שהומרו לכרטיסים יורדים מהקופה כדי לתת לכולם הזדמנות שווה פעם נוספת! 🏃‍♂️');

  await wa.sendButtonsAndLog(userId, lines.join('\n'), [
    { id: `select_child:${childId}`, title: 'חזרה למשחק 🎲' },
    { id: 'nav_home', title: 'תפריט ראשי 🏠' },
  ], { action: 'game_leaderboard', childId, rank });
}

// ── SHARING ───────────────────────────────────────────────────────────────────

async function showShareMenu(userId) {
  const tickets = await db.getShareTickets(normalizePhone(userId));
  await wa.sendButtonsAndLog(userId,
    `🎁 *הגרלת השיתופים הגדולה!*\n\nיש לחשבון שלכם כרגע: *${tickets} כרטיסים* 🎟️\n\nכדי שעוד משפחות יוכלו ליהנות מזמן איכות חינוכי, *אנחנו צריכים את העזרה שלכם* ❤️\n\n🌟 *איך זה עובד?*\nכל משתתף חדש שיצטרף דרככם יזכה אתכם *בכרטיס נוסף* להגרלת השיתופים. צרפתם יותר אנשים? צברתם יותר כרטיסים! (הגרלה נפרדת מהגרלת היהלומים).\n\nב-2 קליקים פשוטים 👇 משתפים את הקישור ומפיצים טוב!`,
    [
      { id: 'share_groups', title: 'שיתוף לחברים 👥' },
      { id: 'share_status', title: 'לשיתוף בסטטוס 👏' },
    ],
    { action: 'game_share_menu', tickets }
  );
}

function buildShareText(userId) {
  const shareLink = `https://wa.me/${config.BOT_PUBLIC_WHATSAPP_NUMBER}?text=שלום+הגעתי+דרך+${normalizePhone(userId)}`;
  return `רציתי להמליץ לכם על הבוט החדש של *רבי לילדים* 🎉🤗\n\n📽️ בכמה לחיצות תקבלו תוכניות וידאו מרתקות של רבי לילדים על (כמעט) כל נושא שתרצו, *ללא עלות!* 💎\n\n🎮 *משחק יומי עם משימות, טריוויה ופרסים שווים!*\n\n${shareLink}`;
}

async function sendShareForGroups(userId) {
  await wa.sendTextAndLog(userId, buildShareText(userId), { action: 'share_groups_link' });
  await wa.sendTextAndLog(userId,
    "שני קליקים ואנחנו שם 💪\n\nבוחרים את ההודעה למעלה👆 >> לוחצים *העבר* >> לבני משפחה, חברים וקבוצת הורים (של הגן, כיתה, קהילה, בניין וכו')\n\nבזכותך *עוד ילדים* יקבלו את סרטוני *\"רבי לילדים\"* - תוכן חינוכי, מחזק ואיכותי שיעשה להם את היום 👑",
    { action: 'share_groups_instructions' }
  );
}

async function sendShareForStatus(userId) {
  await wa.sendTextAndLog(userId, buildShareText(userId), { action: 'share_status_link' });
  await wa.sendTextAndLog(userId,
    'שני קליקים ואנחנו שם 💪\n\nבוחרים את ההודעות למעלה👆 >> לוחצים *העבר* >> לסטטוס\n\nבזכותך *עוד ילדים* יקבלו את סרטוני *"רבי לילדים"* - תוכן חינוכי, מחזק ואיכותי שיעשה להם את היום 👑',
    { action: 'share_status_instructions' }
  );
}

async function processReferral(newUserId, referrerPhone) {
  if (!referrerPhone || newUserId === referrerPhone) return;
  const tickets = await db.addShareTicket(normalizePhone(referrerPhone));
  try {
    const { sendText } = require('../whatsapp');
    await sendText(referrerPhone, 'איזה יופי! 🎉 חבר חדש הצטרף דרכך!\nקיבלתם כרטיס אחד ל*הגרלת השיתופים* הגדולה! 🎟️\nשתפו עוד כדי להגדיל סיכויים! 📲');
  } catch (e) {}
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────

async function sendGameSettings(userId) {
  await wa.sendButtonsAndLog(userId, '⚙️ *הגדרות המשחק היומי:*', [
    { id: 'game_turn_off_reminders', title: 'כבה תזכורות 🔕' },
    { id: 'game_change_reminder', title: 'שנה שעת תזכורת ⏰' },
    { id: 'game_add_child', title: 'הוסף ילד ➕' },
  ], { action: 'game_settings' });
}

async function startReminderTimeSetup(userId) {
  await db.setUserState(userId, { expectedInput: 'SET_REMINDER_TIME' });
  await wa.sendTextAndLog(userId,
    '⏰ באיזו שעה תרצו לקבל תזכורת יומית?\n\nכתבו שעה בין 8 ל-21, למשל: 17\n\n💡 אפשר לשנות את השעה בכל שלב!',
    { action: 'game_ask_reminder_time' }
  );
}

// ── RAFFLE ENGINE ─────────────────────────────────────────────────────────────

async function executeRaffle(raffleType) {
  console.log(`[Game] Executing raffle type: ${raffleType}`);

  // Get available coupon
  const coupons = await sheets.getCouponsBank();
  const available = coupons.filter(c => String(c['Status'] || '').toLowerCase() === 'available' && String(c['Raffle_Type'] || 'Diamonds') === raffleType);
  if (!available.length) { console.log('[Game] No available coupons for raffle'); return; }

  const coupon = available[0];
  const couponCode = String(coupon['Coupon_Code'] || '');
  const couponDesc = String(coupon['Description'] || 'פרס מיוחד');

  let winnerPhone = '', winnerId = '', winnerMsg = '';

  if (raffleType === 'Share') {
    const allUsers = await db.getAllUsers();
    const pool = [];
    for (const u of allUsers) {
      const t = Number(u.share_tickets || 0);
      for (let i = 0; i < t; i++) pool.push(u.phone);
    }
    if (!pool.length) return;
    winnerPhone = pool[Math.floor(Math.random() * pool.length)];
    winnerId = winnerPhone;
    winnerMsg = `🎉🎉🎉 מזל טוב!\nזכית ב*הגרלת השיתופים* של היום!\n🎁 הפרס: *${couponDesc}*\n🔑 הקוד שלך: *${couponCode}*`;
    await db.resetAllShareTickets();
  } else {
    // Diamonds raffle
    const allChildren = await db.getAllChildrenSorted();
    const pool = [];
    for (const c of allChildren) {
      const tickets = Math.floor(c.diamonds / 500);
      for (let i = 0; i < tickets; i++) pool.push(c);
    }
    if (!pool.length) return;
    const winner = pool[Math.floor(Math.random() * pool.length)];
    winnerPhone = winner.phone;
    winnerId = winner.childId;
    winnerMsg = `🎉🎉🎉 מזל טוב ${winner.name}!\nזכית ב*הגרלת היהלומים* של היום!\n🎁 הפרס: *${couponDesc}*\n🔑 הקוד שלך: *${couponCode}*\n\nתראו לאמא ואבא! 😊`;
    await db.resetDiamondsForRaffle();
  }

  // Mark coupon used
  await db.query(
    'UPDATE raffles SET status = $1, winner_child_id = $2, coupon_code = $3 WHERE raffle_date = CURRENT_DATE AND raffle_type = $4',
    ['Completed', winnerId, couponCode, raffleType]
  );

  if (winnerPhone) {
    try { const { sendText } = require('../whatsapp'); await sendText(winnerPhone, winnerMsg); }
    catch (e) { console.error('[Game] Failed to notify winner:', e.message); }
  }

  console.log(`[Game] Raffle complete. Winner: ${winnerId}`);
}

async function sendFomoReminders(raffleType) {
  const allChildren = await db.getAllChildrenSorted();
  const notified = new Set();

  for (const c of allChildren) {
    if (!c.phone || notified.has(c.phone)) continue;
    const tickets = Math.floor(c.diamonds / 500);
    if (tickets <= 0) continue;
    notified.add(c.phone);
    try {
      const { sendText } = require('../whatsapp');
      await sendText(c.phone, `⏰ *תזכורת* — ההגרלה היום בשעה 18:00!\n\nיש לך *${tickets} כרטיסים* 🎟️\nשחקו עוד היום כדי לצבור יותר כרטיסים! 🎲`);
    } catch (e) {}
  }
}

// ── SCHEDULLED REMINDERS ──────────────────────────────────────────────────────

async function sendScheduledReminders(hour) {
  const children = await db.getChildrenDueForReminder(hour);
  const notified = new Set();

  for (const c of children) {
    if (!c.phone || notified.has(c.phone)) continue;
    notified.add(c.phone);
    try {
      const { sendButtonsAndLog } = require('../whatsapp');
      await sendButtonsAndLog(c.phone,
        `🔔 *תזכורת יומית!*\nשלום! הגיע הזמן לשחק במשחק היומי של *רבי לילדים*! 🎮\n\nצברו יהלומים 💎 וזכו בפרסים! 🎁`,
        [
          { id: 'main_general', title: 'בואו נשחק! 🎲' },
          { id: 'nav_home', title: 'תפריט ראשי 🏠' },
        ],
        { action: 'scheduled_reminder', childId: c.childId }
      );
    } catch (e) { console.error('[Game] Reminder error:', e.message); }
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function getAvailableMissions(childId) {
  const rows = await sheets.getMissionsBank();
  const child = await db.getChildById(childId);
  const completed = String(child?.completed || '').split(',');

  return rows
    .filter(r => {
      const id = String(r['Mission_ID'] || '');
      if (!id) return false;
      if (String(r['Active'] || '').toUpperCase() !== 'TRUE') return false;
      if (completed.includes(id)) return false;
      return true;
    })
    .map(r => ({
      missionId: String(r['Mission_ID'] || ''),
      type: String(r['Mission_Type'] || 'Action'),
      title: String(r['Title'] || ''),
      content: String(r['Content'] || ''),
      option1: String(r['Option_1'] || ''),
      option2: String(r['Option_2'] || ''),
      option3: String(r['Option_3'] || ''),
      correctOption: String(r['Correct_Option'] || ''),
      reward: Number(r['Reward_Diamonds'] || 10),
      successMessage: String(r['Success_Message'] || ''),
    }));
}

async function getMissionById(missionId) {
  const rows = await sheets.getMissionsBank();
  const row = rows.find(r => String(r['Mission_ID'] || '') === String(missionId));
  if (!row) return null;
  return {
    missionId,
    type: String(row['Mission_Type'] || 'Action'),
    title: String(row['Title'] || ''),
    content: String(row['Content'] || ''),
    option1: String(row['Option_1'] || ''),
    option2: String(row['Option_2'] || ''),
    option3: String(row['Option_3'] || ''),
    correctOption: String(row['Correct_Option'] || ''),
    reward: Number(row['Reward_Diamonds'] || 10),
    successMessage: String(row['Success_Message'] || ''),
  };
}

async function getAvailableTrivia(childId) {
  const rows = await sheets.getTriviaRows();
  const child = await db.getChildById(childId);
  const completed = String(child?.completed || '').split(',');

  return rows
    .filter(r => {
      const num = String(r["מס'"] || '');
      if (!num) return false;
      if (completed.includes(`TRIVIA_${num}`)) return false;
      return true;
    })
    .map(r => ({
      missionId: `TRIVIA_${r["מס'"]}`,
      idNum: String(r["מס'"] || ''),
      programNum: String(r['מספר תוכנית'] || ''),
      programTitle: String(r['כותרת הווידאו'] || ''),
      level: String(r['רמה'] || ''),
      content: String(r['שאלה'] || ''),
      option1: String(r['תשובה א'] || ''),
      option2: String(r['תשובה ב'] || ''),
      option3: String(r['תשובה ג'] || ''),
      correctOption: String(r['תשובה נכונה'] || ''),
      source: String(r['מקור'] || ''),
      reward: 10,
    }));
}

module.exports = {
  startDailyGameFlow, showChildGameMenu, handleOnboardingFlow,
  showDailyMissions, showActionMission, executeActionMission,
  showDailyTriviaProgram, startVideoTrivia, evaluateTriviaAnswer,
  showLeaderboard, showShareMenu, sendShareForGroups, sendShareForStatus,
  processReferral, sendGameSettings, startReminderTimeSetup,
  executeRaffle, sendFomoReminders, sendScheduledReminders,
  getTodayRaffleType, getNextRaffleDateText,
};
