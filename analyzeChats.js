require('dotenv').config();
const { MongoClient } = require('mongodb');
const mysql = require('mysql2/promise');

// ======================
// NORMALIZE PHONE
// ======================
function normalizePhone(phone) {
  if (!phone) return null;

  // ambil angka saja
  let p = phone.replace(/\D/g, '');

  if (p.startsWith('0')) {
    p = '62' + p.slice(1);
  }

  if (!p.startsWith('62')) {
    p = '62' + p;
  }

  return p;
}

// ======================
// LOAD INTERNAL PHONES
// ======================
async function loadInternalPhones() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASS,
    database: process.env.MYSQL_DB
  });

  const [rows] = await conn.execute(`
    SELECT phone 
    FROM user_admin
    WHERE status = 1
      AND phone IS NOT NULL
  `);

  await conn.end();

  const set = new Set();

  rows.forEach(r => {
    const norm = normalizePhone(r.phone);
    if (norm) set.add(norm);
  });

  return set;
}

// ======================
// MAIN
// ======================
async function run() {
  const internalPhones = await loadInternalPhones();
  console.log('Internal Phones Loaded:', internalPhones.size);

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();

  const db = mongo.db(process.env.MONGO_DB);
  const collection = db.collection('messages');

  const cursor = collection.find({
    chat_id: '120363340694520056@g.us',
    is_forwarded: false
  });

  while (await cursor.hasNext()) {
    const doc = await cursor.next();

    let author = doc.author || '';
    author = author.split('@')[0];
    author = normalizePhone(author);

    if (!author) continue;

    // SKIP INTERNAL
    if (internalPhones.has(author)) {
      continue;
    }

    // CUSTOMER CHAT
    const body = doc.body || '';

    console.log('CUSTOMER CHAT:', body);

    // NANTI DI SINI:
    // extractPlate(body)
    // detectIntent(body)
  }

  await mongo.close();
}

run();
