'use strict';
const db = require('./db/postgres');
const wa = require('./whatsapp');
const { normalizePhone, normalizeHolidayName, isMeaningfulHebrewQuery } = require('./utils');
const { sendCurrentVideoPage, sendNavigationButtons, sendVideoByNumber, formatSingleVideoAnswer } = require('./modules/videos');
const { sendUpcomingHolidaysMenu, sendAllHolidaysMenu, sendHolidayVideos } = require('./modules/holidays');
const { detectMenuGuidance, localSmartAnswer, tryOpenAIAnswer, handleSmartFaq, searchKnowledge } = require('./modules/search');
const { insertQuestion, setUserState, getUserState } = require('./db/postgres');
const game = require('./modules/game');

// ── WELCOME ───────────────────────────────────────────────────────────────────

async function sendWelcomeAndMainMenu(userId) {
  await db.setUserState(userId, {
    lastMenu: '',
    currentListKey: '',
    currentListTitle: '',
    currentOffset: 0,
    hasSeenWelcome: true,
  });

  const welcomeText =
    '🎮 *חדש! המשחק היומי של רבי לילדים!*\n' +
    'משימות יומיות, משחק טריוויה ופרסים אמיתיים!\n\n' +
    '🎬 *ספריית הסרטונים מחכה לך!*\n' +
    'בחרו נושא מהכפתורים, או פשוט כתבו מה אתם מחפשים.\n\n' +
    "💡 לדוגמה:\nסיפור מר' לויק לפסח";

  await wa.sendButtonsAndLog(userId, welcomeText, [
    { id: 'main_general', title: '👈 המשחק היומי 🎮' },
    { id: 'main_moshiach', title: 'לחיות משיח 🚀' },
    { id: 'main_story', title: 'סיפורים ודפי צביעה 🎨' },
  ], { action: 'main_menu_buttons_1' });

  await wa.sendButtonsAndLog(userId, '‏', [
    { id: 'main_niggun', title: 'זמן ניגונים 🎵' },
    { id: 'main_holidays', title: 'חגים וימי דפגרא 📅' },
    { id: 'game_referral', title: 'שתף וזכה 📲' },
  ], { action: 'main_menu_buttons_2' });
}

async function sendMainMenuButtonsOnly(userId) {
  await db.setUserState(userId, { lastMenu: '', currentListKey: '', currentListTitle: '', currentOffset: 0 });

  await wa.sendButtonsAndLog(userId, 'בחרו נושא מהכפתורים, או פשוט כתבו מה אתם מחפשים.', [
    { id: 'main_general', title: '👈 המשחק היומי 🎮' },
    { id: 'main_moshiach', title: 'לחיות משיח 🚀' },
    { id: 'main_story', title: 'סיפורים ודפי צביעה 🎨' },
  ], { action: 'main_menu_buttons_1_fastonly' });

  await wa.sendButtonsAndLog(userId, '‏', [
    { id: 'main_niggun', title: 'זמן ניגונים 🎵' },
    { id: 'main_holidays', title: 'חגים וימי דפגרא 📅' },
    { id: 'game_referral', title: 'שתף וזכה 📲' },
  ], { action: 'main_menu_buttons_2_fastonly' });
}

// ── SIMPLE LIST MENU ──────────────────────────────────────────────────────────

async function sendSimpleListMenu(userId, menuKey, bodyText, items) {
  await db.setUserState(userId, { lastMenu: menuKey, currentListKey: '', currentListTitle: '', currentOffset: 0 });
  const rows = (items || []).map(item => ({ id: item[0], title: item[1], description: item[2] || '' }));
  return wa.sendListAndLog(userId, bodyText, 'בחרו', 'אפשרויות', rows, { action: menuKey });
}

// ── VIDEO LIST BY KEY ─────────────────────────────────────────────────────────

async function sendVideoListByKey(userId, listKey, listTitle, backMenuKey) {
  await db.setUserState(userId, {
    lastMenu: backMenuKey || 'home',
    currentListKey: listKey,
    currentListTitle: listTitle,
    currentOffset: 0,
  });
  const state = await db.getUserState(userId);
  return sendCurrentVideoPage(userId, 0, state);
}

async function sendVideosByRebbe(userId, rebbeName) {
  const sheets = require('./db/sheets');
  const { normalizeHebrewSearch } = require('./utils');
  const index = await sheets.getVideoIndex();
  const items = index.filter(v =>
    normalizeHebrewSearch(v['Bot Main Category']) === normalizeHebrewSearch('שעת סיפור') &&
    normalizeHebrewSearch(v['Bot Sub Category']) === normalizeHebrewSearch('רבותינו נשיאינו') &&
    normalizeHebrewSearch(v['Bot Rebbe']) === normalizeHebrewSearch(rebbeName)
  );
  await db.setUserState(userId, {
    lastMenu: 'story_root',
    currentListKey: `rebbe:${rebbeName}`,
    currentListTitle: `👑 ${rebbeName}`,
    currentOffset: 0,
  });
  const state = await db.getUserState(userId);
  return sendCurrentVideoPage(userId, 0, state, items);
}

// ── ROUTE SELECTION ───────────────────────────────────────────────────────────

async function routeSelection(userId, id, title) {
  const sid = String(id || '');

  switch (sid) {
    case 'main_moshiach':
      return sendSimpleListMenu(userId, 'menu_moshiach', '🚀 לחיות משיח - בחרו נושא:', [
        ['moshiach_bring', 'מביאים את משיח 🚀', 'מה כל ילד יכול לעשות'],
        ['moshiach_temple', 'בית המקדש והגאולה 🏛️', 'מה יהיה בגאולה'],
        ['moshiach_rebbe', 'הרבי כמלך המשיח 👑', 'נשיא הדור והגאולה'],
        ['moshiach_geulah_life', 'חיים של גאולה 🌍', 'לחיות גאולה עכשיו'],
      ]);

    case 'main_story':
      await db.setUserState(userId, { lastMenu: 'story_root' });
      return wa.sendButtonsAndLog(userId, '📖 שעת סיפור ודפי צביעה - בחרו קבוצה:', [
        { id: 'story_kedumim', title: 'מקורות קדומים 📜' },
        { id: 'story_nesiim', title: 'רבותינו נשיאינו 👑' },
        { id: 'story_chassidim', title: 'סיפורי חסידים 🕯️' },
      ], { action: 'story_root' });

    case 'main_niggun':
      return sendSimpleListMenu(userId, 'menu_niggun', '🎵 זמן ניגונים - בחרו נושא:', [
        ['niggun_holidays', 'ניגוני חגים 📅', 'ניגונים של חגים ודפגרא'],
        ['niggun_moshiach', 'ניגוני משיח 🚀', 'ניגוני גאולה ומשיח'],
        ['niggun_simcha', 'ניגוני שמחה 🎉', 'שמחה וריקוד'],
        ['niggun_dveikus', 'ניגוני דבקות 💓', 'התעוררות ורגש'],
        ['niggun_chabad', 'ניגוני חב״ד 🎼', 'ניגונים קלאסיים'],
      ]);

    case 'main_holidays':
      await db.setUserState(userId, { lastMenu: 'holidays_root' });
      return wa.sendButtonsAndLog(userId, 'חגים וימי דפגרא 📅 - בחרו אפשרות:', [
        { id: 'holidays_upcoming', title: 'החגים הקרובים 🗓️' },
        { id: 'holidays_all', title: 'כל החגים 📜' },
        { id: 'nav_home', title: 'תפריט ראשי 🏠' },
      ], { action: 'holidays_root' });

    case 'main_topics':
      return sendSimpleListMenu(userId, 'menu_topics', '✨ נושאים נוספים - בחרו נושא:', [
        ['topic_tzivos', 'צבאות השם 🪖', ''],
        ['topic_hiskashrus', 'התקשרות לרבי 👑', ''],
        ['topic_middos', 'מידות טובות ❤️', ''],
        ['topic_pride', 'גאווה יהודית ✡️', ''],
        ['topic_torah', 'תורה ומצוות 📘', ''],
        ['topic_girls', 'בנות ישראל 👧', ''],
        ['topic_12psukim', 'י״ב הפסוקים 📜', ''],
        ['topic_weekly', 'התוכנית השבועית 🗓️', ''],
        ['topic_kids_action', 'ילדים בפעולה 🤸', ''],
      ]);

    case 'main_general':
      return game.startDailyGameFlow(userId);

    // Story
    case 'story_kedumim':   return sendVideoListByKey(userId, 'story_kedumim', '📜 ממקורות קדומים', 'story_root');
    case 'story_chassidim': return sendVideoListByKey(userId, 'story_chassidim', '🕯️ סיפורי חסידים', 'story_root');
    case 'story_nesiim':
      return sendSimpleListMenu(userId, 'menu_nesiim', '👑 רבותינו נשיאינו - בחרו רבי:', [
        ['rebbe:הבעש״ט', 'הבעש״ט ✨', ''],
        ['rebbe:המגיד', 'המגיד ✨', ''],
        ['rebbe:אדמו״ר הזקן', 'אדמו״ר הזקן ✨', ''],
        ['rebbe:אדמו״ר האמצעי', 'אדמו״ר האמצעי ✨', ''],
        ['rebbe:הצמח צדק', 'הצמח צדק ✨', ''],
        ['rebbe:הרבי מהר״ש', 'הרבי מהר״ש ✨', ''],
        ['rebbe:הרבי הרש״ב', 'הרבי הרש״ב ✨', ''],
        ['rebbe:הרבי הריי״צ', 'הרבי הריי״צ ✨', ''],
        ['rebbe:הרבי מלך המשיח', 'הרבי מלך המשיח ✨', ''],
      ]);

    // Moshiach
    case 'moshiach_bring':       return sendVideoListByKey(userId, 'moshiach_bring', '🚀 מביאים את משיח', 'menu_moshiach');
    case 'moshiach_temple':      return sendVideoListByKey(userId, 'moshiach_temple', '🏛️ בית המקדש והגאולה', 'menu_moshiach');
    case 'moshiach_rebbe':       return sendVideoListByKey(userId, 'moshiach_rebbe', '👑 הרבי כמלך המשיח', 'menu_moshiach');
    case 'moshiach_geulah_life': return sendVideoListByKey(userId, 'moshiach_geulah_life', '🌍 חיים של גאולה', 'menu_moshiach');

    // Niggun
    case 'niggun_holidays': return sendVideoListByKey(userId, 'niggun_holidays', '📅 ניגוני חגים וימי דפגרא', 'menu_niggun');
    case 'niggun_moshiach': return sendVideoListByKey(userId, 'niggun_moshiach', '🚀 ניגוני משיח וגאולה', 'menu_niggun');
    case 'niggun_simcha':   return sendVideoListByKey(userId, 'niggun_simcha', '🎉 ניגוני שמחה וריקוד', 'menu_niggun');
    case 'niggun_dveikus':  return sendVideoListByKey(userId, 'niggun_dveikus', '💓 ניגוני דבקות והתעוררות', 'menu_niggun');
    case 'niggun_chabad':   return sendVideoListByKey(userId, 'niggun_chabad', '🎼 ניגוני חב״ד קלאסיים', 'menu_niggun');

    // Topics
    case 'topic_tzivos':      return sendVideoListByKey(userId, 'topic_tzivos', '🪖 צבאות השם', 'menu_topics');
    case 'topic_hiskashrus':  return sendVideoListByKey(userId, 'topic_hiskashrus', '👑 התקשרות לרבי', 'menu_topics');
    case 'topic_middos':      return sendVideoListByKey(userId, 'topic_middos', '❤️ מידות טובות', 'menu_topics');
    case 'topic_pride':       return sendVideoListByKey(userId, 'topic_pride', '✡️ גאווה יהודית', 'menu_topics');
    case 'topic_torah':       return sendVideoListByKey(userId, 'topic_torah', '📘 תורה ומצוות', 'menu_topics');
    case 'topic_girls':       return sendVideoListByKey(userId, 'topic_girls', '👧 בנות ישראל', 'menu_topics');
    case 'topic_12psukim':    return sendVideoListByKey(userId, 'topic_12psukim', '📜 י״ב הפסוקים', 'menu_topics');
    case 'topic_weekly':      return sendVideoListByKey(userId, 'topic_weekly', '🗓️ התוכנית השבועית', 'menu_topics');
    case 'topic_kids_action': return sendVideoListByKey(userId, 'topic_kids_action', '🤸 ילדים בפעולה', 'menu_topics');

    // Holidays
    case 'holidays_upcoming': return sendUpcomingHolidaysMenu(userId);
    case 'holidays_all':      return sendAllHolidaysMenu(userId);

    // Navigation
    case 'nav_more': {
      const state = await db.getUserState(userId);
      return sendCurrentVideoPage(userId, (state.currentOffset || 0) + 10, state);
    }
    case 'nav_back':  return handleBackNavigation(userId);
    case 'nav_home':  return sendWelcomeAndMainMenu(userId);

    // Welcome back
    case 'wb_last_menu': return handleWelcomeBackLastMenu(userId);
    case 'wb_search':    return handleWelcomeBackSearch(userId);

    // Game
    case 'daily_game_notify':
      await db.setUserDailyGameNotify(normalizePhone(userId), true);
      return wa.sendTextAndLog(userId, "✅ בשמחה!\nנעדכן אתכם בעזרת ה' ברגע שהמשחק היומי יהיה מוכן.", { action: 'daily_game_notify_opt_in' });

    case 'game_missions':            return game.showDailyMissions(userId);
    case 'game_trivia':              return game.showDailyTriviaProgram(userId);
    case 'game_leaderboard':         return game.showLeaderboard(userId);
    case 'game_referral':            return game.showShareMenu(userId);
    case 'share_groups':             return game.sendShareForGroups(userId);
    case 'share_status':             return game.sendShareForStatus(userId);
    case 'game_add_child':           return game.startChildRegistration(userId);  // ← תוקן
    case 'game_settings':            return game.sendGameSettings(userId);
    case 'game_set_reminders':
    case 'game_change_reminder':     return game.startReminderTimeSetup(userId);
    case 'game_edit_child':          return game.showEditChildMenu(userId);
    case 'game_edit_name':           return game.startEditChildName(userId);
    case 'game_edit_birthday':       return game.startEditChildBirthday(userId);
    case 'game_turn_off_reminders':
      await db.deactivateReminders(normalizePhone(userId));
      return wa.sendTextAndLog(userId, 'הבנתי! עצרתי את התזכורות היומיות. תוכלו להפעיל אותן מחדש דרך הגדרות המשחק 🤫', { action: 'opt_out_reminders' });
    case 'game_turn_on_reminders':   // ← חסר בגרסה הקודמת
      await db.activateReminders(normalizePhone(userId));
      return wa.sendTextAndLog(userId, '✅ התזכורות הופעלו מחדש!', { action: 'game_reminders_on' });

    default: {
      if (sid.startsWith('holiday:'))        return sendHolidayVideos(userId, sid.substring('holiday:'.length));
      if (sid.startsWith('rebbe:'))          return sendVideosByRebbe(userId, sid.substring('rebbe:'.length));
      if (sid.startsWith('select_child:'))   return game.showChildGameMenu(userId, sid.substring('select_child:'.length));
      if (sid.startsWith('do_mission:'))     return game.showActionMission(userId, sid.substring('do_mission:'.length));
      if (sid.startsWith('confirm_mission:')) return game.executeActionMission(userId, sid.substring('confirm_mission:'.length));
      if (sid.startsWith('triv_lvl:')) {
        const parts = sid.split(':');
        return game.startVideoTrivia(userId, parts[1], parts[2]);
      }
      if (sid.startsWith('ans_trivia:')) {
        const parts = sid.split(':');
        return game.evaluateTriviaAnswer(userId, `TRIVIA_${parts[1].replace('TRIVIA_', '')}`, parts[2]);
      }

      await wa.sendTextAndLog(userId, 'לא זיהיתי את הבחירה. נחזור לתפריט הראשי 🙂', { action: 'unknown_route', route: id });
      return sendWelcomeAndMainMenu(userId);
    }
  }
}

// ── BACK NAVIGATION ───────────────────────────────────────────────────────────

async function handleBackNavigation(userId) {
  const state = await db.getUserState(userId);
  const last = state.lastMenu || '';
  if (!last || last === 'home') return sendWelcomeAndMainMenu(userId);
  if (last === 'holidays_root') return routeSelection(userId, 'main_holidays', '');
  if (last === 'story_root')    return routeSelection(userId, 'main_story', '');
  if (last === 'menu_moshiach') return routeSelection(userId, 'main_moshiach', '');
  if (last === 'menu_niggun')   return routeSelection(userId, 'main_niggun', '');
  if (last === 'menu_topics')   return routeSelection(userId, 'main_topics', '');
  return sendWelcomeAndMainMenu(userId);
}

async function handleWelcomeBackLastMenu(userId) {
  const state = await db.getUserState(userId);
  const last = state.lastMenu || '';
  const menuMap = {
    'holidays_root': 'main_holidays', 'story_root': 'main_story',
    'menu_moshiach': 'main_moshiach', 'menu_niggun': 'main_niggun',
    'menu_topics': 'main_topics', 'menu_nesiim': 'story_nesiim',
  };
  const routeId = menuMap[last];
  if (routeId) return routeSelection(userId, routeId, '');
  return sendWelcomeAndMainMenu(userId);
}

async function handleWelcomeBackSearch(userId) {
  const state = await db.getUserState(userId);
  const pendingQuery = String(state.pendingQuery || '').trim();
  await db.setUserState(userId, { pendingQuery: '' });
  if (!pendingQuery) {
    return wa.sendTextAndLog(userId, '🔍 מה תרצו לחפש? כתבו את מה שאתם מחפשים.', { action: 'wb_search_no_query' });
  }
  return handleFreeText(userId, '', pendingQuery);
}

// ── FREE TEXT ─────────────────────────────────────────────────────────────────

async function handleFreeText(userId, profileName, messageText) {

  // 1. Menu guidance (מיידי)
  const guided = await detectMenuGuidance(messageText);
  if (guided) {
    await wa.sendTextAndLog(userId, guided.text, { action: 'free_text_guided_to_menu', route: guided.routeId, query: messageText });
    return routeSelection(userId, guided.routeId, '');
  }

  // 2. FAQ pattern matching (מיידי, ללא AI)
  const faqHandled = await handleSmartFaq(userId, messageText);
  if (faqHandled) return;

  // 3. Knowledge base search (Google Sheets)
  const knowledgeAnswer = await searchKnowledge(messageText);
  if (knowledgeAnswer) {
    await wa.sendTextAndLog(userId, knowledgeAnswer, { action: 'free_text_knowledge', query: messageText });
    await insertQuestion({ phone: userId, name: profileName, message: messageText, questionType: 'free_text', botReply: knowledgeAnswer, matchedType: 'knowledge', matchedIds: '' });
    return;
  }

  // 4. OpenAI (וידאו + תשובה כללית)
  const aiAnswer = await tryOpenAIAnswer(messageText, userId);
  if (aiAnswer) {
    if (aiAnswer.mode === 'video' && aiAnswer.video) {
      const videoText = formatSingleVideoAnswer(aiAnswer.video, aiAnswer.introText || '');
      await wa.sendTextAndLog(userId, videoText, { action: 'free_text_ai_video', query: messageText });
      await insertQuestion({ phone: userId, name: profileName, message: messageText, questionType: 'free_text', botReply: videoText, matchedType: 'video', matchedIds: aiAnswer.video['VD ID'] || '' });
      return;
    }
    if (aiAnswer.mode === 'answer' && aiAnswer.text) {
      await wa.sendTextAndLog(userId, aiAnswer.text, { action: 'free_text_ai_answer', query: messageText });
      await insertQuestion({ phone: userId, name: profileName, message: messageText, questionType: 'free_text', botReply: aiAnswer.text, matchedType: 'ai_answer', matchedIds: '' });
      return;
    }
  }

  // 5. Local smart answer (ללא AI)
  const local = await localSmartAnswer(messageText);
  if (local && local.kind === 'single_video' && local.video) {
    const localText = formatSingleVideoAnswer(local.video, '');
    await wa.sendTextAndLog(userId, localText, { action: 'free_text_local_video', query: messageText });
    await insertQuestion({ phone: userId, name: profileName, message: messageText, questionType: 'free_text', botReply: localText, matchedType: 'video', matchedIds: local.video['VD ID'] || '' });
    return;
  }

  // 6. Meaningful query check
  if (!isMeaningfulHebrewQuery(messageText)) {
    const nonsenseText = '😉 אני מבין עברית כשמדברים איתי בעברית...\nנסו לכתוב מה אתם מחפשים בצורה קצת יותר ברורה.';
    await wa.sendTextAndLog(userId, nonsenseText, { action: 'free_text_nonsense', query: messageText });
    await insertQuestion({ phone: userId, name: profileName, message: messageText, questionType: 'free_text', botReply: nonsenseText, matchedType: 'none', matchedIds: '' });
    return;
  }

  // 7. No match
  const noMatchText = '😔 סליחה, לא מצאתי כרגע משהו מתאים לחיפוש הזה.\n\n📚 אני כל הזמן לומד ומנסה להשתפר, אז אפשר לנסות לכתוב את זה בצורה אחרת, או לבחור נושא מהתפריט.';
  await wa.sendTextAndLog(userId, noMatchText, { action: 'free_text_no_match', query: messageText });
  await insertQuestion({ phone: userId, name: profileName, message: messageText, questionType: 'free_text', botReply: noMatchText, matchedType: 'none', matchedIds: '' });
}

module.exports = { routeSelection, sendWelcomeAndMainMenu, sendMainMenuButtonsOnly, handleFreeText };
