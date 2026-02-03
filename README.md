# shopee-monitor-analyze

Analyze WhatsApp customer chats (MongoDB) to suggest intent keywords and weights, then export results to Excel.

## What this script does

- Reads chat logs from MongoDB.
- Skips internal users using a `user_admin` JSON export.
- Only analyzes chats that contain a truck number (plate/ID).
- Labels each chat using current intent keywords (hardcoded).
- Mines phrases (1–3 words), filters them, then suggests intent + weight.
- Exports results to an XLSX file.

## Requirements

- Node.js 18+
- MongoDB access (read-only)

## Install

```bash
npm install
```

## Configuration

Create a `.env` file (copy from [example.env](example.env)):

```dotenv
MONGO_URI=
MONGO_DB=
USER_ADMIN_JSON=
MIN_PHRASE_COUNT=2
MAX_EXAMPLES_PER_PHRASE=3
```

### Notes

- `USER_ADMIN_JSON` should point to the exported `user_admin` JSON file.
- If `USER_ADMIN_JSON` is empty, the script tries `user_admin_202602031111.json` in the project root.
- `MIN_PHRASE_COUNT` is the minimum total occurrences of a phrase before it appears in the output.
- `MAX_EXAMPLES_PER_PHRASE` controls how many example chat texts are stored per phrase.

## Run

```bash
node analyzeChats.js
```

Output is written to:

```
output/intent_suggestions_YYYYMMDD.xlsx
```

## How the counting works

### 1) Intent labeling (per chat)

Each chat is labeled using the current hardcoded intent keywords in [analyzeChats.js](analyzeChats.js):

- If `problem` score > `update` score → label `problem`
- If `update` score > `problem` score → label `update`
- If equal but > 0 → label `mixed`
- If both 0 → label `unknown`

Only `problem` and `update` labels are used for mining.

### 2) Phrase extraction (1–3 words)

For labeled chats, the script:

- Normalizes text (lowercase, remove symbols).
- Removes `STOPWORDS` from [filters.js](filters.js).
- Extracts all 1–3 word phrases (ngrams).

### 3) Phrase filtering

Phrases are excluded when:

- The phrase is already in your hardcoded intent list.
- It matches `BLOCKLIST_PHRASES` (exact match).
- It contains any token in `BLOCKLIST_TOKENS`.
- It contains any number (digits).
- Its total count is below `MIN_PHRASE_COUNT`.

Lists are maintained in [filters.js](filters.js).

### 4) Counts

For each phrase, the script keeps:

- `problem_count`: how many `problem` chats contain this phrase
- `update_count`: how many `update` chats contain this phrase

### 5) Ratio

Ratio is the intent strength signal:

If `problem_count > update_count`:

$$ratio = \frac{problem\_count}{\max(update\_count, 1)}$$

Else:

$$ratio = \frac{update\_count}{\max(problem\_count, 1)}$$

Higher ratio = more intent-specific.

### 6) Weight suggestion

- `strong` (weight 3): ratio ≥ 3 and total ≥ 3
- `medium` (weight 2): ratio ≥ 1.5 and total ≥ 2
- `weak` (weight 1): everything else

## Safety

The script is read-only for databases:

- MongoDB: `find` only
- MySQL: not used

The only write is the local XLSX output file.