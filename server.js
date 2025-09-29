// server.js
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const twilio = require('twilio');
const cron = require('node-cron');
const { z } = require('zod');

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --- ENV ---
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

if (!DATABASE_URL) console.warn('DATABASE_URL not set');
if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
  console.warn('Twilio vars missing or incomplete (ok during initial deploy)');
}

// --- DB ---
const pool = new Pool({ connectionString: DATABASE_URL });

// --- Twilio (guarded init) ---
let sms = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  try {
    sms = twilio(TWILIO_SID, TWILIO_TOKEN);
  } catch (e) {
    console.warn('Failed to init Twilio client:', e.message);
  }
}
// --- Inline widget loader (serves Max as /widget.js) ---
app.get('/widget.js', (_req, res) => {
  res.type('application/javascript').send(`(function(){
    var API = 'https://house-hunt-agent.onrender.com';

    // --- State ---
    var buyerId = localStorage.getItem('dbg_buyerId');
    var pendingPhone = localStorage.getItem('dbg_pendingPhone');
    var minimized = localStorage.getItem('dbg_min') === '1';

    // --- Container & UI ---
    var wrap = document.createElement('div');
    wrap.id = 'dbg-agent';
    wrap.style.cssText = 'position:fixed;right:20px;bottom:20px;width:320px;height:480px;border:1px solid #ddd;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.12);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;z-index:9999';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #eee;background:#fafafa';
    header.innerHTML = '<div style="font-weight:700">Max — Your House-Hunt Agent</div>\
    <div>\
      <button id="dbg-min" title="Minimize" style="cursor:pointer;border:0;background:transparent;font-size:16px;line-height:1">—</button>\
    </div>';

    var log = document.createElement('div');
    log.id = 'dbg-log';
    log.style.cssText = 'height:350px;overflow:auto;padding:12px';

    var typing = document.createElement('div');
    typing.id = 'dbg-typing';
    typing.style.cssText = 'font-size:12px;color:#666;padding:0 12px 8px;display:none';
    typing.textContent = 'Max is typing…';

    var inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;border-top:1px solid #eee';
    inputRow.innerHTML = '<input id="dbg-input" placeholder="Type here..." style="flex:1;border:0;padding:10px;outline:none" />\
      <button id="dbg-send" style="border:0;padding:10px 12px;cursor:pointer;background:#111;color:#fff">Send</button>';

    wrap.appendChild(header);
    wrap.appendChild(log);
    wrap.appendChild(typing);
    wrap.appendChild(inputRow);
    document.body.appendChild(wrap);

    // Minimized pill
    var pill = document.createElement('div');
    pill.id = 'dbg-pill';
    pill.textContent = 'Chat with Max';
    pill.style.cssText = 'position:fixed;right:20px;bottom:20px;background:#111;color:#fff;border-radius:999px;padding:10px 14px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.15);z-index:9998;display:none';
    document.body.appendChild(pill);

    function setMinimized(on){
      minimized = !!on;
      localStorage.setItem('dbg_min', on ? '1' : '0');
      wrap.style.display = on ? 'none' : 'block';
      pill.style.display = on ? 'block' : 'none';
    }
    setMinimized(minimized);

    // Elements
    var $input = document.getElementById('dbg-input');
    var $send = document.getElementById('dbg-send');
    var $min = document.getElementById('dbg-min');

    // --- Helpers ---
    function say(who, text){
      var block = document.createElement('div');
      block.style.margin = '8px 0';
      block.innerHTML = '<div style="font-weight:600;margin-bottom:2px">'+who+'</div><div>'+text+'</div>';
      log.appendChild(block);
      log.scrollTop = log.scrollHeight;
    }

    function showTyping(on){
      typing.style.display = on ? 'block' : 'none';
      if (on) log.scrollTop = log.scrollHeight;
    }

    function pause(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

    function post(path, body){
      return fetch(API + path, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      }).then(function(r){ return r.json(); });
    }

    // Normalize phone: assume US +1 for 10-digit; accept 11-digit starting with 1; keep explicit + as-is
    function normalizePhone(input){
      var digits = (input||'').replace(/\\D/g,'');
      if (!digits) return input;
      if (digits.length === 10) return '+1' + digits;
      if (digits.length === 11 && digits[0] === '1') return '+' + digits;
      if (input.trim().charAt(0) !== '+') return '+' + digits;
      return input;
    }

    function smartFollowupText(serverReply){
      // Make replies warmer and more guided while keeping server’s next question
      var leadIn = [
        "Thanks for that 👍 ",
        "Great, appreciate the detail. ",
        "Got it — that helps a lot. ",
        "Perfect, we\\'re zeroing in. "
      ];
      var pick = leadIn[Math.floor(Math.random()*leadIn.length)];
      return pick + serverReply;
    }

    async function sendOTP(rawPhone){
      var phone = normalizePhone(rawPhone);
      try{
        await post('/auth/send-otp', { phone: phone });
        localStorage.setItem('dbg_pendingPhone', phone);
        showTyping(true); await pause(600);
        showTyping(false);
        say('Max', 'I just texted a 6-digit code. Please enter it here to confirm it\\'s you. <div style="font-size:12px;color:#666;margin-top:4px">Tip: On a Twilio trial, texts only deliver to numbers verified in your Twilio console.</div>');
      }catch(e){
        say('Max', 'Hmm, that didn\\'t go through. Could you try your number again (e.g., 3185551234)?');
      }
    }

    async function verifyOTP(code){
      var phone = localStorage.getItem('dbg_pendingPhone');
      try{
        var j = await post('/auth/check-otp', { phone: phone, code: code });
        if (j.ok){
          buyerId = j.buyerId;
          localStorage.setItem('dbg_buyerId', buyerId);
          showTyping(true); await pause(700);
          showTyping(false);
          say('Max', "Thanks — you\\'re verified. I\\'ll remember your preferences next time.");
          showTyping(true); await pause(800);
          showTyping(false);
          say('Max', "To dial this in fast: <br>• What\\'s your comfortable **budget range**? <br>• **Beds/Baths** minimum? <br>• Any **must-haves** (office, pool, garage)? <br>• Preferred **area or school zone** (e.g., Sterlington)?");
        }else{
          say('Max', 'That code didn\\'t work. Please enter the 6-digit code again.');
        }
      }catch(e){
        say('Max', 'Something went wrong — please try the code again.');
      }
    }

    async function sendMessage(text){
      try{
        showTyping(true);
        var j = await post('/agent/message', { buyerId: buyerId, message: text });
        await pause(700);
        showTyping(false);
        if (j && j.reply) {
          say('Max', smartFollowupText(j.reply));
        } else {
          say('Max', "Thanks! Anything else that\\'s important to you — commute time, lot size, HOA tolerance, or new vs. needs-work?");
        }
      }catch(e){
        showTyping(false);
        say('Max', 'I couldn\\'t process that — mind trying again?');
      }
    }

    async function handleSend(){
      var text = ($input.value || '').trim();
      if (!text) return;
      say('You', text);

      if (!buyerId){
        var pending = localStorage.getItem('dbg_pendingPhone');
        if (!pending) {
          await sendOTP(text);
        } else {
          await verifyOTP(text);
        }
      } else {
        await sendMessage(text);
      }
      $input.value = '';
    }

    // Events
    $send.onclick = handleSend;
    $input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); handleSend(); }
    });
    $min.onclick = function(){ setMinimized(true); };
    pill.onclick = function(){ setMinimized(false); };

    // Opening greeting
    (async function greet(){
      if (!buyerId){
        showTyping(true); await pause(500);
        showTyping(false);
        say('Max', "Hi! I\\'m Max — I **hunt houses so you don\\'t have to**. I\\'ll learn your must-haves (budget, beds/baths, area, commute), keep your profile on file, and **text you** the moment something new hits that fits.");
        showTyping(true); await pause(900);
        showTyping(false);
        say('Max', "What\\'s your phone number so I can verify and remember you? You can just type 10 digits — I\\'ll add +1 for you.");
      }else{
        showTyping(true); await pause(400);
        showTyping(false);
        say('Max', 'Welcome back! Want to adjust **budget**, **beds/baths**, **area/school**, or add any **must-haves**?');
      }
    })();
  })();`);
});


// --- Healthcheck ---
app.get('/', (_req, res) => res.send('Agent API OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- OTP: send ---
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await upsertBuyerByPhone(phone);

    await pool.query(
      `insert into otp_code (phone, code, expires_at) values ($1,$2,$3)`,
      [phone, code, nowPlus(10)]
    );

    if (sms && TWILIO_FROM) {
      await sms.messages.create({
        from: TWILIO_FROM,
        to: phone,
        body: `Dye Brothers Group code: ${code}. Reply STOP to opt out.`
      });
    } else {
      console.log(`[DEV] OTP for ${phone}: ${code}`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('send-otp error', e);
    res.status(500).json({ error: 'failed to send otp' });
  }
});

// --- OTP: verify ---
app.post('/auth/check-otp', async (req, res) => {
  try {
    const { phone, code } = req.body || {};
    if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });

    const { rows } = await pool.query(
      `select * from otp_code
       where phone=$1 and code=$2 and used=false and expires_at>now()
       order by expires_at desc limit 1`,
      [phone, code]
    );
    if (!rows.length) return res.status(400).json({ error: 'invalid or expired code' });

    await pool.query(`update otp_code set used=true where id=$1`, [rows[0].id]);

    const buyer = await upsertBuyerByPhone(phone);
    await pool.query(`update buyer set phone_verified=true where id=$1`, [buyer.id]);

    res.json({ ok: true, buyerId: buyer.id });
  } catch (e) {
    console.error('check-otp error', e);
    res.status(500).json({ error: 'failed to verify' });
  }
});

// --- Very simple criteria extractor (MVP) ---
const CriteriaSchema = z.object({
  price_min: z.number().int().optional(),
  price_max: z.number().int().optional(),
  beds_min: z.number().optional(),
  baths_min: z.number().optional(),
  zones: z.array(z.string()).optional(),
  must_haves: z.array(z.string()).optional(),
  avoid: z.array(z.string()).optional()
});

function naiveExtractCriteria(text) {
  const out = {};
  const mPrice = text.match(/\$?(\d{3,})\s*-\s*\$?(\d{3,})/);
  if (mPrice) { out.price_min = +mPrice[1]; out.price_max = +mPrice[2]; }
  const mBeds = text.match(/(\d+)\s*(bed|beds|br)/i);
  if (mBeds) out.beds_min = +mBeds[1];
  const mBaths = text.match(/(\d+)\s*(bath|baths|ba)/i);
  if (mBaths) out.baths_min = +mBaths[1];
  const school = text.match(/(Sterlington|West Monroe|Monroe)/i);
  if (school) out.zones = [school[1]];
  return out;
}

// --- Chat message endpoint (stores/updates saved search) ---
app.post('/agent/message', async (req, res) => {
  try {
    const { buyerId, message } = req.body || {};
    if (!buyerId || !message) return res.status(400).json({ error: 'buyerId and message required' });

    const extracted = naiveExtractCriteria(message);
    // Optional validation (won’t throw unless dev wants strict mode)
    try { CriteriaSchema.parse(extracted); } catch {}

    let saved = null;

    if (Object.keys(extracted).length) {
      const { rows } = await pool.query(
        `select * from saved_search where buyer_id=$1 order by created_at asc limit 1`, [buyerId]
      );
      if (rows.length) {
        const merged = { ...rows[0].criteria, ...extracted };
        await pool.query(`update saved_search set criteria=$1 where id=$2`, [merged, rows[0].id]);
        saved = { id: rows[0].id, criteria: merged };
      } else {
        const ins = await pool.query(
          `insert into saved_search (buyer_id, criteria) values ($1,$2) returning *`,
          [buyerId, extracted]
        );
        saved = { id: ins.rows[0].id, criteria: ins.rows[0].criteria };
      }
    }

    const nextQ = !extracted.price_max
      ? 'What price range are you comfortable with? (e.g., $250000 - $450000)'
      : !extracted.beds_min
      ? 'How many bedrooms minimum?'
      : 'Any must-haves (pool, office, garage) or dealbreakers?';

    res.json({ reply: nextQ, savedSearch: saved });
  } catch (e) {
    console.error('agent/message error', e);
    res.status(500).json({ error: 'agent error' });
  }
});

// --- Placeholder cron (for future listing alerts) ---
cron.schedule('*/10 * * * *', async () => {
  // Later: check new listings in `listing` and SMS via Twilio
  // console.log('cron tick');
});

app.listen(PORT, () => console.log(`Agent API running on :${PORT}`));
