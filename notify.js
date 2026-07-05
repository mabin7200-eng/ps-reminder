// ═══════════════════════════════════════════════════════════
// PS Expense — Daily Telegram Reminder
// Runs every day at 4:00 AM IST
// If missed yesterday — catches up and sends both days
// ═══════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const fetch  = require('node-fetch');

// ── Firebase Init ────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    type:         'service_account',
    project_id:   process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// ── Config ───────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const USER_UID  = process.env.FIREBASE_USER_UID;

// ── Telegram Send ────────────────────────────────────────
async function sendTelegram(message) {
  const url = https://api.telegram.org/bot${TOKEN}/sendMessage;
  const res  = await fetch(url, {
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
  console.log('✅ Telegram sent');
  return true;
}

// ── Date Helpers ─────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
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
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-IN', {
    day:'numeric', month:'short', year:'numeric'
  });
}

// ── Check & Save Last Sent Date ──────────────────────────
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

async function saveLastSentDate(dateStr) {
  try {
    await db
      .collection('users').doc(USER_UID)
      .collection('data').doc('reminderMeta')
      .set({ lastSentDate: dateStr, sentAt: new Date().toISOString() }, { merge: true });
    console.log('✅ Saved lastSentDate:', dateStr);
  } catch(e) {
    console.log('Could not save lastSentDate:', e.message);
  }
}

// ── Section Processors ───────────────────────────────────

function processTasks(data) {
  const tasks = data.tasks || [];
  if (!tasks.length) return null;

  const overdue = [], dueSoon = [], upcoming = [];
  tasks.forEach(t => {
    if (!t.lastDate || !t.freq) return;
    const next = nextDueDate(t.lastDate, t.freq);
    const d    = daysLeft(next);
    if (d === null) return;
    if (d < 0)        overdue.push({...t, d, next});
    else if (d <= 10) dueSoon.push({...t, d, next});
    else              upcoming.push({...t, d, next});
  });

  [overdue, dueSoon, upcoming].forEach(a => a.sort((x,y) => x.d - y.d));
  const hasAlerts = overdue.length > 0 || dueSoon.length > 0;

  let msg = \n🔔 <b>TASK REMINDERS</b>\n;
  if (overdue.length) {
    msg += 🔴 <b>Overdue:</b>\n;
    overdue.forEach(t => {
      msg += `  • <b>${t.name}</b> — ${Math.abs(t.d)} day${Math.abs(t.d)!==1?'s':''} overdue\n`;
      if (t.remarks) msg += `    📝 ${t.remarks}\n`;
    });
  }
  if (dueSoon.length) {
    msg += 🟡 <b>Due Soon:</b>\n;
    dueSoon.forEach(t => {
      const label = t.d===0?'⚡ TODAY':t.d===1?'⚡ Tomorrow':in ${t.d} days;
      msg += `  • <b>${t.name}</b> — ${label} (${fmtDate(t.next)})\n`;
    });
  }
  if (!hasAlerts) msg += `  ✅ All tasks on track!\n`;
  if (upcoming.length) {
    msg += 📅 <i>Upcoming: ${upcoming.slice(0,3).map(t=>${t.name} (${t.d}d)).join(', ')}</i>\n;
  }
  return { hasAlerts, msg };
}

function processDocs(data) {
  const docs        = data.docs || [];
  const expiryTypes = ['Passport','Health Insurance'];
  const relevant    = docs.filter(d => expiryTypes.includes(d.type) && d.expiry);
  if (!relevant.length) return null;

  const expired = [], expiring = [];
  relevant.forEach(doc => {
    const d = daysLeft(doc.expiry);
    if (d === null) return;
    if (d < 0)        expired.push({...doc, d});
    else if (d <= 30) expiring.push({...doc, d});
  });
  [expired, expiring].forEach(a => a.sort((x,y)=>x.d-y.d));
  if (!expired.length && !expiring.length) return null;

  let msg = \n🗂️ <b>DOCUMENT EXPIRY</b>\n;
  if (expired.length) {
    msg += 🔴 <b>Expired:</b>\n;
    expired.forEach(d => {
      msg += `  • <b>${d.name}'s ${d.type}</b> — expired ${Math.abs(d.d)} days ago!\n`;
    });
  }
  if (expiring.length) {
    msg += 🟡 <b>Expiring:</b>\n;
    expiring.forEach(d => {
      const label = d.d===0?'TODAY':d.d===1?'Tomorrow':in ${d.d} days;
      msg += `  • <b>${d.name}'s ${d.type}</b> — ${label} (${fmtDate(d.expiry)})\n`;
    });
  }
  return { hasAlerts: true, msg };
}

function processVehicles(data) {
  const vehicles = data.vehicles || [];
  if (!vehicles.length) return null;

  const vDocs = [
    { key:'fc',   label:'FC',        icon:'🔧' },
    { key:'ins',  label:'Insurance', icon:'🛡️' },
    { key:'tax',  label:'Road Tax',  icon:'🏛️' },
    { key:'pucc', label:'PUCC',      icon:'🌿' },
  ];

  const expired = [], expiring = [];
  vehicles.forEach(v => {
    vDocs.forEach(vd => {
      if (v[vd.key+'_none']) return;
      const expiry = v[vd.key+'_expiry'];
      if (!expiry) return;
      const d = daysLeft(expiry);
      if (d !== null) {
        const item = { vehicle:v.name, plate:v.plate||'', doc:vd.label, icon:vd.icon, d, expiry };
        if (d < 0)        expired.push(item);
        else if (d <= 30) expiring.push(item);
      }
    });
  });
  [expired, expiring].forEach(a => a.sort((x,y)=>x.d-y.d));
  if (!expired.length && !expiring.length) return null;

  let msg = \n🚗 <b>VEHICLE DOCUMENTS</b>\n;
  if (expired.length) {
    msg += 🔴 <b>Expired:</b>\n;
    expired.forEach(a => {
      msg += `  • <b>${a.vehicle}</b>${a.plate?` (${a.plate}):''} — ${a.icon} ${a.doc} expired ${Math.abs(a.d)} days ago!\n;
    });
  }
  if (expiring.length) {
    msg += 🟡 <b>Expiring:</b>\n;
    expiring.forEach(a => {
      const label = a.d===0?'TODAY':a.d===1?'Tomorrow':in ${a.d} days;
      msg += `  • <b>${a.vehicle}</b>${a.plate?` (${a.plate}):''} — ${a.icon} ${a.doc} ${label}\n;
    });
  }
  return { hasAlerts: true, msg };
}

function processMaintenance(data) {
  const maintRecords = data.maintRecords || [];
  const vehicleKms   = data.vehicleKms   || {};
  if (!maintRecords.length) return null;

  const vehicleNames = [...new Set(maintRecords.map(r=>r.vehicleName).filter(Boolean))];
  const overdue = [], soon = [];

  vehicleNames.forEach(vName => {
    const latest = [...maintRecords]
      .filter(r => r.vehicleName===vName && r.nextKms)
      .sort((a,b) => b.createdAt - a.createdAt)[0];
    if (!latest) return;
    const curKms = vehicleKms[vName];
    if (curKms == null) return;
    const rem = latest.nextKms - curKms;
    if (rem <= 0)       overdue.push({ vName, rem, nextKms:latest.nextKms, curKms });
    else if (rem < 500) soon.push({ vName, rem, nextKms:latest.nextKms, curKms });
  });

  if (!overdue.length && !soon.length) return null;

  let msg = \n🔧 <b>VEHICLE MAINTENANCE</b>\n;
  if (overdue.length) {
    msg += 🔴 <b>Service Overdue:</b>\n;
    overdue.forEach(a => {
      msg += `  • <b>${a.vName}</b> — past due! (Current: ${a.curKms.toLocaleString()} | Next: ${a.nextKms.toLocaleString()} KMS)\n`;
    });
  }
  if (soon.length) {
    msg += 🟡 <b>Due Soon (&lt;500 KMS):</b>\n;
    soon.forEach(a => {
      msg += `  • <b>${a.vName}</b> — only ${a.rem.toLocaleString()} KMS left!\n`;
    });
  }
  return { hasAlerts: true, msg };
}

const PROCESSORS = [processTasks, processDocs, processVehicles, processMaintenance];

// ── Build Message for a Date ─────────────────────────────
async function buildMessage(data, dateStr, isMissed = false) {
  const results   = PROCESSORS.map(fn => fn(data)).filter(Boolean);
  const hasAlerts = results.some(r => r.hasAlerts);

  let msg = '';
  if (isMissed) {
    msg += ⚠️ <b>MISSED YESTERDAY — Catching up!</b>\n;
    msg += 📅 <i>${labelDate(dateStr)} (Yesterday)</i>\n;
  } else {
    msg += 🔔 <b>PS Expense — Daily Report</b>\n;
    msg += 📅 <i>${labelDate(dateStr)}</i>\n;
  }
  msg += ━━━━━━━━━━━━━━━━━━━━\n;

  if (!hasAlerts) {
    msg += \n✅ <b>ALL CLEAR!</b> Everything is on track today. 👍\n;
  }
  results.forEach(r => { msg += r.msg; });

  msg += \n━━━━━━━━━━━━━━━━━━━━\n;
  msg += isMissed
    ? <i>📬 Missed reminder catch-up — PS Expense App</i>
    : <i>⏰ Auto sent 4:00 AM — PS Expense App</i>;
  return msg;
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('🔔 PS Expense Telegram Reminder starting...');

  if (!USER_UID) {
    console.error('❌ FIREBASE_USER_UID not set in secrets!');
    process.exit(1);
  }

  const today     = todayStr();
  const yesterday = yesterdayStr();

  // ── Read last sent date ──
  const lastSent = await getLastSentDate();
  console.log('Last sent date:', lastSent || 'Never');
  console.log('Today:', today, '| Yesterday:', yesterday);

  // ── Load Firebase data ──
  let data = {};
  try {
    const snap = await db
      .collection('users').doc(USER_UID)
      .collection('data').doc('appdata')
      .get();
    if (!snap.exists) {
      await sendTelegram('🔔 <b>PS Expense</b>\n\nNo data found. Open the app and add your data first.');
      return;
    }
    data = snap.data();
    console.log('✅ Data loaded | Tasks:', (data.tasks||[]).length, '| Vehicles:', (data.vehicles||[]).length);
  } catch(e) {
    console.error('❌ Firebase error:', e.message);
    await sendTelegram(🔔 <b>PS Expense</b>\n\n❌ Could not read data.\nError: ${e.message});
    process.exit(1);
  }

  // ── Check if yesterday was missed ──
  const missedYesterday = lastSent && lastSent !== yesterday && lastSent !== today;

  try {
    // Send missed day first (if applicable)
    if (missedYesterday) {
      console.log('📬 Sending missed yesterday message...');
      const missedMsg = await buildMessage(data, yesterday, true);
      await sendTelegram(missedMsg);
      // Small delay between messages
      await new Promise(r => setTimeout(r, 2000));
    }

    // Send today's message
    console.log('📤 Sending today message...');
    const todayMsg = await buildMessage(data, today, false);
    await sendTelegram(todayMsg);

    // Save today as last sent
    await saveLastSentDate(today);
    console.log('✅ All done!');

  } catch(e) {
    console.error('❌ Send failed:', e.message);
    process.exit(1);
  }

  process.exit(0);
}

main();
