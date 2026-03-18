'use strict';
const CopyClient   = require('./client');
const MondayReader = require('./reader');

// ── Column type handling ──────────────────────────────────────────────────────

// Types we cannot create via API (board_relation handled separately in Phase 1c)
const SKIP_CREATE_TYPES = new Set([
  'name', 'subtasks', 'mirror', 'lookup', 'formula',
  'auto_number', 'creation_log', 'last_updated', 'item_id', 'file',
]);

// Types whose values we skip in Phase 2 (board_relation connected in Phase 3)
const SKIP_VALUE_TYPES = new Set([
  'name', 'subtasks', 'mirror', 'lookup', 'formula',
  'auto_number', 'creation_log', 'last_updated', 'item_id', 'file',
  'people', 'multiple-people', 'tags', 'dependency', 'board_relation',
]);

function transformColumnValue(colType, rawValue, textValue) {
  if (!rawValue || rawValue === 'null') return null;
  try {
    const parsed = JSON.parse(rawValue);
    switch (colType) {
      case 'text':
      case 'long_text':   return textValue || null;
      case 'numbers':
      case 'numeric':     return textValue || null;
      case 'date':        return parsed.date ? { date: parsed.date } : null;
      case 'status':
      case 'color':
        if (parsed.label !== undefined) return { label: parsed.label };
        return textValue ? { label: textValue } : null;
      case 'email':       return parsed.email ? { email: parsed.email, text: parsed.text || parsed.email } : null;
      case 'phone':       return parsed.phone ? { phone: parsed.phone, countryShortName: parsed.countryShortName || '' } : null;
      case 'link':        return parsed.url ? { url: parsed.url, text: parsed.text || parsed.url } : null;
      case 'checkbox':    return { checked: parsed.checked ? 'true' : 'false' };
      case 'rating':      return parsed.rating !== undefined ? { rating: parsed.rating } : null;
      case 'timeline':    return (parsed.from && parsed.to) ? { from: parsed.from, to: parsed.to } : null;
      case 'week':        return parsed.week ? { week: parsed.week } : null;
      case 'country':     return parsed.countryCode ? { countryCode: parsed.countryCode, countryName: parsed.countryName || '' } : null;
      default:            return null;
    }
  } catch {
    return null;
  }
}

function buildColumnValues(columnValues, colTypeMap, srcBoardId, state) {
  const vals = {};
  for (const cv of (columnValues || [])) {
    const colType = colTypeMap[cv.id];
    if (!colType || SKIP_VALUE_TYPES.has(colType)) continue;
    if (!cv.value || cv.value === 'null') continue;
    const tgtColId = state.columns[`${srcBoardId}:${cv.id}`];
    if (!tgtColId) continue;
    const val = transformColumnValue(colType, cv.value, cv.text);
    if (val === null) continue;
    vals[tgtColId] = val;
  }
  return vals;
}

// ── Timing tracker ────────────────────────────────────────────────────────────

class Timings {
  constructor() { this._data = {}; }

  async track(label, fn) {
    const t0  = Date.now();
    const res = await fn();
    const ms  = Date.now() - t0;
    if (!this._data[label]) this._data[label] = [];
    this._data[label].push(ms);
    return { result: res, ms };
  }

  summary(log) {
    log('\n═══ Timing Summary ═══\n');
    const pad = (s, n) => String(s).padEnd(n);
    log(`  ${pad('Action', 28)} ${pad('Count', 7)} ${pad('Avg', 9)} ${pad('Min', 9)} ${pad('Max', 9)} Total`);
    log(`  ${'-'.repeat(75)}`);
    for (const [label, times] of Object.entries(this._data).sort((a, b) => a[0].localeCompare(b[0]))) {
      const count = times.length;
      const total = times.reduce((a, b) => a + b, 0);
      const avg   = Math.round(total / count);
      const min   = Math.min(...times);
      const max   = Math.max(...times);
      log(`  ${pad(label, 28)} ${pad(count, 7)} ${pad(avg + 'ms', 9)} ${pad(min + 'ms', 9)} ${pad(max + 'ms', 9)} ${Math.round(total / 1000)}s`);
    }
    log('');
  }
}

// ── Main run function ──────────────────────────────────────────────────────────

async function run({ sourceWorkspace, targetWorkspace, sourceToken, targetToken, dryRun, schemaOnly, itemLimit, folderFilter, saveState, loadState, log }) {
  log = log || console.log;
  const T = new Timings();

  const sourceClient = new CopyClient(sourceToken, false);
  const targetClient = new CopyClient(targetToken, dryRun);
  const reader       = new MondayReader(sourceClient, log);

  const state = loadState();
  log(`[State] Loaded: ${Object.keys(state.boards).length} boards, ${Object.keys(state.items).length} items mapped`);
  state.save = () => saveState(state);

  const sourceBoards = await reader.getWorkspaceBoards(sourceWorkspace, folderFilter || null);
  if (sourceBoards.length === 0) { log('No boards found. Exiting.'); return; }
  log(`\nBoards to copy: ${sourceBoards.map(b => `"${b.name}"`).join(', ')}\n`);

  const srcSubitemBoards = await reader.getSubitemBoards(sourceWorkspace);

  // ── Phase 1a: Boards, groups, non-relation columns ────────────────────────
  log('\n═══ Phase 1a: Creating boards, groups, columns ═══\n');

  for (const srcBoard of sourceBoards) {
    const srcId = srcBoard.id;

    if (state.boards[srcId]) {
      log(`  [board] "${srcBoard.name}" → already mapped to ${state.boards[srcId]}`);
    } else {
      log(`  [board] Creating "${srcBoard.name}"...`);
      let tgtBoardId;
      if (dryRun) {
        tgtBoardId = `dry-${srcId}`;
      } else {
        const { result, ms } = await T.track('board_create', () =>
          targetClient.createBoard(srcBoard.name, targetWorkspace, srcBoard.board_kind || 'public'));
        tgtBoardId = result;
        log(`  [board]   → ${tgtBoardId} (${ms}ms)`);
      }
      state.boards[srcId] = tgtBoardId;
      state.save();
    }

    const tgtBoardId = state.boards[srcId];

    for (const grp of (srcBoard.groups || [])) {
      const grpKey = `${srcId}:${grp.id}`;
      if (state.groups[grpKey]) continue;
      let tgtGrpId;
      if (dryRun) {
        tgtGrpId = `dry-grp-${grp.id}`;
      } else {
        const { result, ms } = await T.track('group_create', () =>
          targetClient.createGroup(tgtBoardId, grp.title));
        tgtGrpId = result;
        log(`  [group]  "${grp.title}" → ${tgtGrpId} (${ms}ms)`);
      }
      state.groups[grpKey] = tgtGrpId;
      state.save();
    }

    for (const col of (srcBoard.columns || [])) {
      if (SKIP_CREATE_TYPES.has(col.type) || col.type === 'board_relation') continue;
      const colKey = `${srcId}:${col.id}`;
      if (state.columns[colKey]) continue;
      let tgtColId = null;
      if (dryRun) {
        tgtColId = `dry-col-${col.id}`;
      } else {
        let defaults = null;
        if (col.settings_str) try { defaults = JSON.parse(col.settings_str); } catch {}
        try {
          const { result, ms } = await T.track('column_create', () =>
            targetClient.createColumn(tgtBoardId, col.title, col.type, defaults));
          tgtColId = result;
          log(`  [column] "${col.title}" (${col.type}) → ${tgtColId} (${ms}ms)`);
        } catch (e) {
          log(`  [column]   WARN: ${e.message}`);
        }
      }
      state.columns[colKey] = tgtColId;
      state.save();
    }
  }

  log('\n[Phase 1a] Done.\n');

  // ── Phase 1b: Subitems board bootstrap + column mapping ───────────────────
  // Creates a dummy item+subitem per board to trigger Monday to auto-create
  // "Subitems of X" boards in the target workspace, then maps their columns.
  log('\n═══ Phase 1b: Bootstrapping subitems boards ═══\n');

  for (const srcBoard of sourceBoards) {
    const srcSubBoard = srcSubitemBoards.find(s =>
      s.name.toLowerCase() === `subitems of ${srcBoard.name.toLowerCase()}`);
    if (!srcSubBoard) continue;

    if (state.boards[srcSubBoard.id]) {
      log(`  [subitems] "${srcBoard.name}" → already bootstrapped (tgt ${state.boards[srcSubBoard.id]})`);
      continue;
    }

    const tgtBoardId = state.boards[srcBoard.id];
    if (!tgtBoardId) { log(`  [subitems] SKIP "${srcBoard.name}" — parent board not mapped`); continue; }

    if (dryRun) {
      state.boards[srcSubBoard.id] = `dry-sub-board-${srcSubBoard.id}`;
      state.save();
      continue;
    }

    log(`  [subitems] Bootstrapping "${srcBoard.name}"...`);
    const firstGroupKey = Object.keys(state.groups).find(k => k.startsWith(`${srcBoard.id}:`));
    const tgtGroupId    = firstGroupKey ? state.groups[firstGroupKey] : null;

    try {
      const dummyItemId = await targetClient.createItem(tgtBoardId, tgtGroupId, '__bootstrap__', {});
      const { boardId: tgtSubBoardId } = await targetClient.createSubitem(dummyItemId, '__bootstrap__', {});
      await targetClient.deleteItem(dummyItemId);
      state.boards[srcSubBoard.id] = tgtSubBoardId;
      state.save();
      log(`  [subitems] "${srcBoard.name}" → tgt subitems board ${tgtSubBoardId}`);
    } catch (e) {
      log(`  [subitems] WARN "${srcBoard.name}" — bootstrap failed (${e.message.slice(0, 80)}), skipping`);
    }
  }

  // Map subitems board columns (match by title+type, create missing ones)
  if (!dryRun) {
    log(`  [subitems] Fetching target boards to map subitems columns...`);
    const tgtAllBoards = await targetClient.getAllBoardsInWorkspace(targetWorkspace);
    const tgtBoardById = {};
    for (const b of tgtAllBoards) tgtBoardById[b.id] = b;

    for (const srcSubBoard of srcSubitemBoards) {
      const tgtSubBoardId = state.boards[srcSubBoard.id];
      if (!tgtSubBoardId) continue;

      const tgtSubBoard = tgtBoardById[tgtSubBoardId];
      if (!tgtSubBoard) continue;

      for (const srcCol of (srcSubBoard.columns || [])) {
        if (SKIP_CREATE_TYPES.has(srcCol.type) || srcCol.type === 'board_relation') continue;
        const colKey = `${srcSubBoard.id}:${srcCol.id}`;
        if (state.columns[colKey] !== undefined) continue;

        const tgtCol = (tgtSubBoard.columns || []).find(c => c.title === srcCol.title && c.type === srcCol.type);
        if (tgtCol) {
          state.columns[colKey] = tgtCol.id;
          log(`  [col-map] subitems "${srcCol.title}" → ${tgtCol.id}`);
        } else {
          let defaults = null;
          if (srcCol.settings_str) try { defaults = JSON.parse(srcCol.settings_str); } catch {}
          try {
            const tgtColId = await targetClient.createColumn(tgtSubBoardId, srcCol.title, srcCol.type, defaults);
            state.columns[colKey] = tgtColId;
            log(`  [col-map] subitems "${srcCol.title}" → created ${tgtColId}`);
          } catch (e) {
            log(`  [col-map] WARN "${srcCol.title}": ${e.message}`);
            state.columns[colKey] = null;
          }
        }
      }
      state.save();
    }
  }

  log('\n[Phase 1b] Done.\n');

  // ── Phase 1c: board_relation (Connect Boards) columns ────────────────────
  // Each bidirectional pair (Board A col → Board B, Board B col → Board A) is
  // created ONCE with allowCreateReflectionColumn: true. After creation we find
  // the auto-created reflection column on the connected target board and map the
  // counterpart source column to it, so Phase 1c skips it when it's encountered.
  log('\n═══ Phase 1c: Creating board_relation columns ═══\n');

  const allSrcBoards = [...sourceBoards, ...srcSubitemBoards];
  const srcBoardById = {};
  for (const b of allSrcBoards) srcBoardById[b.id] = b;

  // Lazy-fetched cache of all target boards (invalidated after each column creation)
  let tgtBoardsCache = null;
  async function fetchTgtBoards() {
    tgtBoardsCache = await targetClient.getAllBoardsInWorkspace(targetWorkspace);
    return tgtBoardsCache;
  }

  for (const srcBoard of allSrcBoards) {
    const srcBoardId = srcBoard.id;
    const tgtBoardId = state.boards[srcBoardId];
    if (!tgtBoardId) continue;

    const relCols = (srcBoard.columns || []).filter(c => c.type === 'board_relation');
    if (relCols.length === 0) continue;

    for (const col of relCols) {
      const colKey = `${srcBoardId}:${col.id}`;
      if (state.columns[colKey] !== undefined) continue; // already created or mapped as reflection

      let srcBoardIds = [];
      try {
        const settings = JSON.parse(col.settings_str || '{}');
        srcBoardIds = (settings.boardIds || []).map(String);
      } catch {}

      const tgtBoardIds = srcBoardIds.map(id => state.boards[id]).filter(Boolean);

      if (tgtBoardIds.length === 0) {
        log(`  [column] "${col.title}" — could not resolve target boards, skipping`);
        state.columns[colKey] = null;
        state.save();
        continue;
      }

      log(`  [column] "${col.title}" (board_relation) → [${tgtBoardIds.join(', ')}]...`);
      let tgtColId = null;
      if (dryRun) {
        tgtColId = `dry-col-${col.id}`;
      } else {
        try {
          tgtColId = await targetClient.createColumn(tgtBoardId, col.title, 'board_relation', { boardIds: tgtBoardIds });
          log(`  [column]   → ${tgtColId}`);
          tgtBoardsCache = null; // invalidate so we re-fetch to see new reflection
        } catch (e) {
          log(`  [column]   WARN: ${e.message}`);
        }
      }
      state.columns[colKey] = tgtColId;
      state.save();

      // Map counterpart columns (on connected boards) to the auto-created reflection
      if (tgtColId && !dryRun) {
        for (const connSrcBoardId of srcBoardIds) {
          const connTgtBoardId = state.boards[connSrcBoardId];
          if (!connTgtBoardId) continue;

          const connBoard = srcBoardById[connSrcBoardId];
          if (!connBoard) continue;

          // Find source counterpart columns: board_relation cols on connBoard pointing back to srcBoard
          const counterparts = (connBoard.columns || []).filter(c => {
            if (c.type !== 'board_relation') return false;
            try {
              const s = JSON.parse(c.settings_str || '{}');
              return (s.boardIds || []).map(String).includes(srcBoardId);
            } catch { return false; }
          }).filter(c => state.columns[`${connSrcBoardId}:${c.id}`] === undefined);

          if (!counterparts.length) continue;

          // Fetch target connected board to find the auto-created reflection column
          const tgtBoards = await fetchTgtBoards();
          const tgtConnBoard = tgtBoards.find(b => String(b.id) === String(connTgtBoardId));
          if (!tgtConnBoard) continue;

          // Reflection column: board_relation on tgtConnBoard with boardIds=[tgtBoardId]
          const reflCols = (tgtConnBoard.columns || []).filter(c => {
            if (c.type !== 'board_relation') return false;
            try {
              const s = JSON.parse(c.settings_str || '{}');
              return (s.boardIds || []).map(String).includes(String(tgtBoardId));
            } catch { return false; }
          });

          if (reflCols.length === 1) {
            const reflId = reflCols[0].id;
            for (const cp of counterparts) {
              const cpKey = `${connSrcBoardId}:${cp.id}`;
              state.columns[cpKey] = reflId;
              log(`  [column]   reflection mapped: "${cp.title}" on ${connBoard.name} → ${reflId}`);
            }
            state.save();
          } else {
            log(`  [column]   WARN: ${reflCols.length} reflection candidates on ${tgtConnBoard.name}, skipping`);
          }
        }
      }
    }
  }

  log('\n[Phase 1c] Done.\n');

  if (schemaOnly) { log('\n[Schema-only mode] Stopping after Phase 1c.\n'); return; }

  // ── Phase 2: Items + subitems ─────────────────────────────────────────────
  // board_relation values are skipped here — connected in Phase 3.
  // Order doesn't matter: no cross-board references are set during creation.
  log('\n═══ Phase 2: Copying items and subitems ═══\n');

  const subBoardByParentName = {};
  for (const sub of srcSubitemBoards) {
    const parentName = sub.name.replace(/^subitems\s+of\s+/i, '').trim().toLowerCase();
    subBoardByParentName[parentName] = sub;
  }

  for (const srcBoard of sourceBoards) {
    const srcBoardId = srcBoard.id;
    const tgtBoardId = state.boards[srcBoardId];
    if (!tgtBoardId) { log(`  [board] SKIP "${srcBoard.name}" — not in state`); continue; }

    log(`\n  [board] "${srcBoard.name}" → fetching items...`);

    const colTypeMap = {};
    for (const col of (srcBoard.columns || [])) colTypeMap[col.id] = col.type;

    const srcSubBoard   = subBoardByParentName[srcBoard.name.toLowerCase()];
    const subColTypeMap = {};
    if (srcSubBoard) {
      for (const col of (srcSubBoard.columns || [])) subColTypeMap[col.id] = col.type;
    }
    const srcSubBoardId = srcSubBoard ? srcSubBoard.id : null;

    // Collect all items first (fast pass) to avoid cursor expiry during slow processing
    const allItems = await reader.getAllBoardItems(srcBoardId);
    log(`  [board] "${srcBoard.name}" → ${allItems.length} items to process`);

    let itemCount = 0;
    for (const item of allItems) {
      if (itemLimit && itemCount >= itemLimit) break;
      const srcItemId = item.id;
      itemCount++;

      if (!state.items[srcItemId]) {
        const grpKey   = `${srcBoardId}:${item.group.id}`;
        const tgtGrpId = state.groups[grpKey] || null;
        const colVals  = buildColumnValues(item.column_values, colTypeMap, srcBoardId, state);

        let tgtItemId;
        if (dryRun) {
          tgtItemId = `dry-item-${srcItemId}`;
          log(`    [item] "${item.name}"...`);
        } else {
          const { result, ms } = await T.track('item_create', () =>
            targetClient.createItem(tgtBoardId, tgtGrpId, item.name, colVals));
          tgtItemId = result;
          log(`    [item] "${item.name}" → ${tgtItemId} (${ms}ms)`);
        }
        state.items[srcItemId] = tgtItemId;
        state.save();
      }

      const tgtItemId = state.items[srcItemId];

      for (const sub of (item.subitems || [])) {
        if (state.items[sub.id]) continue;
        const subColVals = srcSubBoardId
          ? buildColumnValues(sub.column_values, subColTypeMap, srcSubBoardId, state)
          : {};
        let tgtSubId;
        if (dryRun) {
          tgtSubId = `dry-sub-${sub.id}`;
          log(`      [subitem] "${sub.name}"...`);
        } else {
          const { result, ms } = await T.track('subitem_create', () =>
            targetClient.createSubitem(tgtItemId, sub.name, subColVals));
          tgtSubId = result.id;
          log(`      [subitem] "${sub.name}" → ${tgtSubId} (${ms}ms)`);
        }
        state.items[sub.id] = tgtSubId;
        state.save();
      }

      // ── Updates (comments) + file attachments ────────────────────────────
      if (!dryRun && !state.updates[srcItemId]) {
        try {
          const { result: updates, ms: fetchMs } = await T.track('fetch_updates', () =>
            reader.getItemUpdates(srcItemId));
          if (updates.length > 0) log(`    [updates] fetched ${updates.length} update(s) (${fetchMs}ms)`);

          // Copy in chronological order (API returns newest first)
          for (const upd of [...updates].reverse()) {
            const ts   = upd.created_at ? new Date(upd.created_at).toLocaleString() : '';
            const who  = upd.creator ? upd.creator.name : 'Unknown';
            const body = `**${who}** _(${ts})_\n\n${upd.body || ''}`;
            let tgtUpd;
            try {
              const { result, ms } = await T.track('update_create', () =>
                targetClient.createUpdate(tgtItemId, body));
              tgtUpd = result;
              log(`      [update] by ${who} → ${tgtUpd.id} (${ms}ms)`);
            } catch (e) {
              log(`      [update] WARN create: ${e.message.slice(0, 80)}`);
              continue;
            }
            // Upload file attachments
            for (const asset of (upd.assets || [])) {
              try {
                const { result: buf, ms: dlMs } = await T.track('file_download', () =>
                  reader.downloadAsset(asset.url, sourceToken));
                const { ms: ulMs } = await T.track('file_upload', () =>
                  targetClient.uploadFileToUpdate(tgtUpd.id, buf, asset.name || 'file'));
                log(`      [file] "${asset.name}" dl:${dlMs}ms ul:${ulMs}ms`);
              } catch (e) {
                log(`      [file] WARN "${asset.name}": ${e.message.slice(0, 80)}`);
              }
            }
          }
        } catch (e) {
          log(`    [updates] WARN: ${e.message.slice(0, 80)}`);
        }
        state.updates[srcItemId] = true;
        state.save();
      }
    }

    log(`  [board] "${srcBoard.name}" — ${itemCount} items processed`);
  }

  log('\n[Phase 2] Done.\n');

  // ── Phase 3: Connect board_relation values ────────────────────────────────
  // All items exist — order doesn't matter, wire all connections.
  if (!dryRun) {
    log('\n═══ Phase 3: Connecting board_relation values ═══\n');

    for (const srcBoard of [...sourceBoards, ...srcSubitemBoards]) {
      const srcBoardId = srcBoard.id;
      const tgtBoardId = state.boards[srcBoardId];
      if (!tgtBoardId) continue;

      const relCols = (srcBoard.columns || []).filter(c => c.type === 'board_relation');
      const mappedRelCols = relCols
        .map(c => ({ srcColId: c.id, tgtColId: state.columns[`${srcBoardId}:${c.id}`] }))
        .filter(x => x.tgtColId);

      if (mappedRelCols.length === 0) continue;

      log(`\n  [board] "${srcBoard.name}" → remapping board_relation values...`);

      const boardItems = await reader.getAllBoardItems(srcBoardId);
      for (const item of boardItems) {
        const tgtItemId = state.items[item.id];
        if (!tgtItemId) continue;

        for (const { srcColId, tgtColId } of mappedRelCols) {
          const cv = (item.column_values || []).find(c => c.id === srcColId);
          // Use linked_item_ids from BoardRelationValue inline fragment (cv.value is always null)
          const srcIds = cv.linked_item_ids || [];
          if (srcIds.length === 0) continue;

          try {
            const linkedPulseIds = srcIds
              .map(srcId => {
                const tgtId = state.items[String(srcId)];
                return tgtId ? { linkedPulseId: Number(tgtId) } : null;
              })
              .filter(Boolean);

            if (linkedPulseIds.length === 0) continue;

            const { ms } = await T.track('board_relation_set', () =>
              targetClient.changeColumnValue(tgtBoardId, tgtItemId, tgtColId, { linkedPulseIds }));
            log(`    [relation] "${item.name}" [${srcColId}] → ${linkedPulseIds.length} link(s) (${ms}ms)`);
          } catch (e) {
            log(`    [relation] WARN: ${e.message}`);
          }
        }
      }
    }

    log('\n[Phase 3] Done.\n');
  }

  T.summary(log);
}

module.exports = { run };
