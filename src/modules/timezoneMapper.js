// src/modules/timezoneMapper.js

// US/Canada area codes → timezone group
const US_AREA_CODES = {
  // Eastern (UTC-5/-4)
  east: [
    '201','202','203','207','212','215','216','217','218','219',
    '224','225','228','229','231','234','239','240','248','267',
    '270','276','301','302','304','305','309','310','312','313',
    '315','316','317','318','319','321','323','325','330','331',
    '334','336','337','339','347','351','352','360','385','386',
    '401','404','407','408','410','412','413','414','416','419',
    '423','424','425','430','434','440','443','458','463','469',
    '470','475','478','484','502','503','504','507','508','509',
    '510','512','513','515','516','517','518','520','530','531',
    '540','551','561','563','567','570','571','574','580','585',
    '586','601','603','605','606','607','608','609','610','612',
    '614','615','616','617','618','619','620','623','626','628',
    '630','631','636','646','651','657','660','661','678','679',
    '681','682','701','703','704','706','707','708','712','713',
    '714','716','717','718','719','720','724','725','727','731',
    '732','734','740','743','747','752','754','757','760','762',
    '763','765','770','772','773','774','775','779','781','785',
    '786','787','801','802','803','804','805','806','808','810',
    '812','813','814','815','816','817','818','828','830','831',
    '832','843','845','847','848','850','856','857','858','859',
    '860','862','863','864','865','870','872','878','901','903',
    '904','906','907','908','909','910','912','913','914','915',
    '916','917','918','919','920','925','928','929','931','936',
    '937','938','940','941','947','949','951','952','954','956',
    '959','970','971','972','973','978','979','980','984','985',
    '989'
  ],
  // Central (UTC-6/-5)
  central: [
    '205','251','256','262','281','314','316','402','405','406',
    '414','417','430','479','501','515','573','601','662','682',
    '701','712','713','715','806','870','901','903','913','915',
    '918','920','936','940','952','956','972'
  ],
  // Mountain (UTC-7/-6)  
  mountain: [
    '303','307','385','406','435','505','520','575','602','623',
    '720','801','928','970'
  ],
  // Pacific (UTC-8/-7)
  pacific: [
    '209','213','310','323','408','415','424','442','503','510',
    '530','541','559','562','619','626','628','650','657','661',
    '669','707','714','747','760','805','818','831','858','909',
    '916','925','949','951','971'
  ],
  // Canada East (UTC-5/-4) — treat same as Eastern
  canada_east: [
    '416','437','647',  // Toronto
    '438','514','579','819','873',  // Montreal/Quebec
    '204','431',  // Manitoba
    '506','782','902',  // Atlantic
  ],
  // Canada West (UTC-7/-6) — treat same as Mountain/Pacific
  canada_west: [
    '236','250','604','672','778',  // BC
    '403','587','780',  // Alberta
    '306','639'  // Saskatchewan
  ]
};

// Build lookup map: areaCode → group
const AREA_CODE_MAP = {};
for (const [group, codes] of Object.entries(US_AREA_CODES)) {
  for (const code of codes) {
    // Pacific/Mountain take priority over East/Central if duplicate
    if (!AREA_CODE_MAP[code] || group === 'pacific' || group === 'mountain') {
      AREA_CODE_MAP[code] = group;
    }
  }
}

// Country code → timezone group
const COUNTRY_CODE_MAP = {
  '972': 'israel',          // Israel       UTC+2/+3
  '98':  'israel',          // Iran         UTC+3:30 → closest to Israel
  '994': 'israel',          // Azerbaijan   UTC+4    → closest to Israel
  '995': 'israel',          // Georgia      UTC+4    → closest to Israel
  '998': 'israel',          // Uzbekistan   UTC+5    → closest to Israel
  '44':  'europe',          // UK           UTC+0/+1
  '33':  'europe',          // France       UTC+1/+2
  '32':  'europe',          // Belgium      UTC+1/+2
  '31':  'europe',          // Netherlands  UTC+1/+2
  '49':  'europe',          // Germany      UTC+1/+2
  '7':   'israel',          // Russia       UTC+3    → closest to Israel
  '380': 'europe',          // Ukraine      UTC+2/+3
  '972': 'israel',
};

// Timezone group → IANA timezone (for scheduling)
const GROUP_TO_TIMEZONE = {
  israel:       'Asia/Jerusalem',
  europe:       'Europe/Paris',
  east:         'America/New_York',
  central:      'America/Chicago',
  mountain:     'America/Denver',
  pacific:      'America/Los_Angeles',
  canada_east:  'America/Toronto',
  canada_west:  'America/Vancouver',
  other:        'Asia/Jerusalem',  // default fallback
};

// Group display names for UI
const GROUP_LABELS = {
  israel:       '🇮🇱 ישראל + קרובות',
  europe:       '🇪🇺 אירופה',
  east:         '🇺🇸 US East',
  central:      '🇺🇸 US Central',
  mountain:     '🇺🇸 US Mountain',
  pacific:      '🇺🇸 US West / Pacific',
  canada_east:  '🇨🇦 Canada East',
  canada_west:  '🇨🇦 Canada West',
  other:        '🌍 אחר',
};

/**
 * Map a phone number (digits only, with country code) to a timezone group.
 * @param {string} phone - e.g. '9725551234' or '13475551234'
 * @returns {string} group name
 */
function getTimezoneGroup(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return 'other';

  // Israel
  if (digits.startsWith('972')) return 'israel';

  // Other known country codes (check longest first)
  for (const [cc, group] of Object.entries(COUNTRY_CODE_MAP)) {
    if (digits.startsWith(cc)) return group;
  }

  // US / Canada (+1)
  if (digits.startsWith('1') && digits.length >= 11) {
    const areaCode = digits.substring(1, 4);
    const group = AREA_CODE_MAP[areaCode];
    if (group) return group;
    return 'east'; // US default fallback
  }

  return 'other';
}

/**
 * Get IANA timezone for a group.
 */
function getTimezone(group) {
  return GROUP_TO_TIMEZONE[group] || GROUP_TO_TIMEZONE.other;
}

/**
 * Get display label for a group.
 */
function getGroupLabel(group) {
  return GROUP_LABELS[group] || group;
}

/**
 * Given a date (YYYY-MM-DD) and local hour (0-23) for a group,
 * return the UTC Date object for when to send.
 */
function getScheduledUTC(dateStr, hourLocal, group) {
  const tz = getTimezone(group);
  // Build an ISO string in that timezone using Intl
  // We create the date in local time then find UTC equivalent
  const localStr = `${dateStr}T${String(hourLocal).padStart(2, '0')}:00:00`;
  
  // Use a trick: format a known UTC time in target tz, find the offset
  const target = new Date(localStr + 'Z'); // parse as UTC first
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  
  // Iterative approach: adjust for offset
  let utcMs = target.getTime();
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(utcMs));
    const p = {};
    for (const { type, value } of parts) p[type] = value;
    const localMs = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`).getTime();
    const targetMs = new Date(localStr + 'Z').getTime();
    utcMs += (targetMs - localMs);
  }
  
  return new Date(utcMs);
}

/**
 * Group an array of contacts by timezone group.
 * @param {Array<{phone, display_name}>} contacts
 * @returns {Object} { groupName: [contacts] }
 */
function groupContactsByTimezone(contacts) {
  const groups = {};
  for (const contact of contacts) {
    const group = getTimezoneGroup(contact.phone);
    if (!groups[group]) groups[group] = [];
    groups[group].push({ ...contact, timezone_group: group });
  }
  return groups;
}

/**
 * Filter contacts by country_filter setting.
 * @param {Array} contacts
 * @param {string} filter - 'all' | 'israel' | 'us' | 'canada' | 'europe'
 */
function filterContactsByCountry(contacts, filter) {
  if (!filter || filter === 'all') return contacts;

  const groupSets = {
    israel:  new Set(['israel']),
    us:      new Set(['east', 'central', 'mountain', 'pacific']),
    canada:  new Set(['canada_east', 'canada_west']),
    europe:  new Set(['europe']),
  };

  const allowed = groupSets[filter];
  if (!allowed) return contacts;

  return contacts.filter(c => allowed.has(getTimezoneGroup(c.phone)));
}

module.exports = {
  getTimezoneGroup,
  getTimezone,
  getGroupLabel,
  getScheduledUTC,
  groupContactsByTimezone,
  filterContactsByCountry,
  GROUP_LABELS,
  GROUP_TO_TIMEZONE,
};
