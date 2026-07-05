// PS Expense - Daily Telegram Reminder
// Runs every day at 4:00 AM IST
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

// Config
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const USER_UID  = process.env.FIREBASE_USER_UID;

// Send Telegram message
async function sendTelegram(message) {
  const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage';
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    CHAT_ID,
      text:       message,
      parse_mode: 'HTML',
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram error: ' + JSON.stringify(data));
  console.log('Telegram sent OK');
  return true;
}

// Date helpers
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function labelDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    weekday:'long', day:'numeric', month:'long', year:'numeric'
  });
}

function daysLeft(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now    = new Date();
  target.setHours(0,0,0,0);
  now.setHours(0,0,0,0);
  return Math.round((target - now) / 86400000);
}

function nextDueDate(lastDate, freq) {
  if (!lastDate || !freq) return null;
  const d = new Date(lastDate);
  d.setDate(d.getDate() + parseInt(freq));
  return d.toISOString().split('T')[0];
}

function fmtDate(str) {
  if (!str) return '--';
  return new Date(str).toLocaleDateString('en-IN', {
    day:'numeric', month:'short', year:'numeric'
  });
}

// Read last sent date from Firebase
async function getLastSentDate() {
  try {
    const snap = await db
      .collection('users').doc(USER_UID)
      .collection('data').doc('reminderMeta')
      .get();
    if (snap.exists) return snap.data().lastSentDate || null;
    return null;
  } catch(e) {
    console.log('Could not read lastSentDate:', e.message);
    return null;
  }
}

// Save last sent date to Firebase
async function saveLastSentDate(dateStr) {
  try {
    await db
      .collection('users').doc(USER_UID)
      .collection('data').doc('reminderMeta')
      .set({ lastSentDate: dateStr, sentAt: new Date().toISOString() }, { merge: true });
    console.log('Saved lastSentDate:', dateStr);
  } catch(e) {
    console.log('Could not save lastSentDate:', e.message);
  }
}

// Process tasks
function processTasks(data) {
  const tasks = data.tasks || [];
  if (!tasks.length) return null;

  const overdue = [];
  const dueSoon = [];
  const upcoming = [];

  tasks.forEach(function(t) {
    if (!t.lastDate || !t.freq) return;
    var next = nextDueDate(t.lastDate, t.freq);
    var d = daysLeft(next);
    if (d === null) return;
    if (d < 0) overdue.push({ name: t.name, d: d, next: next, remarks: t.remarks });
    else if (d <= 10) dueSoon.push({ name: t.name, d: d, next: next, remarks: t.remarks });
    else upcoming.push({ name: t.name, d: d, next: next });
  });

  overdue.sort(function(a,b){ return a.d - b.d; });
  dueSoon.sort(function(a,b){ return a.d - b.d; });

  var hasAlerts = overdue.length > 0 || dueSoon.length > 0;
  var msg = '\n<b>TASK REMINDERS</b>\n';

  if (overdue.length) {
    msg += 'OVERDUE:\n';
    overdue.forEach(function(t) {
      msg += '  - <b>' + t.name + '</b> -- ' + Math.abs(t.d) + ' days overdue\n';
      if (t.remarks) msg += '    Note: ' + t.remarks + '\n';
    });
  }
  if (dueSoon.length) {
    msg += 'DUE SOON:\n';
    dueSoon.forEach(function(t) {
      var label = t.d === 0 ? 'TODAY' : t.d === 1 ? 'Tomorrow' : 'in ' + t.d + ' days';
      msg += '  - <b>' + t.name + '</b> -- ' + label + ' (' + fmtDate(t.next) + ')\n';
    });
  }
  if (!hasAlerts) {
    msg += '  All tasks on track!\n';
  }
  if (upcoming.length) {
    var upNames = upcoming.slice(0,3).map(function(t){ return t.name + ' (' + t.d + 'd)'; }).join(', ');
    msg += 'Upcoming: ' + upNames + '\n';
  }
  return { hasAlerts: hasAlerts, msg: msg };
}

// Process documents
function processDocs(data) {
  var docs = data.docs || [];
  var expiryTypes = ['Passport', 'Health Insurance'];
  var relevant = docs.filter(function(d) {
    return expiryTypes.indexOf(d.type) !== -1 && d.expiry;
  });
  if (!relevant.length) return null;

  var expired = [];
  var expiring = [];

  relevant.forEach(function(doc) {
    var d = daysLeft(doc.expiry);
    if (d === null) return;
    if (d < 0) expired.push({ name: doc.name, type: doc.type, d: d, expiry: doc.expiry });
    else if (d <= 30) expiring.push({ name: doc.name, type: doc.type, d: d, expiry: doc.expiry });
  });

  if (!expired.length && !expiring.length) return null;

  var msg = '\n<b>DOCUMENT EXPIRY</b>\n';
  if (expired.length) {
    msg += 'EXPIRED:\n';
    expired.forEach(function(d) {
      msg += '  - <b>' + d.name + ' ' + d.type + '</b> -- expired ' + Math.abs(d.d) + ' days ago!\n';
    });
  }
  if (expiring.length) {
    msg += 'EXPIRING SOON:\n';
    expiring.forEach(function(d) {
      var label = d.d === 0 ? 'TODAY' : d.d === 1 ? 'Tomorrow' : 'in ' + d.d + ' days';
      msg += '  - <b>' + d.name + ' ' + d.type + '</b> -- ' + label + ' (' + fmtDate(d.expiry) + ')\n';
    });
  }
  return { hasAlerts: true, msg: msg };
}

// Process vehicles
function processVehicles(data) {
  var vehicles = data.vehicles || [];
  if (!vehicles.length) return null;

  var vDocs = [
    { key: 'fc',   label: 'FC',        icon: 'FC' },
    { key: 'ins',  label: 'Insurance', icon: 'INS' },
    { key: 'tax',  label: 'Road Tax',  icon: 'TAX' },
    { key: 'pucc', label: 'PUCC',      icon: 'PUCC' },
  ];

  var expired = [];
  var expiring = [];

  vehicles.forEach(function(v) {
    vDocs.forEach(function(vd) {
      if (v[vd.key + '_none']) return;
      var expiry = v[vd.key + '_expiry'];
      if (!expiry) return;
      var d = daysLeft(expiry);
      if (d !== null) {
        var item = { vehicle: v.name, plate: v.plate || '', doc: vd.label, d: d, expiry: expiry };
        if (d < 0) expired.push(item);
        else if (d <= 30) expiring.push(item);
      }
    });
  });

  if (!expired.length && !expiring.length) return null;

  var msg = '\n<b>VEHICLE DOCUMENTS</b>\n';
  if (expired.length) {
    msg += 'EXPIRED:\n';
    expired.forEach(function(a) {
      msg += '  - <b>' + a.vehicle + '</b> -- ' + a.doc + ' expired ' + Math.abs(a.d) + ' days ago!\n';
    });
  }
  if (expiring.length) {
    msg += 'EXPIRING SOON:\n';
    expiring.forEach(function(a) {
      var label = a.d === 0 ? 'TODAY' : a.d === 1 ? 'Tomorrow' : 'in ' + a.d + ' days';
      msg += '  - <b>' + a.vehicle + '</b> -- ' + a.doc + ' ' + label + '\n';
    });
  }
  return { hasAlerts: true, msg: msg };
}

// Process maintenance KMS
function processMaintenance(data) {
  var maintRecords = data.maintRecords || [];
  var vehicleKms   = data.vehicleKms   || {};
  if (!maintRecords.length) return null;

  var vehicleNames = [];
  maintRecords.forEach(function(r) {
    if (r.vehicleName && vehicleNames.indexOf(r.vehicleName) === -1) {
      vehicleNames.push(r.vehicleName);
    }
  });

  var overdue = [];
  var soon = [];

  vehicleNames.forEach(function(vName) {
    var records = maintRecords
      .filter(function(r) { return r.vehicleName === vName && r.nextKms; })
      .sort(function(a,b) { return b.createdAt - a.createdAt; });
    if (!records.length) return;
    var latest = records[0];
    var curKms = vehicleKms[vName];
    if (curKms == null) return;
    var rem = latest.nextKms - curKms;
    if (rem <= 0) overdue.push({ vName: vName, rem: rem, nextKms: latest.nextKms, curKms: curKms });
    else if (rem < 500) soon.push({ vName: vName, rem: rem, nextKms: latest.nextKms, curKms: curKms });
  });

  if (!overdue.length && !soon.length) return null;

  var msg = '\n<b>VEHICLE MAINTENANCE</b>\n';
  if (overdue.length) {
    msg += 'SERVICE OVERDUE:\n';
    overdue.forEach(function(a) {
      msg += '  - <b>' + a.vName + '</b> -- past due! Current: ' + a.curKms + ' Next: ' + a.nextKms + ' KMS\n';
    });
  }
  if (soon.length) {
    msg += 'DUE SOON (less than 500 KMS):\n';
    soon.forEach(function(a) {
      msg += '  - <b>' + a.vName + '</b> -- only ' + a.rem + ' KMS remaining!\n';
    });
  }
  return { hasAlerts: true, msg: msg };
}

// Build full message
function buildMessage(data, dateStr, isMissed) {
  var processors = [processTasks, processDocs, processVehicles, processMaintenance];
  var results = processors.map(function(fn) { return fn(data); }).filter(Boolean);
  var hasAlerts = results.some(function(r) { return r.hasAlerts; });

  var msg = '';
  if (isMissed) {
    msg += 'MISSED YESTERDAY - Catching up!\n';
    msg += labelDate(dateStr) + ' (Yesterday)\n';
  } else {
    msg += '<b>PS Expense - Daily Report</b>\n';
    msg += labelDate(dateStr) + '\n';
  }
  msg += '--------------------\n';

  if (!hasAlerts) {
    msg += '\nALL CLEAR! Everything is on track today.\n';
  }

  results.forEach(function(r) { msg += r.msg; });

  msg += '\n--------------------\n';
  if (isMissed) {
    msg += 'Missed reminder catch-up - PS Expense App';
  } else {
    msg += 'PS App';
  }
  return msg;
}

// Main
async function main() {
  console.log('PS Expense Telegram Reminder starting...');

  if (!USER_UID) {
    console.error('FIREBASE_USER_UID not set!');
    process.exit(1);
  }

  var today     = todayStr();
  var yesterday = yesterdayStr();

  var lastSent = await getLastSentDate();
  console.log('Last sent:', lastSent || 'Never');
  console.log('Today:', today);

  // Load data from Firebase
  var data = {};
  try {
    var snap = await db
      .collection('users').doc(USER_UID)
      .collection('data').doc('appdata')
      .get();
    if (!snap.exists) {
      await sendTelegram('<b>PS Expense</b>\n\nNo data found. Open the app first.');
      return;
    }
    data = snap.data();
    console.log('Data loaded. Tasks:', (data.tasks || []).length, 'Vehicles:', (data.vehicles || []).length);
  } catch(e) {
    console.error('Firebase error:', e.message);
    await sendTelegram('<b>PS Expense</b>\n\nCould not read Firebase data.\nError: ' + e.message);
    process.exit(1);
  }

  // Check if yesterday was missed
  var missedYesterday = lastSent && lastSent !== yesterday && lastSent !== today;

  try {
    // Send missed day first if needed
    if (missedYesterday) {
      console.log('Sending missed yesterday message...');
      var missedMsg = buildMessage(data, yesterday, true);
      await sendTelegram(missedMsg);
      await new Promise(function(r) { setTimeout(r, 2000); });
    }

    // Send today message
    console.log('Sending today message...');
    var todayMsg = buildMessage(data, today, false);
    await sendTelegram(todayMsg);

    // Save today as last sent
    await saveLastSentDate(today);
    console.log('All done!');

  } catch(e) {
    console.error('Send failed:', e.message);
    process.exit(1);
  }

  process.exit(0);
}

main();
