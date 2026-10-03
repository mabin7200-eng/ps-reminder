// PS Expense - Daily WhatsApp Reminder via Meta API
// Runs every day at 4:00 AM IST via GitHub Actions
// If missed yesterday - catches up and sends both days

const admin = require('firebase-admin');
const fetch  = require('node-fetch');

// Firebase Init
admin.initializeApp({
  credential: admin.credential.cert({
    type:         'service_account',
    project_id:   process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// WhatsApp Config
// Values come from the app (Reminder Settings -> WhatsApp), with GitHub Secrets as backup
var WA_TOKEN       = process.env.WA_TOKEN       || '';
var WA_PHONE_ID    = process.env.WA_PHONE_ID    || '';
var WA_TO_NUMBER   = process.env.WA_TO_NUMBER   || '';
var TEMPLATE_NAME  = process.env.WA_TEMPLATE    || 'ps_daily_reminder';
const USER_UID     = process.env.FIREBASE_USER_UID;

async function loadWaConfig() {
  try {
    var snap = await db.collection('users').doc(USER_UID).collection('data').doc('waConfig').get();
    if (snap.exists) {
      var cfg = snap.data();
      if (cfg.token)    WA_TOKEN      = cfg.token;
      if (cfg.phoneId)  WA_PHONE_ID   = cfg.phoneId;
      if (cfg.toNumber) WA_TO_NUMBER  = cfg.toNumber;
      if (cfg.template) TEMPLATE_NAME = cfg.template;
      console.log('WhatsApp settings loaded from app');
    } else {
      console.log('No WhatsApp settings in app - using GitHub Secrets if present');
    }
  } catch (e) {
    console.log('Could not read WhatsApp settings:', e.message);
  }
}

// Meta rejects template parameters containing newlines, tabs or 4+ spaces in a row
function cleanParam(text) {
  var t = String(text)
    .replace(/[ \t]*\r?\n+[ \t]*/g, ' | ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(\|\s*){2,}/g, '| ')
    .trim();
  if (t.length > 900) t = t.slice(0, 897) + '...';
  return t;
}

// Send WhatsApp message via Meta API
// Tries language "en" first, then "en_US" (templates created as "English (US)" use en_US)
async function sendWhatsApp(messageText) {
  var url = 'https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages';
  var languages = ['en', 'en_US'];
  var lastError = null;

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
          parameters: [{ type: 'text', text: cleanParam(messageText) }]
        }]
      }
    };

    var res = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + WA_TOKEN,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(body)
    });
    var data = await res.json();

    if (!data.error) {
      console.log('WhatsApp sent OK (language ' + languages[i] + '). Message ID:',
        data.messages && data.messages[0] && data.messages[0].id);
      return true;
    }

    lastError = data.error;
    // 132001 = template not found in this language -> try the next language code
    if (data.error.code === 132001 && i < languages.length - 1) {
      console.log('Template not found in ' + languages[i] + ', trying ' + languages[i + 1] + '...');
      continue;
    }
    break;
  }
  throw new Error('WhatsApp error: ' + JSON.stringify(lastError));
}

// Date helpers - IST aware
function getISTNow() {
  var now = new Date();
  var istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset);
}

function todayStr() {
  var ist = getISTNow();
  return ist.getUTCFullYear() + '-' +
    String(ist.getUTCMonth() + 1).padStart(2,'0') + '-' +
    String(ist.getUTCDate()).padStart(2,'0');
}

function yesterdayStr() {
  var ist = getISTNow();
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.getUTCFullYear() + '-' +
    String(ist.getUTCMonth() + 1).padStart(2,'0') + '-' +
    String(ist.getUTCDate()).padStart(2,'0');
}

function labelDate(dateStr) {
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return d.toLocaleDateString('en-IN', {
    weekday:'long', day:'numeric', month:'long', year:'numeric'
  });
}

function parseDateIST(dateStr) {
  if (!dateStr) return null;
  var parts = dateStr.split('-');
  return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
}

function daysLeft(dateStr) {
  if (!dateStr) return null;
  var istNow  = getISTNow();
  var nowDate = new Date(Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate()
  ));
  var target = parseDateIST(dateStr);
  if (!target) return null;
  return Math.round((target - nowDate) / 86400000);
}

function nextDueDate(lastDate, freq) {
  if (!lastDate || !freq) return null;
  var parts = lastDate.split('-');
  var d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  d.setUTCDate(d.getUTCDate() + parseInt(freq));
  return d.toISOString().split('T')[0];
}

function fmtDate(str) {
  if (!str) return '--';
  var parts = str.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}

// Reminder settings defaults
var RS_DEFAULTS = { fc:30, ins:60, tax:30, pucc:15, passport:90, health:60, task:10, kms:500 };
var rs = RS_DEFAULTS;
function getRS(key) { return rs[key] || RS_DEFAULTS[key]; }

// Last sent date
async function getLastSentDate() {
  try {
    var snap = await db.collection('users').doc(USER_UID).collection('data').doc('reminderMeta').get();
    if (snap.exists) return snap.data().lastSentDate || null;
    return null;
  } catch(e) { console.log('Could not read lastSentDate:', e.message); return null; }
}

async function saveLastSentDate(dateStr) {
  try {
    await db.collection('users').doc(USER_UID).collection('data').doc('reminderMeta')
      .set({ lastSentDate: dateStr, sentAt: new Date().toISOString() }, { merge: true });
    console.log('Saved lastSentDate:', dateStr);
  } catch(e) { console.log('Could not save lastSentDate:', e.message); }
}

// Section processors
function processTasks(data) {
  var tasks = data.tasks || [];
  if (!tasks.length) return null;
  var overdue = [], dueSoon = [], upcoming = [];
  tasks.forEach(function(t) {
    if (!t.lastDate || !t.freq) return;
    var next = nextDueDate(t.lastDate, t.freq);
    var d = daysLeft(next);
    if (d === null) return;
    if (d < 0) overdue.push({ name: t.name, d: d, next: next, remarks: t.remarks });
    else if (d <= getRS('task')) dueSoon.push({ name: t.name, d: d, next: next });
    else upcoming.push({ name: t.name, d: d });
  });
  [overdue, dueSoon, upcoming].forEach(function(a){ a.sort(function(x,y){ return x.d - y.d; }); });
  var hasAlerts = overdue.length > 0 || dueSoon.length > 0;
  var msg = '\n--- TASK REMINDERS ---\n';
  if (overdue.length) {
    msg += 'OVERDUE:\n';
    overdue.forEach(function(t) {
      msg += '  * ' + t.name + ' - ' + Math.abs(t.d) + ' days overdue\n';
      if (t.remarks) msg += '    Note: ' + t.remarks + '\n';
    });
  }
  if (dueSoon.length) {
    msg += 'DUE SOON:\n';
    dueSoon.forEach(function(t) {
      var label = t.d === 0 ? 'TODAY' : t.d === 1 ? 'Tomorrow' : 'in ' + t.d + ' days';
      msg += '  * ' + t.name + ' - ' + label + ' (' + fmtDate(t.next) + ')\n';
    });
  }
  if (!hasAlerts) msg += '  All tasks on track!\n';
  if (upcoming.length) {
    msg += 'Upcoming: ' + upcoming.slice(0,3).map(function(t){ return t.name + ' (' + t.d + 'd)'; }).join(', ') + '\n';
  }
  return { hasAlerts: hasAlerts, msg: msg };
}

function processDocs(data) {
  var docs = data.docs || [];
  var expiryTypes = ['Passport', 'Health Insurance'];
  var relevant = docs.filter(function(d){ return expiryTypes.indexOf(d.type) !== -1 && d.expiry; });
  if (!relevant.length) return null;
  var expired = [], expiring = [];
  relevant.forEach(function(doc) {
    var d = daysLeft(doc.expiry);
    if (d === null) return;
    var threshold = doc.type === 'Passport' ? getRS('passport') : getRS('health');
    if (d < 0) expired.push({ name: doc.name, type: doc.type, d: d });
    else if (d <= threshold) expiring.push({ name: doc.name, type: doc.type, d: d, expiry: doc.expiry });
  });
  if (!expired.length && !expiring.length) return null;
  var msg = '\n--- DOCUMENT EXPIRY ---\n';
  if (expired.length) {
    msg += 'EXPIRED:\n';
    expired.forEach(function(d){ msg += '  * ' + d.name + ' ' + d.type + ' - expired ' + Math.abs(d.d) + ' days ago!\n'; });
  }
  if (expiring.length) {
    msg += 'EXPIRING SOON:\n';
    expiring.forEach(function(d) {
      var label = d.d === 0 ? 'TODAY' : d.d === 1 ? 'Tomorrow' : 'in ' + d.d + ' days';
      msg += '  * ' + d.name + ' ' + d.type + ' - ' + label + ' (' + fmtDate(d.expiry) + ')\n';
    });
  }
  return { hasAlerts: true, msg: msg };
}

function processVehicles(data) {
  var vehicles = data.vehicles || [];
  if (!vehicles.length) return null;
  var vDocs = [
    { key:'fc', label:'FC' }, { key:'ins', label:'Insurance' },
    { key:'tax', label:'Road Tax' }, { key:'pucc', label:'PUCC' }
  ];
  var expired = [], expiring = [];
  vehicles.forEach(function(v) {
    vDocs.forEach(function(vd) {
      if (v[vd.key + '_none']) return;
      var expiry = v[vd.key + '_expiry'];
      if (!expiry) return;
      var d = daysLeft(expiry);
      var threshold = getRS(vd.key);
      if (d !== null) {
        var item = { vehicle: v.name, plate: v.plate || '', doc: vd.label, d: d, expiry: expiry };
        if (d < 0) expired.push(item);
        else if (d <= threshold) expiring.push(item);
      }
    });
  });
  if (!expired.length && !expiring.length) return null;
  var msg = '\n--- VEHICLE DOCUMENTS ---\n';
  if (expired.length) {
    msg += 'EXPIRED:\n';
    expired.forEach(function(a){ msg += '  * ' + a.vehicle + (a.plate ? ' (' + a.plate + ')' : '') + ' - ' + a.doc + ' expired ' + Math.abs(a.d) + ' days ago!\n'; });
  }
  if (expiring.length) {
    msg += 'EXPIRING SOON:\n';
    expiring.forEach(function(a) {
      var label = a.d === 0 ? 'TODAY' : a.d === 1 ? 'Tomorrow' : 'in ' + a.d + ' days';
      msg += '  * ' + a.vehicle + (a.plate ? ' (' + a.plate + ')' : '') + ' - ' + a.doc + ' ' + label + '\n';
    });
  }
  return { hasAlerts: true, msg: msg };
}

function processMaintenance(data) {
  var maintRecords = data.maintRecords || [];
  var vehicleKms   = data.vehicleKms   || {};
  if (!maintRecords.length) return null;
  var vehicleNames = [];
  maintRecords.forEach(function(r) {
    if (r.vehicleName && vehicleNames.indexOf(r.vehicleName) === -1) vehicleNames.push(r.vehicleName);
  });
  var overdue = [], soon = [];
  vehicleNames.forEach(function(vName) {
    var records = maintRecords.filter(function(r){ return r.vehicleName === vName && r.nextKms; }).sort(function(a,b){ return b.createdAt - a.createdAt; });
    if (!records.length) return;
    var curKms = vehicleKms[vName];
    if (curKms == null) return;
    var rem = records[0].nextKms - curKms;
    if (rem <= 0) overdue.push({ vName: vName, rem: rem, nextKms: records[0].nextKms, curKms: curKms });
    else if (rem < getRS('kms')) soon.push({ vName: vName, rem: rem, nextKms: records[0].nextKms, curKms: curKms });
  });
  if (!overdue.length && !soon.length) return null;
  var msg = '\n--- VEHICLE MAINTENANCE ---\n';
  if (overdue.length) {
    msg += 'SERVICE OVERDUE:\n';
    overdue.forEach(function(a){ msg += '  * ' + a.vName + ' - past due! Current: ' + a.curKms + ' Next: ' + a.nextKms + ' KMS\n'; });
  }
  if (soon.length) {
    msg += 'DUE SOON (less than ' + getRS('kms') + ' KMS):\n';
    soon.forEach(function(a){ msg += '  * ' + a.vName + ' - only ' + a.rem + ' KMS remaining!\n'; });
  }
  return { hasAlerts: true, msg: msg };
}

var PROCESSORS = [processTasks, processDocs, processVehicles, processMaintenance];

function buildMessage(data, dateStr, isMissed) {
  var results   = PROCESSORS.map(function(fn){ return fn(data); }).filter(Boolean);
  var hasAlerts = results.some(function(r){ return r.hasAlerts; });
  var msg = '';
  if (isMissed) {
    msg += 'MISSED YESTERDAY - Catching up!\n' + labelDate(dateStr) + ' (Yesterday)\n';
  } else {
    msg += 'PS Expense - Daily Report\n' + labelDate(dateStr) + '\n';
  }
  msg += '====================\n';
  if (!hasAlerts) msg += '\nALL CLEAR! Everything on track today.\n';
  results.forEach(function(r){ msg += r.msg; });
  msg += '\n====================\n';
  msg += isMissed ? 'Missed reminder catch-up' : 'Auto sent 4:00 AM - PS Expense';
  return msg;
}

async function main() {
  console.log('PS Expense WhatsApp Reminder starting...');
  if (!USER_UID) { console.error('FIREBASE_USER_UID not set!'); process.exit(1); }
  await loadWaConfig();
  if (!WA_TOKEN || !WA_PHONE_ID || !WA_TO_NUMBER) {
    console.error('WhatsApp details missing. Open the app > Menu > Reminder Settings > WhatsApp and save them.');
    process.exit(1);
  }

  var today     = todayStr();
  var yesterday = yesterdayStr();
  var lastSent  = await getLastSentDate();
  console.log('Today (IST):', today, '| Yesterday:', yesterday, '| Last sent:', lastSent || 'Never');

  var data = {};
  try {
    var snap = await db.collection('users').doc(USER_UID).collection('data').doc('appdata').get();
    if (!snap.exists) {
      await sendWhatsApp('PS Expense: No data found. Open the app first.');
      return;
    }
    data = snap.data();
    if (data.reminderSettings) rs = Object.assign({}, RS_DEFAULTS, data.reminderSettings);
    console.log('Data loaded. Tasks:', (data.tasks||[]).length, '| Settings:', JSON.stringify(rs));
  } catch(e) {
    console.error('Firebase error:', e.message);
    await sendWhatsApp('PS Expense: Could not read Firebase. Error: ' + e.message);
    process.exit(1);
  }

  var missedYesterday = lastSent && lastSent !== yesterday && lastSent !== today;

  try {
    if (missedYesterday) {
      console.log('Sending missed yesterday...');
      await sendWhatsApp(buildMessage(data, yesterday, true));
      await new Promise(function(r){ setTimeout(r, 3000); });
    }
    console.log('Sending today...');
    await sendWhatsApp(buildMessage(data, today, false));
    await saveLastSentDate(today);
    console.log('All done!');
  } catch(e) {
    console.error('Send failed:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

main();
