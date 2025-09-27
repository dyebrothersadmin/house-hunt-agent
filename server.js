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
  console.warn('Twilio vars missing (ok during initial deploy)');
}

// --- DB ---
const pool = new Pool({ connectionString: DATABASE_URL });

// --- Twilio ---
const sms = twilio(TWILIO_SID, TWILIO_TOKEN);

// --- Helpers ---
const nowPlus = mins => new Date(Date.now() + mins * 60 * 1000);
async function upsertBuyerByPhone(phone) {
  const q = `
    insert into buyer (phone, phone_verified)
    values ($1, false)
    on conflict (phone) do update set phone=excluded.phone
    returning *`;
  const { rows } = await pool.query(q, [phone]);
  return rows[0];
}

// --- Healthcheck ---
app.get('/', (req, res) => res.send('Agent API OK'));
app.get('/health', (req, res) => res.json({ ok: true }));

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

    if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM) {
      await sms.messages.create({
        from: TWILIO_FROM,
        to: phone,
        body: `Dye Brothers Group code: ${code}. Reply STOP to opt out.`
      });
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

// --- Simple cron (no-op for now; placeholder for future matches) ---
cron.schedule('*/10 * * * *', async () => {
  // Later: check new listings and send SMS alerts
  // console.log('cron tick');
});

app.listen(PORT, () => console.log(`Agent API running on :${PORT}`));
