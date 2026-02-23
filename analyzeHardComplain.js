require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { STOPWORDS, BLOCKLIST_TOKENS, BLOCKLIST_PHRASES } = require('./filters');

const DEFAULT_COMPLAIN_SEEDS = [
    'kecewa',
    'tidak puas',
    'gak puas',
    'tidak sesuai',
    'tidak pickup',
    'belum pickup',
    'driver tidak datang',
    'unit tidak datang',
    'over sla',
    'lewat sla',
    'terlambat',
    'delay',
    'sudah berapa kali',
    'kapan selesai',
    'ini terakhir',
    'kami laporkan',
    'putus kontrak',
    'anjing',
    'bangsat',
    'goblok',
    'tolol',
    'kenapa telat terus ya',
    'driver ini kebiasaan terlambat',
    'kalau begini kita gausa order lagi deh',
    'driver ini ga becus banget sih',
    'driver ini ga becus banget',
    'lokasi tidak sesuai',
    'alasan keterlambatan',
    'armada tidak datang',
    'karatan',
    'bau',
    'keterlambatan unit tsb',
    'tidak ada update terkait keterlambatan',
    'tidak ada update terkait keterlambatan unit',
    'tidak ada update terkait keterlambatan armada',
    'Kok baru skr',
];

/* ============================= */
/* ========= UTILITIES ========= */
/* ============================= */

const normalizePhone = phone => {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
};

const normalizeText = text => {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const tokenize = text => {
  return normalizeText(text)
    .split(' ')
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
};

const extractNgrams = (tokens, minN = 1, maxN = 3) => {
  const phrases = [];
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i <= tokens.length - n; i++) {
      phrases.push(tokens.slice(i, i + n).join(' '));
    }
  }
  return phrases;
};

const isBlockedPhrase = phrase => {
  if (BLOCKLIST_PHRASES.has(phrase)) return true;
  const tokens = phrase.split(' ');
  if (tokens.some(t => BLOCKLIST_TOKENS.has(t))) return true;
  if (tokens.some(t => /\d/.test(t))) return true;
  if (phrase.length < 4) return true;
  return false;
};

const matchesSeed = (text, seeds) => {
  const normalized = normalizeText(text);
  return seeds.some(seed => normalized.includes(seed));
};

const parseDate = value => {
  if (!value) return null;
  if (typeof value === 'number') {
    const ts = value > 1e12 ? value : value * 1000;
    return new Date(ts);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const extractDocDate = doc =>
  parseDate(doc.timestamp) ||
  parseDate(doc.created_at) ||
  parseDate(doc.time) ||
  null;

/* ============================= */
/* ===== INTERNAL FILTER ======= */
/* ============================= */

const loadInternalPhones = () => {
  const filePath = process.env.USER_ADMIN_JSON
    ? path.resolve(process.env.USER_ADMIN_JSON)
    : path.join(__dirname, 'user_admin_202602231223.json');

  if (!fs.existsSync(filePath)) {
    console.warn('Internal user JSON not found. Skipping filter.');
    return new Set();
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.user_admin)
      ? parsed.user_admin
      : [];

  const set = new Set();

  rows.forEach(r => {
    if (Number(r.status) !== 1) return;
    if (!r.phone) return;
    const norm = normalizePhone(r.phone);
    if (norm) set.add(norm);
  });

  return set;
};

/* ============================= */
/* ===== WEIGHT CALCULATION ==== */
/* ============================= */

const calculateWeight = (complainCount, normalCount) => {
  const minTotal = Number(process.env.MIN_TOTAL_COUNT || 3);
  const minComplain = Number(process.env.MIN_COMPLAIN_COUNT || 2);
  const minRatio = Number(process.env.MIN_RATIO || 1.5);

  const total = complainCount + normalCount;
  if (total < minTotal) return null;
  if (complainCount < minComplain) return null;

  const ratio = complainCount / Math.max(normalCount, 1);
  if (ratio < minRatio) return null;

  if (ratio >= 3 && complainCount >= 3) {
    return { weight: 3, type: 'strong', ratio };
  }

  if (ratio >= 1.5) {
    return { weight: 2, type: 'medium', ratio };
  }

  return { weight: 1, type: 'weak', ratio };
};

/* ============================= */
/* ========== EXPORT =========== */
/* ============================= */

const toXlsx = (rows, outputFile) => {
  const worksheet = xlsx.utils.json_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'intent_keywords');
  xlsx.writeFile(workbook, outputFile);
};

/* ============================= */
/* ============ MAIN =========== */
/* ============================= */

const run = async () => {
  const internalPhones = loadInternalPhones();
  console.log('Internal phones loaded:', internalPhones.size);
  console.log('Starting complain phrase mining...');
  const maxExamplesPerPhrase = Number(process.env.MAX_EXAMPLES_PER_PHRASE || 3);

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();

  const db = mongo.db(process.env.MONGO_DB);
  const collection = db.collection('messages');

  const complainMap = new Map();
  const normalMap = new Map();
  const exampleMap = new Map();

  const startDate = parseDate(process.env.START_DATE);
  const endDate = parseDate(process.env.END_DATE);

  const cursor = collection.find({ is_forwarded: false });
  const logEvery = Number(process.env.LOG_EVERY || 5000);
  let processed = 0;
  let complainDocs = 0;
  let normalDocs = 0;
  let skippedDocs = 0;

  for await (const doc of cursor) {
    processed += 1;
    let author = normalizePhone((doc.author || '').split('@')[0]);
    if (!author) continue;

    // ✅ FILTER ONLY EXTERNAL USER
    if (internalPhones.has(author)) {
      skippedDocs += 1;
      if (processed % logEvery === 0) {
        console.log('Progress:', processed, 'docs | complain:', complainDocs, 'normal:', normalDocs, 'skipped:', skippedDocs);
      }
      continue;
    }

    const body = doc.body || '';
    if (!body) {
      skippedDocs += 1;
      if (processed % logEvery === 0) {
        console.log('Progress:', processed, 'docs | complain:', complainDocs, 'normal:', normalDocs, 'skipped:', skippedDocs);
      }
      continue;
    }

    const docDate = extractDocDate(doc);
    if (startDate && docDate && docDate < startDate) continue;
    if (endDate && docDate && docDate > endDate) continue;

    const isComplain = matchesSeed(body, DEFAULT_COMPLAIN_SEEDS);
    if (isComplain) {
      complainDocs += 1;
    } else {
      normalDocs += 1;
    }

    const tokens = tokenize(body);
    if (tokens.length === 0) {
      skippedDocs += 1;
      if (processed % logEvery === 0) {
        console.log('Progress:', processed, 'docs | complain:', complainDocs, 'normal:', normalDocs, 'skipped:', skippedDocs);
      }
      continue;
    }

    const phrases = extractNgrams(tokens, 1, 3);
    const cleanBody = body.replace(/\s+/g, ' ').trim();

    phrases.forEach(phrase => {
      if (isBlockedPhrase(phrase)) return;

      const targetMap = isComplain ? complainMap : normalMap;

      if (!targetMap.has(phrase)) {
        targetMap.set(phrase, 0);
      }

      targetMap.set(phrase, targetMap.get(phrase) + 1);

      if (isComplain && cleanBody) {
        if (!exampleMap.has(phrase)) {
          exampleMap.set(phrase, []);
        }
        const examples = exampleMap.get(phrase);
        if (examples.length < maxExamplesPerPhrase && !examples.includes(cleanBody)) {
          examples.push(cleanBody);
        }
      }
    });

    if (processed % logEvery === 0) {
      console.log('Progress:', processed, 'docs | complain:', complainDocs, 'normal:', normalDocs, 'skipped:', skippedDocs);
    }
  }

  const results = [];

  for (const [phrase, complainCount] of complainMap.entries()) {
    const normalCount = normalMap.get(phrase) || 0;

    const result = calculateWeight(complainCount, normalCount);
    if (!result) continue;

    results.push({
      phrase,
      complain_count: complainCount,
      normal_count: normalCount,
      ratio: Number(result.ratio.toFixed(2)),
      weight: result.weight,
      type: result.type,
      examples: (exampleMap.get(phrase) || []).join(' | ')
    });
  }

  results.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.complain_count - a.complain_count;
  });

  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outputFile = path.join(
    outputDir,
    `intent_keyword_suggestions_${dateStamp}.xlsx`
  );

  toXlsx(results, outputFile);

  console.log('Exported:', outputFile);
  console.log('Total keywords:', results.length);
  console.log('Finished. Docs processed:', processed, 'complain:', complainDocs, 'normal:', normalDocs, 'skipped:', skippedDocs);

  await mongo.close();
};

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});