require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { STOPWORDS, BLOCKLIST_TOKENS, BLOCKLIST_PHRASES } = require('./filters');

const COMPLAIN_PATTERNS = {
  soft: [
    'kecewa',
    'tidak puas',
    'gak puas',
    'tidak sesuai'
  ],
  operational: [
    'tidak pickup',
    'belum pickup',
    'driver tidak datang',
    'unit tidak datang',
    'over sla',
    'lewat sla',
    'terlambat',
    'delay'
  ],
  escalation: [
    'sudah berapa kali',
    'kapan selesai',
    'ini terakhir',
    'kami laporkan',
    'putus kontrak',
    'stop kirim'
  ],
  hard: [
    'anjing',
    'bangsat',
    'goblok',
    'tolol',
    'kampret'
  ]
};

const calculateSeverity = (body) => {
  const text = normalizeText(body);
  let score = 0;
  let matchedCategory = [];

  const checkCategory = (category, weight) => {
    for (const phrase of COMPLAIN_PATTERNS[category]) {
      if (text.includes(phrase)) {
        score += weight;
        matchedCategory.push(category);
      }
    }
  };

  checkCategory('soft', 1);
  checkCategory('operational', 2);
  checkCategory('escalation', 3);
  checkCategory('hard', 5);

  // CAPSLOCK DETECTION
  const isCaps = body.length > 10 && body === body.toUpperCase();
  if (isCaps) score += 2;

  // MULTIPLE !!!
  if (/!{2,}/.test(body)) score += 1;

  return {
    score,
    categories: [...new Set(matchedCategory)],
    level:
      score >= 7 ? 'critical' :
      score >= 4 ? 'high' :
      score >= 2 ? 'medium' :
      score >= 1 ? 'low' :
      'none'
  };
};

const INDONESIAN_HINTS = new Set([
  'yang', 'dan', 'atau', 'untuk', 'dengan', 'dari', 'ke', 'di', 'itu', 'ini',
  'tidak', 'ga', 'gak', 'nggak', 'ngga', 'belum', 'sudah', 'udah', 'lagi',
  'kami', 'saya', 'aku', 'kita', 'anda', 'kamu', 'mohon', 'tolong', 'minta'
]);

const normalizePhone = phone => {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) {
    p = '62' + p.slice(1);
  }
  if (!p.startsWith('62')) {
    p = '62' + p;
  }
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
  const normalized = normalizeText(text);
  return normalized
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
};

const extractNgrams = (tokens, minN = 1, maxN = 3) => {
  const phrases = [];
  for (let n = minN; n <= maxN; n += 1) {
    for (let i = 0; i <= tokens.length - n; i += 1) {
      phrases.push(tokens.slice(i, i + n).join(' '));
    }
  }
  return phrases;
};

const suggestWeight = (complainCount, otherCount) => {
  const total = complainCount + otherCount;
  if (total === 0) return { weight: 0, type: 'none', ratio: 0 };

  const ratio = complainCount > otherCount
    ? complainCount / Math.max(otherCount, 1)
    : otherCount / Math.max(complainCount, 1);

  if (ratio >= 3 && total >= 3) return { weight: 3, type: 'strong', ratio };
  if (ratio >= 1.5 && total >= 2) return { weight: 2, type: 'medium', ratio };
  return { weight: 1, type: 'weak', ratio };
};

const isBlockedPhrase = phrase => {
  if (BLOCKLIST_PHRASES.has(phrase)) return true;
  const tokens = phrase.split(' ');
  if (tokens.some(t => BLOCKLIST_TOKENS.has(t))) return true;
  if (tokens.some(t => /\d/.test(t))) return true;
  return false;
};

const isLikelyIndonesian = text => {
  const tokens = normalizeText(text).split(' ').filter(Boolean);
  if (tokens.length === 0) return false;

  let hits = 0;
  tokens.forEach(t => {
    if (INDONESIAN_HINTS.has(t)) hits += 1;
  });

  if (tokens.length <= 3) {
    return hits >= 1;
  }

  return hits >= 2;
};

const loadInternalPhones = async () => {
  const filePath = process.env.USER_ADMIN_JSON
    ? path.resolve(process.env.USER_ADMIN_JSON)
    : path.join(__dirname, 'user_admin_202602231223.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(`User admin JSON not found: ${filePath}`);
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

const getSeedPhrases = () => {
  const raw = process.env.COMPLAIN_SEED_PHRASES || '';
  if (!raw.trim()) return DEFAULT_COMPLAIN_SEEDS;

  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
};

const matchesSeed = (text, seedPhrases) => {
  const normalized = normalizeText(text);
  return seedPhrases.some(phrase => normalized.includes(phrase));
};

const parseDate = value => {
  if (!value) return null;
  if (typeof value === 'number') {
    const ts = value > 1e12 ? value : value * 1000;
    return new Date(ts);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const extractDocDate = doc => {
  return parseDate(doc.timestamp) || parseDate(doc.created_at) || parseDate(doc.time) || null;
};

const toXlsx = (rows, outputFile) => {
  const data = rows.map(r => ({
    phrase: r.phrase,
    suggested_intent: r.suggested_intent,
    weight: r.weight,
    type: r.type,
    problem_count: r.problem_count,
    update_count: r.update_count,
    ratio: Number(r.ratio.toFixed(2)),
    examples: r.examples.join(' | ')
  }));

  const worksheet = xlsx.utils.json_to_sheet(data, {
    header: [
      'phrase',
      'suggested_intent',
      'weight',
      'type',
      'problem_count',
      'update_count',
      'ratio',
      'examples'
    ]
  });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'complain_suggestions');
  xlsx.writeFile(workbook, outputFile);
};

const run = async () => {
  const minPhraseCount = Number(process.env.MIN_PHRASE_COUNT || 2);
  const maxExamplesPerPhrase = Number(process.env.MAX_EXAMPLES_PER_PHRASE || 3);
  const requireTruckNumber = process.env.REQUIRE_TRUCK_NUMBER === '1';

  const chatIdFilter = (process.env.CHAT_ID || '').trim();
  const startDate = parseDate(process.env.START_DATE);
  const endDate = parseDate(process.env.END_DATE);

  const seedPhrases = getSeedPhrases();
  const internalPhones = await loadInternalPhones();
  console.log('Internal Phones Loaded:', internalPhones.size);
  console.log('Seed Phrases:', seedPhrases.length);

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();

  const db = mongo.db(process.env.MONGO_DB);
  const collection = db.collection('messages');

  const query = {
    is_forwarded: false
  };

  if (chatIdFilter) {
    query.chat_id = chatIdFilter;
  }

  const cursor = collection.find(query);
  const phraseStats = new Map();

  while (await cursor.hasNext()) {
    const doc = await cursor.next();

    let author = doc.author || '';
    author = author.split('@')[0];
    author = normalizePhone(author);

    if (!author || internalPhones.has(author)) {
      continue;
    }

    const body = doc.body || '';
    if (!body) continue;
    if (!isLikelyIndonesian(body)) continue;

    const docDate = extractDocDate(doc);
    if (startDate && docDate && docDate < startDate) continue;
    if (endDate && docDate && docDate > endDate) continue;

    if (!matchesSeed(body, seedPhrases)) {
      continue;
    }

    if (requireTruckNumber) {
      const plateRegex = /\b([A-Z]{1,2})\s?-?\s?(\d{1,4})\s?-?\s?([A-Z]{1,3})\b/i;
      if (!plateRegex.test(body)) {
        continue;
      }
    }

    const tokens = tokenize(body);
    const phrases = extractNgrams(tokens, 1, 3);

    phrases.forEach(phrase => {
      if (isBlockedPhrase(phrase)) return;
      if (!phraseStats.has(phrase)) {
        phraseStats.set(phrase, { count: 0, examples: [] });
      }
      const entry = phraseStats.get(phrase);
      entry.count += 1;
      if (entry.examples.length < maxExamplesPerPhrase) {
        const clean = normalizeText(body);
        if (!entry.examples.includes(clean)) {
          entry.examples.push(clean);
        }
      }
    });
  }

  const suggestions = [];
  for (const [phrase, stats] of phraseStats.entries()) {
    if (isBlockedPhrase(phrase)) continue;
    if (stats.count < minPhraseCount) continue;

    const { weight, type, ratio } = suggestWeight(stats.count, 0);
    if (weight === 0) continue;

    suggestions.push({
      phrase,
      suggested_intent: 'complain',
      weight,
      type,
      problem_count: stats.count,
      update_count: 0,
      ratio,
      examples: stats.examples
    });
  }

  suggestions.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.problem_count - a.problem_count;
  });

  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outputFile = process.env.OUTPUT_XLSX
    ? path.resolve(process.env.OUTPUT_XLSX)
    : path.join(outputDir, `complain_suggestions_${dateStamp}.xlsx`);

  toXlsx(suggestions, outputFile);
  console.log('Exported complain suggestions to:', outputFile);

  await mongo.close();
};

run().catch(err => {
  console.error('Failed to run analyzeHardComplain:', err.message);
  process.exit(1);
});
