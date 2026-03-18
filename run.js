'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { run } = require('./monday-copy/index');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const prefix = `--${name}=`;
  const a = args.find(a => a.startsWith(prefix));
  return a ? a.slice(prefix.length) : null;
}

const SOURCE_WORKSPACE = getArg('source-workspace');
const TARGET_WORKSPACE = getArg('target-workspace');
const DRY_RUN          = args.includes('--dry-run');
const SCHEMA_ONLY      = args.includes('--schema-only');
const ITEM_LIMIT       = getArg('limit') ? parseInt(getArg('limit'), 10) : null;
const FOLDER_FILTER    = getArg('folder') || null;

if (!SOURCE_WORKSPACE || !TARGET_WORKSPACE) {
  console.error('Usage: node run.js --source-workspace=ID --target-workspace=ID [--dry-run] [--schema-only] [--limit=N] [--folder=ID]');
  process.exit(1);
}

const SOURCE_TOKEN = process.env.MONDAY_SOURCE_TOKEN || process.env.MONDAY_TOKEN;
const TARGET_TOKEN = process.env.MONDAY_TARGET_TOKEN || process.env.MONDAY_TOKEN;

if (!SOURCE_TOKEN || !TARGET_TOKEN) {
  console.error('Set MONDAY_SOURCE_TOKEN and MONDAY_TARGET_TOKEN in .env (or MONDAY_TOKEN for both)');
  process.exit(1);
}

// ── State ────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'monday-copy-state.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.updates) s.updates = {};
    return s;
  } catch {
    return { boards: {}, groups: {}, columns: {}, items: {}, updates: {} };
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Entry point ──────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);

log(`\nMonday → Monday workspace copy`);
log(`  Source workspace: ${SOURCE_WORKSPACE}`);
log(`  Target workspace: ${TARGET_WORKSPACE}`);
log(`  Folder filter:    ${FOLDER_FILTER || 'none (all boards)'}`);
log(`  Dry run:          ${DRY_RUN}`);
log(`  Schema only:      ${SCHEMA_ONLY}`);
log(`  Item limit:       ${ITEM_LIMIT || 'none'}\n`);

run({
  sourceWorkspace: SOURCE_WORKSPACE,
  targetWorkspace: TARGET_WORKSPACE,
  sourceToken:     SOURCE_TOKEN,
  targetToken:     TARGET_TOKEN,
  dryRun:          DRY_RUN,
  schemaOnly:      SCHEMA_ONLY,
  itemLimit:       ITEM_LIMIT,
  folderFilter:    FOLDER_FILTER,
  loadState,
  saveState,
  log,
}).then(() => {
  log('\n✓ Copy complete.\n');
  log(`State saved to: ${STATE_FILE}`);
}).catch(e => { console.error(e); process.exit(1); });
