// Daily WhatsApp Reminder via Meta API
// Runs every day at 4:00 AM IST via GitHub Actions
// If yesterday was missed - sends yesterday first, then today

const admin = require('firebase-admin');
const fetch  = require('node-fetch');

admin.initializeApp({
  credential: admin.credential.cert({
    type:         'service_account',
    project_id:   process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// WhatsApp settings come from the app (Reminder Settings), GitHub Secrets are backup
var WA_TOKEN       = process.env.WA_TOKEN     || '';
var WA_PHONE_ID    = process.env.WA_PHONE_ID  || '';
var WA_TO_NUMBER   = process.env.WA_TO_NUMBER || '';
var TEMPLATE_NAME  = process.env.WA_TEMPLATE  || 'ps_daily_reminder';
const USER_UID     = process.env.FIREBASE_USER_UID;

// Test switch: add ":plain" after the template name in the app (e.g. ps_daily_reminder:plain)
// to send the same message with no emojis or special characters.
var PLAIN = false;
function plainText(t) {
  return String(t)
    .replace(/\|/g, ',')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(,\s*){2,}/g, ', ')
    .trim() || '-';
}

// Old single-variable template. Any other template name uses the 5-variable layout.
var LEGACY_TEMPLATES = ['ps_daily_reminder'];

async function loadWaConfig() {
  try {
    var snap = await db.collection('users').doc(USER_UID).collection('data').doc('waConfig').get();
    if (snap.exists) {
      var cfg = snap.data();
      if (cfg.token)    WA_TOKEN      = cfg.token;
      if (cfg.phoneId)  WA_PHONE_ID   = cfg.phoneId;
      if (cfg.toNumber) WA_TO_NUMBER  = cfg.toNumber;
      if (cfg.template) TEMPLATE_NAME = cfg.template;
      console.log('WhatsApp settings loaded from app. Template:', TEMPLATE_NAME);
    } else {
      console.log('No WhatsApp settings in app - using GitHub Secrets if present');
    }
  } catch (e) {
    console.log('Could not read WhatsApp settings:', e.message);
  }
}

// Meta rejects template variables containing newlines, tabs or 4+ spaces in a row
function cleanParam(text, max) {
  var t = String(text)
    .replace(/[ \t]*\r?\n+[ \t]*/g, ' | ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(\|\s*){2,}/g, '| ')
    .trim();
  if (!t) t = '-';
  if (t.length > max) t = t.slice(0, max - 3) + '...';
  return t;
}

// Send template message. params = array of strings, one per {{n}} in the template.
// Tries language "en" first, then "en_US".
async function sendWhatsApp(params) {
  var url = 'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages';
  var isHello = (TEMPLATE_NAME === 'hello_world');   // Meta's built-in test template (no variables)
  var languages = isHello ? ['en_US'] : ['en', 'en_US'];
  var lastError = null;
  var each = 300;

  for (var i = 0; i < languages.length; i++) {
    var body = {
      messaging_product: 'whatsapp',
      to: WA_TO_NUMBER,
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: languages[i] },
        components: [{
          type: 'body',
          parameters: params.map(function (p) {
            return { type: 'text', text: cleanParam(PLAIN ? plainText(p) : p, params.length === 1 ? 900 : each) };
          })
        }]
      }
    };

    if (isHello) { delete body.template.components; }

    var res = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await res.json();

    if (!data.error) {
      console.log('Meta response:', JSON.stringify(data));
      console.log('WhatsApp sent OK (language ' + languages[i] + '). Message ID:',
        data.messages && data.messages[0] && data.messages[0].id);
      return true;
    }
    lastError = data.error;
    if (data.error.code === 132001 && i < languages.length - 1) {
      console.log('Template not found in ' + languages[i] + ', trying ' + languages[i + 1] + '...');
      continue;
    }
    break;
  }
  throw new Error('WhatsApp error: ' + JSON.stringify(lastError));
}

// ---------- IST date helpers ----------
function getISTNow() {
  return new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  var d = getISTNow();
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}
function yesterdayStr() {
  var d = getISTNow();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}
function labelDate(dateStr) {
  var p = dateStr.split('-');
  return new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]))
    .toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function parseDateIST(dateStr) {
  if (!dateStr) return null;
  var p = dateStr.split('-');
  return new Date(Date.UTC(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2])));
}
function daysLeft(dateStr) {
  if (!dateStr) return null;
  var n = getISTNow();
  var nowDate = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  var target = parseDateIST(dateStr);
  if (!target) return null;
  return Math.round((target - nowDate) / 86400000);
}
function nextDueDate(lastDate, freq) {
  if (!lastDate || !freq) return null;
  var p = lastDate.split('-');
  var d = new Date(Date.UTC(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2])));
  d.setUTCDate(d.getUTCDate() + parseInt(freq));
  return d.toISOString().split('T')[0];
}
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
function when(d) { return d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + plural(d, 'day'); }

// ---------- Reminder settings (days before) ----------
var RS_DEFAULTS = { fc: 30, ins: 60, tax: 30, pucc: 15, passport: 90, health: 60, task: 10, kms: 500 };
var rs = RS_DEFAULTS;
function getRS(key) { return rs[key] || RS_DEFAULTS[key]; }

// ---------- Last sent tracking ----------
async function getLastSentDate() {
  try {
    var snap = await db.collection('users').doc(USER_UID).collection('data').doc('reminderMeta').get();
    return snap.exists ? (snap.data().lastSentDate || null) : null;
  } catch (e) { console.log('Could not read lastSentDate:', e.message); return null; }
}
async function saveLastSentDate(dateStr) {
  try {
    await db.collection('users').doc(USER_UID).collection('data').doc('reminderMeta')
      .set({ lastSentDate: dateStr, sentAt: new Date().toISOString() }, { merge: true });
    console.log('Saved lastSentDate:', dateStr);
  } catch (e) { console.log('Could not save lastSentDate:', e.message); }
}

// ---------- Sections: each returns an array of short lines with icons ----------
function taskLines(data) {
  var out = [];
  (data.tasks || []).forEach(function (t) {
    if (!t.lastDate || !t.freq) return;
    var d = daysLeft(nextDueDate(t.lastDate, t.freq));
    if (d === null) return;
    if (d < 0) out.push({ d: d, text: '🔴 ' + t.name + ' - overdue ' + plural(Math.abs(d), 'day') });
    else if (d <= getRS('task')) out.push({ d: d, text: '🟡 ' + t.name + ' - ' + when(d) });
  });
  return out.sort(function (a, b) { return a.d - b.d; }).map(function (x) { return x.text; });
}

function docLines(data) {
  var out = [];
  (data.docs || []).forEach(function (doc) {
    if (['Passport', 'Health Insurance'].indexOf(doc.type) === -1 || !doc.expiry) return;
    var d = daysLeft(doc.expiry);
    if (d === null) return;
    var limit = doc.type === 'Passport' ? getRS('passport') : getRS('health');
    var label = doc.name + ' ' + doc.type;
    if (d < 0) out.push({ d: d, text: '🔴 ' + label + ' - expired ' + plural(Math.abs(d), 'day') + ' ago' });
    else if (d <= limit) out.push({ d: d, text: '🟡 ' + label + ' - ' + when(d) });
  });
  return out.sort(function (a, b) { return a.d - b.d; }).map(function (x) { return x.text; });
}

function vehicleLines(data) {
  var keys = [{ key: 'fc', label: 'FC' }, { key: 'ins', label: 'Insurance' },
              { key: 'tax', label: 'Road Tax' }, { key: 'pucc', label: 'PUCC' }];
  var out = [];
  (data.vehicles || []).forEach(function (v) {
    keys.forEach(function (k) {
      if (v[k.key + '_none']) return;
      var exp = v[k.key + '_expiry'];
      if (!exp) return;
      var d = daysLeft(exp);
      if (d === null) return;
      var who = v.name + (v.plate ? ' (' + v.plate + ')' : '') + ' ' + k.label;
      if (d < 0) out.push({ d: d, text: '🔴 ' + who + ' - expired ' + plural(Math.abs(d), 'day') + ' ago' });
      else if (d <= getRS(k.key)) out.push({ d: d, text: '🟡 ' + who + ' - ' + when(d) });
    });
  });
  return out.sort(function (a, b) { return b.d < 0 && a.d < 0 ? b.d - a.d : a.d - b.d; })
            .map(function (x) { return x.text; });
}

function serviceLines(data) {
  var recs = data.maintRecords || [];
  var kms = data.vehicleKms || {};
  var names = [];
  recs.forEach(function (r) { if (r.vehicleName && names.indexOf(r.vehicleName) === -1) names.push(r.vehicleName); });
  var out = [];
  names.forEach(function (vName) {
    var list = recs.filter(function (r) { return r.vehicleName === vName && r.nextKms; })
                   .sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (!list.length || kms[vName] == null) return;
    var rem = list[0].nextKms - kms[vName];
    if (rem <= 0) out.push({ rem: rem, text: '🔴 ' + vName + ' - service overdue (due at ' + list[0].nextKms + ' KMS)' });
    else if (rem < getRS('kms')) out.push({ rem: rem, text: '🟡 ' + vName + ' - only ' + rem + ' KMS left' });
  });
  return out.sort(function (a, b) { return a.rem - b.rem; }).map(function (x) { return x.text; });
}

function joinLines(lines, max) {
  if (!lines.length) return '✅ All clear';
  max = max || 280;
  var out = '';
  for (var i = 0; i < lines.length; i++) {
    var next = out ? out + ' | ' + lines[i] : lines[i];
    if (next.length > max && i > 0) {
      return out + ' | +' + (lines.length - i) + ' more';
    }
    out = next;
  }
  return out;
}

// Build the message pieces for one day
function buildSections(data, dateStr, isMissed) {
  return {
    date:     (isMissed ? 'Yesterday, ' : '') + labelDate(dateStr),
    tasks:    joinLines(taskLines(data)),
    docs:     joinLines(docLines(data)),
    vehicles: joinLines(vehicleLines(data)),
    service:  joinLines(serviceLines(data))
  };
}

// Turn the pieces into template variables
function buildParams(s) {
  if (LEGACY_TEMPLATES.indexOf(TEMPLATE_NAME) !== -1) {
    // Old template has one variable, so everything goes in one line
    return ['📅 ' + s.date + ' | 🔔 Tasks: ' + s.tasks + ' | 🗂️ Documents: ' + s.docs +
            ' | 🚗 Vehicle papers: ' + s.vehicles + ' | 🔧 Service: ' + s.service];
  }
  return [s.date, s.tasks, s.docs, s.vehicles, s.service];
}

async function main() {
  console.log('WhatsApp Reminder starting...');
  if (!USER_UID) { console.error('FIREBASE_USER_UID not set!'); process.exit(1); }
  await loadWaConfig();
  if (/:plain$/.test(TEMPLATE_NAME)) {
    PLAIN = true;
    TEMPLATE_NAME = TEMPLATE_NAME.replace(/:plain$/, '');
    console.log('PLAIN TEST MODE: emojis and special characters removed');
  }
  if (!WA_TOKEN || !WA_PHONE_ID || !WA_TO_NUMBER) {
    console.error('WhatsApp details missing. Open the app > Menu > Reminder Settings > WhatsApp and save them.');
    process.exit(1);
  }

  console.log('Sending FROM phone number ID:', WA_PHONE_ID,
    '| TO: ending ' + String(WA_TO_NUMBER).slice(-4),
    '| Template:', TEMPLATE_NAME);

  var today = todayStr();
  var yesterday = yesterdayStr();
  var lastSent = await getLastSentDate();
  console.log('Today (IST):', today, '| Yesterday:', yesterday, '| Last sent:', lastSent || 'Never');

  var data = {};
  try {
    var snap = await db.collection('users').doc(USER_UID).collection('data').doc('appdata').get();
    if (!snap.exists) {
      await sendWhatsApp(['No data found. Open the app first.']);
      return;
    }
    data = snap.data();
    if (data.reminderSettings) rs = Object.assign({}, RS_DEFAULTS, data.reminderSettings);
    console.log('Data loaded. Tasks:', (data.tasks || []).length, '| Settings:', JSON.stringify(rs));
  } catch (e) {
    console.error('Firebase error:', e.message);
    process.exit(1);
  }

  var missedYesterday = lastSent && lastSent !== yesterday && lastSent !== today;

  try {
    if (missedYesterday) {
      console.log('Sending missed yesterday...');
      await sendWhatsApp(buildParams(buildSections(data, yesterday, true)));
      await new Promise(function (r) { setTimeout(r, 3000); });
    }
    console.log('Sending today...');
    await sendWhatsApp(buildParams(buildSections(data, today, false)));
    await saveLastSentDate(today);
    console.log('All done!');
  } catch (e) {
    console.error('Send failed:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) { main(); }
module.exports = { buildSections: buildSections, buildParams: buildParams, cleanParam: cleanParam };
