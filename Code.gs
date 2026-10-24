/**
 * Smart Day — a personal to-do list, calendar and Gmail assistant.
 *
 * Runs entirely inside your own Google account (Google Apps Script):
 *  - reads Gmail (read-only) every 5 minutes and finds exams, deadlines,
 *    interviews and events, auto-adding important ones and asking about the rest
 *  - picks up internship / job alert emails (Internshala, Unstop, LinkedIn...)
 *    and tells you when one matches your skills
 *  - keeps your to-do list, puts things on a "Smart Day" Google Calendar,
 *    and sends phone notifications through the free ntfy app
 *
 * Setup: see README.md. Run setup() once from the editor, then deploy as a web app.
 */

const APP_NAME = 'Smart Day';
const CAL_NAME = 'Smart Day';
const DAY_MS = 864e5;

const DEFAULT_SETTINGS = {
  name: '',
  skills: ['Python', 'Java', 'JavaScript', 'React', 'SQL', 'Machine Learning', 'Data Analysis', 'Web Development'],
  opportunitySenders: ['internshala.com', 'unstop.com', 'unstop.news', 'dare2compete.com', 'linkedin.com', 'naukri.com', 'wellfound.com', 'indeed.com', 'foundit.in'],
  importantSenders: ['.ac.in', '.edu'],
  importantKeywords: ['exam', 'hall ticket', 'admit card', 'placement', 'interview', 'deadline'],
  ignoreSenders: [],
  extraCalendars: [],       // other calendars to include, e.g. your second Gmail address
  autoAddScore: 4,          // emails scoring at least this are added without asking
  notifyAllOpenings: false, // false = only notify for openings that match your skills
  notifyAllEmails: false,   // true = a Telegram message for every new email
  remindBeforeMin: 60,      // to-do reminder lead time
  eventReminders: [1440, 60], // calendar popup reminders (minutes before)
  digestHour: 7,
  telegramToken: '',        // phone notifications via your own Telegram bot (see Settings in the app)
  telegramChatId: '',
  ntfyServer: 'https://ntfy.sh', // fallback if Telegram isn't connected
  ntfyTopic: ''
};

const SCHEMAS = {
  Tasks: ['id', 'title', 'notes', 'due', 'allDay', 'priority', 'done', 'doneAt', 'source', 'link', 'created', 'reminded', 'calEventId', 'ref', 'gtaskId'],
  Suggestions: ['id', 'title', 'start', 'allDay', 'kind', 'from', 'snippet', 'link', 'score', 'status', 'created'],
  Opportunities: ['id', 'title', 'platform', 'from', 'matched', 'deadline', 'snippet', 'link', 'applyLink', 'status', 'created'],
  Seen: ['msgId', 'ts'],
  Mail: ['id', 'msgId', 'from', 'subject', 'snippet', 'date', 'link', 'status', 'tag', 'created']
};

const KIND_LABEL = { exam: 'Exam', interview: 'Interview / test', deadline: 'Deadline', event: 'Event' };
const KIND_EMOJI = { exam: '📚 ', interview: '🎯 ', deadline: '⏳ ', event: '📅 ' };

const STRONG_RE = /\b(exams?|examination|mid[- ]?sems?|end[- ]?sems?|quiz|viva|(?:class|unit|online|mock|aptitude|coding) test|deadline|due (?:date|on|by)|submission|submit (?:by|before)|last date|interview|online assessment|assessment|coding round|aptitude|hackathon|registrations? clos(?:e|es|ing)|apply (?:by|before))\b/i;
const WEAK_RE = /\b(meeting|webinar|workshop|session|seminar|orientation|lecture|class|appointment|call|event|scheduled|reschedul\w*|invit\w*|reminder)\b/i;
const OPP_RE = /\b(internships?|jobs?|hiring|openings?|vacanc\w*|roles?|positions?|opportunit\w*|hackathons?|challenges?|competitions?|fellowships?|placements?|apply now|walk-?in)\b/i;
const PERSONAL_RE = /\b(you'?ve been|you are|registered|registration (?:successful|confirmed)|shortlisted|scheduled|reminder|round|assessment|interview|invit\w*|starts? (?:in|on|at|today|tomorrow))\b/i;
const DEADLINE_RE = /\b(apply by|apply before|last date|deadline|registrations? clos\w*|closes on|ends on|ending on)\b/i;
const KIND_RULES = [
  ['exam', /\b(exams?|examination|mid[- ]?sems?|end[- ]?sems?|quiz|viva|(?:class|unit|online|mock) test)\b/i],
  ['interview', /\b(interview|assessment|coding (?:round|test)|aptitude|shortlist\w*)\b/i],
  ['deadline', /\b(deadline|due|last date|submi\w*|apply (?:by|before)|registrations? clos\w*)\b/i]
];

// ───────────────────────── Web app ─────────────────────────

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.a) {
    // Links from notification buttons ("Add", "Ignore", "Done"...)
    let msg;
    try { msg = handleLinkAction(p.a, p.id); } catch (err) { msg = '⚠️ ' + err.message; }
    return HtmlService.createHtmlOutput(
      '<div style="font:18px system-ui,sans-serif;padding:48px 24px;text-align:center">' +
      '<p>' + escapeHtml(msg) + '</p><p><a href="' + appUrl() + '" target="_top">Open ' + APP_NAME + '</a></p></div>')
      .setTitle(APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function handleLinkAction(a, id) {
  switch (a) {
    case 'approve': {
      const r = findRow('Suggestions', id);
      if (!r) throw new Error('That item no longer exists');
      if (r.status === 'added') return '✅ Already in your calendar';
      approveSuggestion(id);
      return '✅ Added “' + r.title + '” to your calendar';
    }
    case 'ignore': ignoreSuggestion(id); return '👍 Ignored';
    case 'undo': undoSuggestion(id); return '↩️ Removed from your calendar';
    case 'done': {
      const t = findRow('Tasks', id);
      if (!t) throw new Error('That task no longer exists');
      t.done = '1'; t.doneAt = new Date().toISOString();
      mirrorTask(t); writeRow('Tasks', t);
      return '✓ Marked done';
    }
    case 'saveopp': setOppStatus(id, 'saved'); return '⭐ Saved to your Jobs list';
  }
  throw new Error('Unknown action');
}

/** Everything the app screen needs, in one call. */
function getState() {
  try { syncFromGoogleTasks(); } catch (e) { console.warn('Google Tasks sync failed', e); }
  const now = Date.now();
  const tasks = readAll('Tasks')
    .filter(t => !truthy(t.done) || now - (Date.parse(t.doneAt) || 0) < 3 * DAY_MS)
    .map(clean);
  const suggestions = readAll('Suggestions')
    .filter(r => r.status === 'pending' && Date.parse(r.start) > now - DAY_MS)
    .map(clean).reverse();
  const opportunities = readAll('Opportunities')
    .filter(r => r.status !== 'dismissed' && now - (Date.parse(r.created) || 0) < 45 * DAY_MS)
    .map(clean).reverse();
  const mail = readAll('Mail')
    .filter(m => m.status !== 'hidden' && now - (Date.parse(m.date) || 0) < 7 * DAY_MS)
    .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
    .slice(0, 150).map(clean);
  return {
    settings: getSettings(),
    tasks, suggestions, opportunities, mail,
    appUrl: appUrl(),
    dbUrl: db().getUrl(),
    lastScan: Number(props().getProperty('lastScan')) || 0,
    kinds: KIND_LABEL
  };
}

function runScanNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('A scan is already running, try again in a minute');
  try {
    const counts = scanGmail();
    return { counts, state: getState() };
  } finally { lock.releaseLock(); }
}

function testPush() {
  const s = getSettings();
  const ok = push('👋 Smart Day is connected', 'Notifications from your to-do app will show up here.', { click: appUrl() });
  if (!ok) throw new Error(s.telegramChatId
    ? 'Telegram didn\'t accept the message. Tap Connect Telegram again.'
    : 'Notifications aren\'t set up yet. Connect Telegram in Settings first.');
  return true;
}

/** Saves your bot token and finds your chat with the bot (you must have tapped Start in it). */
function connectTelegram(token) {
  token = String(token || '').trim();
  if (!/^\d+:[\w-]+$/.test(token)) throw new Error('That doesn\'t look like a bot token. It looks like 1234567890:AAH...');
  const me = telegram(token, 'getMe');
  if (!me.ok) throw new Error('Telegram didn\'t accept that token. Copy it again from BotFather.');
  const updates = telegram(token, 'getUpdates', {});
  const chats = (updates.result || [])
    .map(u => u.message || u.edited_message || u.my_chat_member)
    .filter(m => m && m.chat && m.chat.type === 'private');
  if (!chats.length) throw new Error('Open your bot @' + me.result.username + ' in Telegram, tap Start, then tap Connect again.');
  const s = getSettings();
  s.telegramToken = token;
  s.telegramChatId = String(chats[chats.length - 1].chat.id);
  saveSettingsRaw(s);
  push('👋 Smart Day is connected', 'Your reminders, email alerts and job openings will arrive here.', { click: appUrl() });
  return getState();
}

function telegram(token, method, body) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body || {}), muteHttpExceptions: true
  });
  let json = {};
  try { json = JSON.parse(res.getContentText()); } catch (e) { /* not JSON */ }
  if (!json.ok) console.warn('Telegram ' + method + ' failed: ' + res.getContentText().slice(0, 300));
  return json;
}

// ───────────────────────── Setup & triggers ─────────────────────────

function setup() {
  const s = getSettings();
  if (!s.ntfyTopic) {
    s.ntfyTopic = 'smartday-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    saveSettingsRaw(s);
  }
  db();
  getCalendar();
  installTriggers(s);
  if (tasksEnabled()) {
    syncFromGoogleTasks();
    Logger.log('✅ Your to-dos are synced to the "' + APP_NAME + '" list in Google Tasks.');
  }
  Logger.log('✅ Setup done. Gmail is checked every 5 minutes.');
  Logger.log('🗂  Your data lives in: ' + db().getUrl());
}

function installTriggers(s) {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('morningDigest').timeBased().everyDays(1).atHour(Number(s.digestHour) || 7).create();
}

/** Runs every 5 minutes. */
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    try { syncFromGoogleTasks(); } catch (e) { console.warn('Google Tasks sync failed', e); }
    scanGmail();
    checkTaskReminders();
  } finally { lock.releaseLock(); }
}

// ───────────────────────── Settings ─────────────────────────

function props() { return PropertiesService.getScriptProperties(); }

function getSettings() {
  let saved = {};
  try { saved = JSON.parse(props().getProperty('settings') || '{}'); } catch (e) { /* use defaults */ }
  return Object.assign({}, DEFAULT_SETTINGS, saved);
}

function saveSettingsRaw(s) { props().setProperty('settings', JSON.stringify(s)); }

function saveSettings(input) {
  const old = getSettings();
  const s = Object.assign({}, old);
  const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean);
  ['skills', 'opportunitySenders', 'importantSenders', 'importantKeywords', 'ignoreSenders', 'extraCalendars']
    .forEach(k => { if (k in input) s[k] = list(input[k]); });
  if ('eventReminders' in input) s.eventReminders = list(input.eventReminders).map(Number).filter(n => n >= 0 && n <= 40320);
  ['autoAddScore', 'remindBeforeMin', 'digestHour']
    .forEach(k => { if (k in input && input[k] !== '' && !isNaN(input[k])) s[k] = Number(input[k]); });
  ['name', 'ntfyServer', 'ntfyTopic'].forEach(k => { if (k in input) s[k] = String(input[k]).trim(); });
  if ('notifyAllOpenings' in input) s.notifyAllOpenings = !!input.notifyAllOpenings;
  if ('notifyAllEmails' in input) s.notifyAllEmails = !!input.notifyAllEmails;
  saveSettingsRaw(s);
  if (s.digestHour !== old.digestHour) installTriggers(s);
  const missing = subscribeExtraCalendars(s);
  if (missing.length) throw new Error('Saved, but I can\'t see the calendar of ' + missing.join(', ') +
    '. Share it with this account first (Google Calendar → Settings → Share with specific people).');
  return getState();
}

// ───────────────────────── Storage (a Google Sheet in your Drive) ─────────────────────────

let _ss = null;
function db() {
  if (_ss) return _ss;
  const id = props().getProperty('dbId');
  if (id) {
    try { _ss = SpreadsheetApp.openById(id); return _ss; } catch (e) { /* recreate below */ }
  }
  _ss = SpreadsheetApp.create(APP_NAME + ' data');
  props().setProperty('dbId', _ss.getId());
  Object.keys(SCHEMAS).forEach(sheet);
  const first = _ss.getSheets()[0];
  if (!SCHEMAS[first.getName()]) _ss.deleteSheet(first);
  return _ss;
}

function sheet(name) {
  const ss = db();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@'); // keep everything as plain text
    sh.getRange(1, 1, 1, SCHEMAS[name].length).setValues([SCHEMAS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (!_headerChecked[name]) {
    const cols = SCHEMAS[name];
    if (sh.getLastColumn() < cols.length) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    }
  }
  _headerChecked[name] = true;
  return sh;
}
const _headerChecked = {};

function readAll(name) {
  const sh = sheet(name), cols = SCHEMAS[name];
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { const v = r[j]; o[c] = v instanceof Date ? v.toISOString() : String(v); });
    return o;
  });
}

function toCells(name, obj) { return SCHEMAS[name].map(c => obj[c] == null ? '' : String(obj[c])); }
function appendRow(name, obj) { sheet(name).appendRow(toCells(name, obj)); return obj; }
function appendRows(name, objs) {
  if (!objs.length) return;
  const sh = sheet(name);
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, SCHEMAS[name].length).setNumberFormat('@').setValues(objs.map(o => toCells(name, o)));
}
function writeRow(name, obj) { sheet(name).getRange(obj._row, 1, 1, SCHEMAS[name].length).setValues([toCells(name, obj)]); }
function findRow(name, id) { return readAll(name).find(r => r.id === id) || null; }
function patchRow(name, id, changes) {
  const r = findRow(name, id);
  if (!r) throw new Error('Item not found');
  Object.assign(r, changes);
  writeRow(name, r);
  return r;
}
function deleteRow(name, id) { const r = findRow(name, id); if (r) sheet(name).deleteRow(r._row); return r; }
function clean(o) { const c = Object.assign({}, o); delete c._row; return c; }
function truthy(v) { return ['1', 'true', 'yes'].indexOf(String(v).toLowerCase()) >= 0; }
function uid() { return Utilities.getUuid().slice(0, 8); }

// ───────────────────────── Tasks ─────────────────────────

/** Add a to-do. If no due date is given, one is read from the text ("Pay fees friday 5pm"). */
function quickAdd(input) {
  const now = new Date();
  let title = String(input.text || '').trim();
  if (!title) throw new Error('Type something to add');
  let due = input.due || '', allDay = !!input.allDay;
  if (!due) {
    const w = parseWhen(title, now, { timeOnly: true });
    if (w) {
      due = w.date.toISOString();
      allDay = !w.hasTime;
      title = stripSpans(title, w.spans) || title;
    }
  }
  const task = {
    id: uid(), title, notes: input.notes || '', due, allDay: due && allDay ? '1' : '',
    priority: input.priority || 'normal', done: '', source: input.link ? 'gmail' : 'manual', link: input.link || '',
    created: now.toISOString()
  };
  if (input.toCalendar && due) task.calEventId = createCalendarEvent(title, due, allDay, task.notes);
  mirrorTask(task);
  appendRow('Tasks', task);
  if (input.mailId) {
    const m = findRow('Mail', input.mailId);
    if (m) { m.status = 'seen'; m.tag = m.tag || 'todo'; writeRow('Mail', m); }
  }
  return getState();
}

function updateTask(id, input) {
  const t = findRow('Tasks', id);
  if (!t) throw new Error('Task not found');
  const due = input.due || '', allDay = due && input.allDay ? '1' : '';
  const timingChanged = due !== t.due || allDay !== t.allDay;
  t.title = String(input.text || t.title).trim();
  t.notes = input.notes || '';
  t.priority = input.priority || 'normal';
  if (timingChanged) {
    t.due = due; t.allDay = allDay; t.reminded = '';
    if (t.calEventId) { deleteCalendarEvent(t.calEventId); t.calEventId = ''; }
  }
  if (due && (input.toCalendar || (timingChanged && t.ref)) && !t.calEventId) {
    t.calEventId = createCalendarEvent(t.title, due, !!allDay, t.notes);
  }
  mirrorTask(t);
  writeRow('Tasks', t);
  return getState();
}

function toggleTask(id) {
  const t = findRow('Tasks', id);
  if (!t) throw new Error('Task not found');
  const done = !truthy(t.done);
  t.done = done ? '1' : '';
  t.doneAt = done ? new Date().toISOString() : '';
  mirrorTask(t);
  writeRow('Tasks', t);
  return getState();
}

function deleteTask(id) {
  const t = deleteRow('Tasks', id);
  if (t && t.calEventId) deleteCalendarEvent(t.calEventId);
  if (t) removeGoogleTask(t);
  return getState();
}

function taskToCalendar(id) {
  const t = findRow('Tasks', id);
  if (!t || !t.due) throw new Error('Give the task a date first');
  if (!t.calEventId) {
    t.calEventId = createCalendarEvent(t.title, t.due, truthy(t.allDay), t.notes);
    writeRow('Tasks', t);
  }
  return getState();
}

function checkTaskReminders() {
  const s = getSettings(), now = Date.now(), lead = (Number(s.remindBeforeMin) || 60) * 60e3;
  readAll('Tasks').forEach(t => {
    // Tasks that are on the calendar already get calendar reminders.
    if (truthy(t.done) || truthy(t.reminded) || !t.due || truthy(t.allDay) || t.calEventId) return;
    const due = Date.parse(t.due);
    if (isNaN(due) || due - now > lead || due < now - 30 * 60e3) return;
    const mins = Math.round((due - now) / 60e3);
    push('⏰ ' + t.title, mins > 0 ? 'Due in ' + humanMins(mins) : 'Due now', {
      priority: 4, click: appUrl(), actions: [linkAction('✓ Done', { a: 'done', id: t.id })]
    });
    t.reminded = '1';
    writeRow('Tasks', t);
  });
}

// ───────────────────────── Google Tasks sync (for the home-screen widget) ─────────────────────────

function tasksEnabled() { return typeof Tasks !== 'undefined'; }

let _gtaskList = null;
/** The "Smart Day" list in Google Tasks (created if missing). */
function gtaskListId() {
  if (_gtaskList) return _gtaskList;
  const id = props().getProperty('tasklistId');
  if (id) {
    try { Tasks.Tasklists.get(id); _gtaskList = id; return id; } catch (e) { /* deleted, make a new one */ }
  }
  _gtaskList = Tasks.Tasklists.insert({ title: APP_NAME }).id;
  props().setProperty('tasklistId', _gtaskList);
  props().deleteProperty('gtasksSync');
  return _gtaskList;
}

function gtaskBody(t) {
  const done = truthy(t.done);
  const timed = t.due && !truthy(t.allDay);
  return {
    title: t.title,
    notes: [timed ? 'Due ' + formatTime(t.due) : '', t.notes || ''].filter(Boolean).join('\n').slice(0, 8000),
    status: done ? 'completed' : 'needsAction',
    completed: done ? (t.doneAt || new Date().toISOString()) : null,
    // Google Tasks keeps only the date of a due time
    due: t.due ? Utilities.formatDate(new Date(t.due), Session.getScriptTimeZone(), 'yyyy-MM-dd') + 'T00:00:00.000Z' : null
  };
}

/** Copies a Smart Day task to Google Tasks. Sets t.gtaskId; the caller saves the row. */
function mirrorTask(t) {
  if (!tasksEnabled()) return;
  try {
    const list = gtaskListId();
    if (t.gtaskId) {
      try { Tasks.Tasks.patch(gtaskBody(t), list, t.gtaskId); return; } catch (e) { t.gtaskId = ''; } // gone, re-create
    }
    t.gtaskId = Tasks.Tasks.insert(gtaskBody(t), list).id;
  } catch (e) { console.warn('Google Tasks sync failed', e); }
}

function removeGoogleTask(t) {
  if (!tasksEnabled() || !t.gtaskId) return;
  try { Tasks.Tasks.remove(gtaskListId(), t.gtaskId); } catch (e) { /* already gone */ }
}

/** Brings changes made in Google Tasks (widget, Calendar, Tasks app) back into Smart Day. */
function syncFromGoogleTasks() {
  if (!tasksEnabled()) return 0;
  const list = gtaskListId();
  const since = props().getProperty('gtasksSync');
  const started = new Date().toISOString();
  const local = readAll('Tasks');

  if (!since) {
    // First sync: copy every open Smart Day task into Google Tasks.
    local.filter(t => !truthy(t.done) && !t.gtaskId).forEach(t => { mirrorTask(t); writeRow('Tasks', t); });
    props().setProperty('gtasksSync', started);
    return 0;
  }

  const items = [];
  let pageToken = null;
  do {
    const opts = { showCompleted: true, showHidden: true, showDeleted: true, maxResults: 100, updatedMin: since };
    if (pageToken) opts.pageToken = pageToken;
    const res = Tasks.Tasks.list(list, opts);
    (res.items || []).forEach(g => items.push(g));
    pageToken = res.nextPageToken;
  } while (pageToken);

  const byG = {};
  local.forEach(t => { if (t.gtaskId) byG[t.gtaskId] = t; });
  const tz = Session.getScriptTimeZone();
  const toDelete = [];
  let changed = 0;

  items.forEach(g => {
    const t = byG[g.id];
    if (g.deleted) { if (t) toDelete.push(t); return; }
    const gDate = g.due ? g.due.slice(0, 10) : '';
    if (!t) {
      // Added from the widget or the Google Tasks app
      if (g.status === 'completed' || !g.title) return;
      appendRow('Tasks', {
        id: uid(), title: g.title, notes: g.notes || '', due: gDate ? dateOnlyToIso(gDate) : '', allDay: gDate ? '1' : '',
        priority: 'normal', done: '', source: 'gtasks', created: started, gtaskId: g.id
      });
      changed++;
      return;
    }
    let dirty = false;
    const done = g.status === 'completed';
    if (done !== truthy(t.done)) { t.done = done ? '1' : ''; t.doneAt = done ? (g.completed || started) : ''; dirty = true; }
    if (g.title && g.title !== t.title) { t.title = g.title; dirty = true; }
    const localDate = t.due ? Utilities.formatDate(new Date(t.due), tz, 'yyyy-MM-dd') : '';
    if (gDate !== localDate) {
      t.due = gDate ? dateOnlyToIso(gDate) : ''; t.allDay = gDate ? '1' : ''; t.reminded = '';
      dirty = true;
    }
    if (dirty) { writeRow('Tasks', t); changed++; }
  });

  toDelete.sort((a, b) => b._row - a._row).forEach(t => {
    if (t.calEventId) deleteCalendarEvent(t.calEventId);
    sheet('Tasks').deleteRow(t._row);
    changed++;
  });
  props().setProperty('gtasksSync', started);
  return changed;
}

/** "2026-10-30" → local midnight as ISO. */
function dateOnlyToIso(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

// ───────────────────────── Review queue (events found in Gmail) ─────────────────────────

function approveSuggestion(id, startIso, allDay) {
  const sug = findRow('Suggestions', id);
  if (!sug) throw new Error('Item not found');
  if (sug.status !== 'added') {
    if (startIso) { sug.start = startIso; sug.allDay = allDay ? '1' : ''; }
    sug.status = 'added';
    writeRow('Suggestions', sug);
    addSuggestionToCalendar(sug);
  }
  return getState();
}

function ignoreSuggestion(id) {
  patchRow('Suggestions', id, { status: 'ignored' });
  return getState();
}

/** "Not important" + never ask about this sender again. */
function muteSender(id) {
  const sug = patchRow('Suggestions', id, { status: 'ignored' });
  const addr = (sug.from.match(/<([^>]+)>/) || [, sug.from])[1].trim().toLowerCase();
  const s = getSettings();
  if (addr && s.ignoreSenders.indexOf(addr) < 0) { s.ignoreSenders.push(addr); saveSettingsRaw(s); }
  return getState();
}

function undoSuggestion(id) {
  readAll('Tasks').filter(t => t.ref === id).reverse().forEach(t => {
    if (t.calEventId) deleteCalendarEvent(t.calEventId);
    removeGoogleTask(t);
    sheet('Tasks').deleteRow(t._row);
  });
  patchRow('Suggestions', id, { status: 'ignored' });
  return getState();
}

function addSuggestionToCalendar(sug) {
  const allDay = truthy(sug.allDay);
  const evId = createCalendarEvent((KIND_EMOJI[sug.kind] || '') + sug.title, sug.start, allDay,
    'From: ' + sug.from + '\nEmail: ' + sug.link + '\n\n' + sug.snippet);
  const task = {
    id: uid(), title: sug.title, notes: sug.snippet, due: sug.start, allDay: allDay ? '1' : '',
    priority: sug.kind === 'event' ? 'normal' : 'high', done: '', source: 'gmail', link: sug.link,
    created: new Date().toISOString(), calEventId: evId, ref: sug.id
  };
  mirrorTask(task);
  appendRow('Tasks', task);
}

// ───────────────────────── Inbox (every email) ─────────────────────────

function mailSeen(id) {
  patchRow('Mail', id, { status: 'seen' });
  return getState();
}

function mailAllSeen() {
  const sh = sheet('Mail'), rows = readAll('Mail');
  if (rows.length) {
    const col = SCHEMAS.Mail.indexOf('status') + 1;
    sh.getRange(2, col, rows.length, 1).setValues(rows.map(r => [r.status === 'new' ? 'seen' : r.status]));
  }
  return getState();
}

function mailRowFor(msg, from, subject, body, link, tag, status, now) {
  return {
    id: uid(), msgId: msg.getId(), from, subject: cleanSubject(subject), snippet: makeSnippet(body),
    date: msg.getDate().toISOString(), link, status, tag, created: now.toISOString()
  };
}

/** Once: fill the inbox with the last 2 days of email so it isn't empty. */
function backfillMail() {
  const s = getSettings(), now = new Date(), have = new Set(readAll('Mail').map(r => r.msgId)), rows = [];
  GmailApp.search('newer_than:2d -in:spam -in:trash -in:chats', 0, 50).forEach(th => th.getMessages().forEach(msg => {
    if (have.has(msg.getId()) || now - msg.getDate() > 2 * DAY_MS) return;
    const from = msg.getFrom();
    if (senderMatches(from, s.ignoreSenders)) return;
    const body = (msg.getPlainBody() || '').slice(0, 2000);
    rows.push(mailRowFor(msg, from, msg.getSubject() || '(no subject)', body,
      'https://mail.google.com/mail/u/0/#all/' + msg.getId(), '', 'seen', now));
  }));
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  appendRows('Mail', rows);
  props().setProperty('mailBackfill', '1');
}

function pruneMail() {
  const sh = sheet('Mail'), rows = readAll('Mail'), cutoff = Date.now() - 14 * DAY_MS;
  let old = 0;
  while (old < rows.length && (Date.parse(rows[old].created) || 0) < cutoff) old++;
  if (old) sh.deleteRows(2, old);
}

// ───────────────────────── Opportunities ─────────────────────────

function setOppStatus(id, status) {
  patchRow('Opportunities', id, { status });
  return getState();
}

function oppDeadlineToCalendar(id) {
  const o = findRow('Opportunities', id);
  if (!o || !o.deadline) throw new Error('No deadline found for this one');
  const title = 'Apply: ' + o.title;
  const evId = createCalendarEvent('⏳ ' + title, o.deadline, true, (o.applyLink || o.link));
  const task = {
    id: uid(), title, notes: o.matched ? 'Matches: ' + o.matched : '', due: o.deadline, allDay: '1', priority: 'high',
    done: '', source: 'gmail', link: o.applyLink || o.link, created: new Date().toISOString(), calEventId: evId
  };
  mirrorTask(task);
  appendRow('Tasks', task);
  o.status = o.status === 'new' ? 'saved' : o.status;
  writeRow('Opportunities', o);
  return getState();
}

// ───────────────────────── Calendar ─────────────────────────

function getCalendar() {
  const id = props().getProperty('calId');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar(CAL_NAME, { color: CalendarApp.Color.PURPLE });
    props().setProperty('calId', cal.getId());
  }
  return cal;
}

function createCalendarEvent(title, startIso, allDay, description) {
  const s = getSettings(), cal = getCalendar(), start = new Date(startIso);
  const ev = allDay
    ? cal.createAllDayEvent(title, start, { description: description || '' })
    : cal.createEvent(title, start, new Date(start.getTime() + 3600e3), { description: description || '' });
  ev.removeAllReminders();
  (s.eventReminders || []).slice(0, 5).forEach(min => ev.addPopupReminder(Number(min)));
  return ev.getId();
}

function deleteCalendarEvent(eventId) {
  try { const ev = getCalendar().getEventById(eventId); if (ev) ev.deleteEvent(); } catch (e) { /* already gone */ }
}

/** Adds the calendars listed in settings to your calendar list. Returns the ones you don't have access to. */
function subscribeExtraCalendars(s) {
  const missing = [];
  (s.extraCalendars || []).forEach(id => {
    if (CalendarApp.getCalendarById(id)) return;
    try { CalendarApp.subscribeToCalendar(id, { selected: true }); } catch (e) { missing.push(id); }
  });
  return missing;
}

/** All calendars to show: Smart Day, your main one, every calendar ticked in Google Calendar, and extraCalendars. */
function listCalendars() {
  const mine = getCalendar(), byId = {};
  const add = cal => { if (cal && !byId[cal.getId()]) byId[cal.getId()] = cal; };
  add(mine);
  try { add(CalendarApp.getDefaultCalendar()); } catch (e) { /* ignore */ }
  try { CalendarApp.getAllCalendars().forEach(c => { if (c.isSelected() && !c.isHidden()) add(c); }); } catch (e) { /* ignore */ }
  (getSettings().extraCalendars || []).forEach(id => { try { add(CalendarApp.getCalendarById(id)); } catch (e) { /* no access */ } });
  return Object.keys(byId).map(id => byId[id]);
}

/** Events from all your calendars (see listCalendars). */
function getEvents(startIso, endIso) {
  const start = new Date(startIso), end = new Date(endIso), mineId = getCalendar().getId(), out = [];
  listCalendars().forEach(cal => {
    let color = '', name = '';
    try { color = cal.getColor(); name = cal.getName(); } catch (e) { /* ignore */ }
    let list = [];
    try { list = cal.getEvents(start, end); } catch (e) { console.warn('Could not read calendar ' + name, e); }
    list.forEach(ev => out.push({
      id: ev.getId(), title: ev.getTitle(),
      start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(),
      allDay: ev.isAllDayEvent(), mine: cal.getId() === mineId, cal: name, color
    }));
  });
  out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return out;
}

// ───────────────────────── Notifications (ntfy) ─────────────────────────

function push(title, message, opts) {
  const s = getSettings();
  opts = opts || {};
  if (s.telegramToken && s.telegramChatId) return pushTelegram(s, title, message, opts);
  if (!s.ntfyTopic) return false;
  const body = { topic: s.ntfyTopic, title, message: message || ' ', priority: opts.priority || 3 };
  if (opts.click) body.click = opts.click;
  const actions = (opts.actions || []).filter(Boolean).slice(0, 3);
  if (actions.length) body.actions = actions;
  try {
    const res = UrlFetchApp.fetch(String(s.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, ''), {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true
    });
    return res.getResponseCode() < 300;
  } catch (e) {
    console.warn('push failed', e);
    return false;
  }
}

function pushTelegram(s, title, message, opts) {
  const buttons = (opts.actions || []).filter(Boolean).map(a => ({ text: a.label, url: a.url }));
  if (opts.click && !buttons.some(b => b.url === opts.click)) buttons.unshift({ text: 'Open', url: opts.click });
  const body = {
    chat_id: s.telegramChatId, parse_mode: 'HTML', disable_web_page_preview: true,
    text: '<b>' + escapeHtml(title) + '</b>' + (message && message.trim() ? '\n' + escapeHtml(message) : '')
  };
  if (buttons.length) body.reply_markup = { inline_keyboard: [buttons.slice(0, 4)] };
  try { return !!telegram(s.telegramToken, 'sendMessage', body).ok; } catch (e) { console.warn('push failed', e); return false; }
}

function appUrl(params) {
  let base = '';
  try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { /* not deployed yet */ }
  if (!base || !params) return base;
  return base + '?' + Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
}

function linkAction(label, params) {
  const url = appUrl(params);
  return url ? { action: 'view', label, url, clear: true } : null;
}

function morningDigest() {
  const s = getSettings(), now = new Date(), start = startOfDay(now), end = addDays(start, 1);
  const events = getEvents(start.toISOString(), end.toISOString());
  const tasks = readAll('Tasks').filter(t => !truthy(t.done) && t.due);
  const t0 = start.getTime(), t1 = end.getTime(), week = addDays(start, 8).getTime();
  const dueToday = tasks.filter(t => Date.parse(t.due) >= t0 && Date.parse(t.due) < t1 && !t.calEventId);
  const overdue = tasks.filter(t => Date.parse(t.due) < t0);
  const comingUp = tasks.filter(t => t.priority === 'high' && Date.parse(t.due) >= t1 && Date.parse(t.due) < week)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  const pending = readAll('Suggestions').filter(r => r.status === 'pending' && Date.parse(r.start) > now.getTime()).length;
  const newOpps = readAll('Opportunities').filter(r => r.status === 'new' && r.matched).length;

  const lines = [];
  events.forEach(e => lines.push('📅 ' + (e.allDay ? '' : formatTime(e.start) + ' ') + e.title));
  dueToday.forEach(t => lines.push('☐ ' + t.title));
  if (overdue.length) lines.push('⚠️ ' + overdue.length + ' overdue: ' + overdue.slice(0, 3).map(t => t.title).join(', '));
  comingUp.slice(0, 3).forEach(t => {
    const days = Math.round((startOfDay(new Date(t.due)) - start) / DAY_MS);
    lines.push('⏳ ' + t.title + ' in ' + days + ' day' + (days === 1 ? '' : 's'));
  });
  if (pending) lines.push('🤔 ' + pending + ' email' + (pending === 1 ? '' : 's') + ' waiting for your OK');
  if (newOpps) lines.push('💼 ' + newOpps + ' new opening' + (newOpps === 1 ? '' : 's') + ' matching your skills');

  push('☀️ Good morning' + (s.name ? ', ' + s.name : ''), lines.join('\n') || 'Nothing scheduled today. Enjoy it!', { click: appUrl() });
  pruneSeen();
  pruneMail();
}

function pruneSeen() {
  const sh = sheet('Seen'), rows = sh.getLastRow() - 1;
  if (rows > 3000) sh.deleteRows(2, rows - 2000);
}

// ───────────────────────── Gmail scanning ─────────────────────────

function scanGmail() {
  const s = getSettings(), now = new Date();
  if (!props().getProperty('mailBackfill')) backfillMail();
  const last = Number(props().getProperty('lastScan'));
  const firstRun = !last;  // first scan looks back 3 days, quietly
  const from = (last || now.getTime() - 3 * DAY_MS) - 3600e3;
  const threads = GmailApp.search('after:' + Math.floor(from / 1000) + ' -in:spam -in:trash -in:chats', 0, 60);

  const seen = new Set(readAll('Seen').map(r => r.msgId));
  const known = new Set(readAll('Suggestions').map(r => eventKey(r.title, r.start))
    .concat(readAll('Tasks').map(r => eventKey(r.title, r.due))));
  const newSeen = [];
  const counts = { emails: 0, suggestions: 0, added: 0, openings: 0 };

  threads.forEach(th => th.getMessages().forEach(msg => {
    if (msg.getDate().getTime() < from) return;
    const id = msg.getId();
    if (seen.has(id)) return;
    seen.add(id);
    newSeen.push([id, now.toISOString()]);
    counts.emails++;
    try { handleMessage(msg, s, now, known, counts, firstRun); } catch (e) { console.warn('Skipped message ' + id, e); }
  }));

  if (newSeen.length) {
    const sh = sheet('Seen');
    sh.getRange(sh.getLastRow() + 1, 1, newSeen.length, 2).setNumberFormat('@').setValues(newSeen);
  }
  props().setProperty('lastScan', String(now.getTime()));
  return counts;
}

function handleMessage(msg, s, now, known, counts, silent) {
  const from = msg.getFrom();
  if (senderMatches(from, s.ignoreSenders)) return;
  const before = Object.assign({}, counts);
  const subject = msg.getSubject() || '(no subject)';
  const body = (msg.getPlainBody() || stripHtml(msg.getBody())).slice(0, 10000);
  const link = 'https://mail.google.com/mail/u/0/#all/' + msg.getId();
  // Calendar invites are already on your calendar, so only list them.
  if (!/calendar-notification@google\.com/i.test(from)) findThingsInEmail(msg, from, subject, body, link, s, now, known, counts, silent);
  const tag = counts.added > before.added ? 'added' : counts.suggestions > before.suggestions ? 'review'
    : counts.openings > before.openings ? 'job' : '';
  appendRow('Mail', mailRowFor(msg, from, subject, body, link, tag, 'new', now));
  if (s.notifyAllEmails && !tag && !silent) {
    push('✉️ ' + displayName(from), cleanSubject(subject) + '\n' + makeSnippet(body).slice(0, 140), { click: link });
  }
}

function findThingsInEmail(msg, from, subject, body, link, s, now, known, counts, silent) {
  const html = msg.getBody();
  const bulk = !!msg.getHeader('List-Unsubscribe') || /unsubscribe/i.test(body.slice(-3000));
  const notify = silent ? () => {} : push;

  analyzeEmail({ from, subject, body, bulk }, s, now).forEach(item => {
    if (item.type === 'opportunity') {
      const opp = appendRow('Opportunities', {
        id: uid(), title: item.title, platform: item.platform, from: displayName(from),
        matched: item.matched.join(', '), deadline: item.deadline, snippet: item.snippet, link,
        applyLink: findLink(html, s.opportunitySenders), status: 'new', created: now.toISOString()
      });
      counts.openings++;
      if (item.matched.length || s.notifyAllOpenings) {
        notify('💼 ' + item.platform + ': ' + item.title,
          (item.matched.length ? 'Matches your skills: ' + item.matched.join(', ') : item.snippet) +
          (item.deadline ? '\nApply by ' + describeWhen(item.deadline, true) : ''),
          { click: opp.applyLink || link, actions: [{ action: 'view', label: 'Open', url: opp.applyLink || link }, linkAction('⭐ Save', { a: 'saveopp', id: opp.id })] });
      }
      return;
    }

    const key = eventKey(item.title, item.start);
    if (known.has(key)) return;
    known.add(key);
    const sug = {
      id: uid(), title: item.title, start: item.start, allDay: item.allDay ? '1' : '', kind: item.kind,
      from, snippet: item.snippet, link, score: item.score, status: 'pending', created: now.toISOString()
    };
    const when = describeWhen(item.start, item.allDay);
    if (item.score >= Number(s.autoAddScore)) {
      sug.status = 'added';
      appendRow('Suggestions', sug);
      addSuggestionToCalendar(sug);
      counts.added++;
      notify('✅ Added: ' + item.title, when + ' · ' + KIND_LABEL[item.kind] + ' · from ' + displayName(from),
        { click: link, actions: [linkAction('↩️ Undo', { a: 'undo', id: sug.id })] });
    } else {
      appendRow('Suggestions', sug);
      counts.suggestions++;
      notify('🤔 Add to calendar? ' + item.title, when + ' · from ' + displayName(from), {
        click: appUrl(),
        actions: [linkAction('✅ Add', { a: 'approve', id: sug.id }), linkAction('✕ Ignore', { a: 'ignore', id: sug.id }), { action: 'view', label: 'Email', url: link }]
      });
    }
  });
}

// ───────────────────────── Email understanding (pure functions) ─────────────────────────

/**
 * Looks at one email and returns what it found:
 *   { type: 'opportunity', title, platform, matched: [skills], deadline, snippet }
 *   { type: 'event', title, start, allDay, kind, score, snippet }
 */
function analyzeEmail(email, s, now) {
  const items = [];
  const subject = cleanSubject(email.subject);
  const snippet = makeSnippet(email.body);
  const platform = senderMatches(email.from, s.opportunitySenders);
  let isOpp = false;
  if (platform && OPP_RE.test(subject + '\n' + email.body.slice(0, 1500))) {
    isOpp = true;
    const deadline = findDateNear(email.body, DEADLINE_RE, now);
    items.push({
      type: 'opportunity', title: subject, platform: platformName(platform),
      matched: matchSkills(subject + '\n' + email.body, s.skills),
      deadline: deadline ? deadline.date.toISOString() : '', snippet
    });
  }
  if (!isOpp || PERSONAL_RE.test(subject)) {
    const ev = detectEvent(email, subject, s, now, !!platform);
    if (ev) { ev.snippet = snippet; items.push(ev); }
  }
  return items;
}

function detectEvent(email, subject, s, now, fromPlatform) {
  const body = email.body.slice(0, 6000);
  const text = subject + '\n' + body;
  const kw = (s.importantKeywords || []).filter(k => k && wordRegex(k).test(text));
  const strongSubj = STRONG_RE.test(subject), strongBody = STRONG_RE.test(body), weak = WEAK_RE.test(text);
  if (!strongSubj && !strongBody && !weak && !kw.length) return null;

  let score = strongSubj ? 3 : strongBody ? 2 : 0;
  if (weak) score += 1;
  if (kw.length) score += 2;
  if (senderMatches(email.from, s.importantSenders)) score += 2;
  if (email.bulk) score -= 2;
  if (fromPlatform) score = Math.min(score, Number(s.autoAddScore) - 1); // platform mails always ask first
  if (score < 1) return null;

  const when = findEventDate(subject, body, now);
  if (!when) return null;
  if (when.hasTime && when.date < now) return null;

  let kind = 'event';
  for (const [k, re] of KIND_RULES) { if (re.test(subject)) { kind = k; break; } }
  if (kind === 'event') for (const [k, re] of KIND_RULES) { if (re.test(body)) { kind = k; break; } }

  return { type: 'event', title: subject, start: when.date.toISOString(), allDay: !when.hasTime, kind, score };
}

/** Date in the subject, else in body lines that talk about the event (and the lines right after). */
function findEventDate(subject, body, now) {
  const inSubject = parseWhen(subject, now);
  if (inSubject && inSubject.hasTime) return inSubject;
  const inBody = findEventDateInBody(body, now);
  if (inSubject) {
    // "Assessment starts tomorrow" + "at 11 AM" in the body
    const sameDay = inBody && inBody.hasTime && startOfDay(inBody.date).getTime() === startOfDay(inSubject.date).getTime();
    return sameDay ? inBody : inSubject;
  }
  return inBody;
}

function findEventDateInBody(body, now) {
  const lines = body.split(/\r?\n/).slice(0, 250);
  const LABEL_RE = /^\s*(date|time|when|day|schedule|starts?|ends?|deadline|timing)s?\b/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!(STRONG_RE.test(line) || WEAK_RE.test(line) || LABEL_RE.test(line))) continue;
    const w = parseWhen(lines.slice(i, i + 3).join(' \n '), now);
    if (w) return w;
  }
  return null;
}

function findDateNear(body, re, now) {
  const lines = body.split(/\r?\n/).slice(0, 400);
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    const w = parseWhen(lines.slice(i, i + 2).join(' \n '), now);
    if (w) return w;
  }
  return null;
}

function senderMatches(from, list) {
  const f = String(from || '').toLowerCase();
  return (list || []).find(x => x && f.indexOf(String(x).toLowerCase().trim()) >= 0) || '';
}

function platformName(entry) {
  const base = entry.replace(/^\.+/, '').split('.')[0];
  const known = { linkedin: 'LinkedIn', dare2compete: 'Unstop', foundit: 'Foundit' };
  return known[base] || base.charAt(0).toUpperCase() + base.slice(1);
}

function wordRegex(word) {
  const esc = String(word).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp('(^|[^a-z0-9])' + esc + '(?![a-z0-9+#])', 'i');
}

function matchSkills(text, skills) { return (skills || []).filter(sk => sk && wordRegex(sk).test(text)); }

function cleanSubject(s) { return String(s || '').replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().slice(0, 140) || '(no subject)'; }

function makeSnippet(body) { return String(body || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 220); }

function displayName(from) { const m = String(from).match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : String(from).trim(); }

function eventKey(title, iso) { return String(title).toLowerCase().replace(/\W+/g, '') + '|' + String(iso || '').slice(0, 10); }

function stripHtml(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ');
}

function findLink(html, domains) {
  const re = /href=["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const url = m[1].replace(/&amp;/g, '&');
    if (/unsubscribe|preferences|privacy|settings|mailto:/i.test(url)) continue;
    const host = (url.match(/^https?:\/\/([^/?#]+)/i) || [])[1] || '';
    if (domains.some(d => d && host.toLowerCase().indexOf(String(d).toLowerCase().replace(/^\.+/, '')) >= 0)) return url;
  }
  return '';
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function humanMins(m) { return m < 60 ? m + ' min' : Math.round(m / 60) + ' h'; }

function describeWhen(iso, allDay) {
  return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), allDay ? 'EEE, d MMM' : 'EEE, d MMM · h:mm a');
}

function formatTime(iso) { return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), 'h:mm a'); }

// ───────────────────────── Date parsing (pure functions) ─────────────────────────

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function monthIndex(s) { return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase()); }

/** All dates mentioned in the text: [{ index, length, date, explicit }] sorted by position. */
function findDates(text, now) {
  const today = startOfDay(now), found = [];
  const addYMD = (m, y, mon, d) => {
    if (mon < 0 || mon > 11 || d < 1 || d > 31) return;
    if (y == null) {
      y = today.getFullYear();
      if (new Date(y, mon, d) < addDays(today, -7)) y++; // "5 Jan" in late December means next year
    }
    const date = new Date(y, mon, d);
    if (date.getDate() !== d) return; // e.g. 31 Feb
    found.push({ index: m.index, length: m[0].length, date, explicit: true });
  };
  const rel = (m, days) => found.push({ index: m.index, length: m[0].length, date: addDays(today, days), explicit: false });
  let re, m;

  re = /\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/g;                       // 2026-10-25
  while ((m = re.exec(text))) addYMD(m, +m[1], +m[2] - 1, +m[3]);
  re = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d\d|\d\d)\b/g;          // 25/10/2026 (day first)
  while ((m = re.exec(text))) addYMD(m, +m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1]);
  re = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?' + MONTH_RE + '\\b\\.?(?:,?\\s*(20\\d\\d)\\b)?', 'gi'); // 25th Oct 2026
  while ((m = re.exec(text))) addYMD(m, m[3] ? +m[3] : null, monthIndex(m[2]), +m[1]);
  re = new RegExp('\\b' + MONTH_RE + '\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(20\\d\\d)\\b)?', 'gi'); // October 25, 2026
  while ((m = re.exec(text))) addYMD(m, m[3] ? +m[3] : null, monthIndex(m[1]), +m[2]);

  re = /\b(day after tomorrow|today|tonight|tomorrow|tmrw|tmr)\b/gi;
  while ((m = re.exec(text))) { const w = m[1].toLowerCase(); rel(m, w === 'day after tomorrow' ? 2 : /^(today|tonight)$/.test(w) ? 0 : 1); }
  re = /\b(?:(next|this|coming|on|by)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
  while ((m = re.exec(text))) {
    let diff = (WEEKDAYS.indexOf(m[2].toLowerCase()) - today.getDay() + 7) % 7;
    if (diff === 0 && m[1] && /next|coming/i.test(m[1])) diff = 7;
    rel(m, diff);
  }
  re = /\bin\s+(\d{1,2})\s+days?\b/gi;
  while ((m = re.exec(text))) rel(m, +m[1]);
  re = /\bnext week\b/gi;
  while ((m = re.exec(text))) rel(m, 7);

  found.sort((a, b) => a.index - b.index || b.length - a.length);
  const out = [];
  found.forEach(f => {
    const prev = out[out.length - 1];
    if (prev && f.index < prev.index + prev.length) {
      if (f.explicit && !prev.explicit) out[out.length - 1] = f; // explicit date wins over an overlapping weekday
      return;
    }
    out.push(f);
  });
  return out;
}

/** A time like "10:30 AM", "5pm", "14:00", "noon" in s. index is offset + position. */
function findTime(s, offset) {
  let m = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?![\w])/i.exec(s) ||
          /\b(\d{1,2})(?:\.(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?!\w)/i.exec(s);
  let h, min;
  if (m) {
    h = +m[1]; min = +(m[2] || 0);
    const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (ap) {
      if (h < 1 || h > 12) return null;
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
    } else if (h > 23) return null;
    if (min > 59) return null;
  } else {
    m = /\b(noon|midnight)\b/i.exec(s);
    if (!m) return null;
    if (m[1].toLowerCase() === 'noon') { h = 12; min = 0; } else { h = 23; min = 59; }
  }
  return { h, m: min, index: offset + m.index, length: m[0].length };
}

/**
 * The best upcoming date (+ time) in the text: { date, hasTime, spans }.
 * opts.timeOnly: also accept just a time ("call mom 6pm" → today/tomorrow 6pm).
 */
function parseWhen(text, now, opts) {
  opts = opts || {};
  now = now || new Date();
  text = String(text || '');
  const today = startOfDay(now);
  const cands = findDates(text, now).filter(c => c.date >= today && c.date < addDays(today, 400));
  const best = cands.find(c => c.explicit) || cands[0];
  if (!best) {
    if (!opts.timeOnly) return null;
    const t = findTime(text, 0);
    if (!t) return null;
    const d = new Date(today);
    d.setHours(t.h, t.m, 0, 0);
    if (d < now) d.setDate(d.getDate() + 1);
    return { date: d, hasTime: true, spans: [[t.index, t.index + t.length]] };
  }
  const end = best.index + best.length, beforeStart = Math.max(0, best.index - 30);
  const t = findTime(text.slice(end, end + 40), end) || findTime(text.slice(beforeStart, best.index), beforeStart);
  const d = new Date(best.date);
  const spans = [[best.index, end]];
  if (t) { d.setHours(t.h, t.m, 0, 0); spans.push([t.index, t.index + t.length]); }
  return { date: d, hasTime: !!t, spans };
}

/** Remove the date/time words from a typed task ("Pay fees by friday 5pm" → "Pay fees"). */
function stripSpans(text, spans) {
  let out = text;
  spans.slice().sort((a, b) => b[0] - a[0]).forEach(([a, b]) => { out = out.slice(0, a) + ' ' + out.slice(b); });
  out = out.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) out = out.replace(/\s*\b(on|by|at|before|due|for|from)\s*$/i, '').replace(/[\s,:\-–]+$/, '');
  return out;
}
