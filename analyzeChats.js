require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { STOPWORDS, BLOCKLIST_TOKENS, BLOCKLIST_PHRASES } = require('./filters');

// ======================
// INTENT KEYWORDS
// ======================
const INTENT_KEYWORDS = {
  problem: [
    { phrase: 'ada kendala', weight: 3, type: 'strong' },
    { phrase: 'belum sampai', weight: 3, type: 'strong' },
    { phrase: 'telat', weight: 2, type: 'medium' },
    { phrase: 'delay', weight: 2, type: 'medium' },
    { phrase: 'kenapa', weight: 2, type: 'medium' },
    { phrase: 'masalah', weight: 2, type: 'medium' },
    { phrase: 'kendala', weight: 2, type: 'medium' },
    { phrase: 'terlambat', weight: 2, type: 'medium' },
    { phrase: 'stuck', weight: 2, type: 'medium' },
    { phrase: 'macet', weight: 1, type: 'weak' }
  ],
  update: [
    { phrase: 'minta update', weight: 3, type: 'strong' },
    { phrase: 'tolong update', weight: 3, type: 'strong' },
    { phrase: 'posisi', weight: 2, type: 'medium' },
    { phrase: 'tracking', weight: 1, type: 'weak' },
    { phrase: 'status', weight: 1, type: 'weak' },
    { phrase: 'lokasi', weight: 1, type: 'weak' },
    { phrase: 'dimana', weight: 1, type: 'weak' },
    { phrase: 'update', weight: 1, type: 'weak' },
    { phrase: 'cek', weight: 1, type: 'weak' }
  ]
};

// Lists moved to filters.js for easier maintenance

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
// TEXT NORMALIZATION
// ======================
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const normalized = normalizeText(text);
  return normalized
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

// ======================
// TRUCK NUMBER EXTRACTION
// ======================
function extractTruckNumbers(text) {
  if (!text) return [];

  const results = new Set();
  const raw = text.toUpperCase();

  // Common plate format: B 1234 CD / AB-1234-EF
  const plateRegex = /\b([A-Z]{1,2})\s?-?\s?(\d{1,4})\s?-?\s?([A-Z]{1,3})\b/g;
  let match;
  while ((match = plateRegex.exec(raw)) !== null) {
    results.add(`${match[1]} ${match[2]} ${match[3]}`.trim());
  }

  // Truck number mentions: truk/truck no/nomor/number #XYZ123
  const truckNoRegex = /\b(?:truck|truk)\s*(?:no\.?|nomor|number|#)?\s*([A-Z0-9-]{3,})\b/gi;
  while ((match = truckNoRegex.exec(raw)) !== null) {
    results.add(match[1].replace(/\s+/g, '').trim());
  }

  return Array.from(results);
}

// ======================
// INTENT SCORING
// ======================
function scoreIntent(text) {
  const normalized = normalizeText(text);

  const result = {
    intent: 'unknown',
    score: 0,
    scores: {
      problem: 0,
      update: 0
    },
    matched: {
      problem: [],
      update: []
    }
  };

  Object.entries(INTENT_KEYWORDS).forEach(([intent, keywords]) => {
    keywords.forEach(k => {
      if (normalized.includes(k.phrase)) {
        result.scores[intent] += k.weight;
        result.matched[intent].push({
          phrase: k.phrase,
          weight: k.weight,
          type: k.type
        });
      }
    });
  });

  if (result.scores.problem > result.scores.update) {
    result.intent = 'problem';
    result.score = result.scores.problem;
  } else if (result.scores.update > result.scores.problem) {
    result.intent = 'update';
    result.score = result.scores.update;
  } else if (result.scores.problem > 0) {
    result.intent = 'mixed';
    result.score = result.scores.problem;
  }

  return result;
}

// ======================
// EXISTING PHRASES (FROM HARDCODED KEYWORDS)
// ======================
function getExistingPhrasesFromHardcoded() {
  const existing = new Set();
  Object.values(INTENT_KEYWORDS).forEach(list => {
    list.forEach(k => {
      if (k.phrase) existing.add(String(k.phrase).toLowerCase());
    });
  });
  return existing;
}

// ======================
// PHRASE EXTRACTION
// ======================
function extractNgrams(tokens, minN = 1, maxN = 3) {
  const phrases = [];
  for (let n = minN; n <= maxN; n += 1) {
    for (let i = 0; i <= tokens.length - n; i += 1) {
      const gram = tokens.slice(i, i + n).join(' ');
      phrases.push(gram);
    }
  }
  return phrases;
}

function suggestWeight(problemCount, updateCount) {
  const total = problemCount + updateCount;
  if (total === 0) return { weight: 0, type: 'none', ratio: 0 };

  const ratio = problemCount > updateCount
    ? problemCount / Math.max(updateCount, 1)
    : updateCount / Math.max(problemCount, 1);

  if (ratio >= 3 && total >= 3) return { weight: 3, type: 'strong', ratio };
  if (ratio >= 1.5 && total >= 2) return { weight: 2, type: 'medium', ratio };
  return { weight: 1, type: 'weak', ratio };
}

function isBlockedPhrase(phrase) {
  if (BLOCKLIST_PHRASES.has(phrase)) return true;
  const tokens = phrase.split(' ');
  if (tokens.some(t => BLOCKLIST_TOKENS.has(t))) return true;
  if (tokens.some(t => /\d/.test(t))) return true;
  return false;
}

function toXlsx(rows, outputFile) {
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
  xlsx.utils.book_append_sheet(workbook, worksheet, 'intent_suggestions');
  xlsx.writeFile(workbook, outputFile);
}

// ======================
// LOAD INTERNAL PHONES
// ======================
async function loadInternalPhones() {
  const filePath = process.env.USER_ADMIN_JSON
    ? path.resolve(process.env.USER_ADMIN_JSON)
    : path.join(__dirname, 'user_admin_202602031111.json');

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
}

// ======================
// MAIN
// ======================
async function run() {
  const existingPhrases = getExistingPhrasesFromHardcoded();

  const minPhraseCount = Number(process.env.MIN_PHRASE_COUNT || 2);
  const maxExamplesPerPhrase = Number(process.env.MAX_EXAMPLES_PER_PHRASE || 3);

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

  const phraseStats = new Map();

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

    const truckNumbers = extractTruckNumbers(body);
    if (truckNumbers.length === 0) {
      continue;
    }

    const intentResult = scoreIntent(body);

    const label = intentResult.intent === 'problem' || intentResult.intent === 'update'
      ? intentResult.intent
      : null;

    if (label) {
      const tokens = tokenize(body);
      const phrases = extractNgrams(tokens, 1, 3);

      phrases.forEach(phrase => {
        if (isBlockedPhrase(phrase)) return;
        if (!phraseStats.has(phrase)) {
          phraseStats.set(phrase, { problem: 0, update: 0, examples: [] });
        }
        const entry = phraseStats.get(phrase);
        entry[label] += 1;
        if (entry.examples.length < maxExamplesPerPhrase) {
          const clean = normalizeText(body);
          if (!entry.examples.includes(clean)) {
            entry.examples.push(clean);
          }
        }
      });
    }

    console.log('CUSTOMER CHAT:', body);
    console.log('TRUCK NUMBERS:', truckNumbers);
    console.log('INTENT:', intentResult.intent, 'SCORE:', intentResult.score);
    console.log('DETAILS:', intentResult);
  }

  const suggestions = [];
  for (const [phrase, counts] of phraseStats.entries()) {
    if (existingPhrases.has(phrase)) continue;
    if (isBlockedPhrase(phrase)) continue;
    const { weight, type, ratio } = suggestWeight(counts.problem, counts.update);
    if (weight === 0) continue;

    const totalCount = counts.problem + counts.update;
    if (totalCount < minPhraseCount) continue;

    const suggested_intent = counts.problem >= counts.update ? 'problem' : 'update';
    suggestions.push({
      phrase,
      suggested_intent,
      weight,
      type,
      problem_count: counts.problem,
      update_count: counts.update,
      ratio,
      examples: counts.examples
    });
  }

  suggestions.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const bTotal = b.problem_count + b.update_count;
    const aTotal = a.problem_count + a.update_count;
    return bTotal - aTotal;
  });

  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outputFile = path.join(outputDir, `intent_suggestions_${dateStamp}.xlsx`);
  toXlsx(suggestions, outputFile);
  console.log('Exported suggestions to:', outputFile);

  await mongo.close();
}

run();
