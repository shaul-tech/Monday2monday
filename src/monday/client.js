'use strict';
const axios    = require('axios');
const FormData = require('form-data');

const MONDAY_API = 'https://api.monday.com/v2';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Queued rate limiter: ensures at least `delayMs` between consecutive requests,
// even when multiple callers are awaiting concurrently.
// Each throttle() call chains onto the previous one — requests form a FIFO queue
// with a minimum gap, so total throughput ≤ 1000/delayMs req/s globally.
class QueuedRateLimiter {
  constructor(delayMs) {
    this.delayMs = delayMs;
    this._last   = Promise.resolve();
  }
  throttle() {
    const next  = this._last.then(() => sleep(this.delayMs));
    this._last  = next;
    return next;
  }
}

class MondayClient {
  constructor(token, dryRun = false) {
    this.token   = token;
    this.dryRun  = dryRun;
    this._limiter = new QueuedRateLimiter(100); // ~10 req/s (Monday allows much more)
    this.http    = axios.create({
      baseURL: MONDAY_API,
      headers: {
        Authorization:  token,
        'Content-Type': 'application/json',
        'API-Version':  '2024-01',
      },
      timeout: 120000,
    });
  }

  async query(gql, variables = {}) {
    await this._limiter.throttle();
    const res = await this.http.post('', { query: gql, variables });
    if (res.data.errors && res.data.errors.length > 0) {
      throw new Error(`Monday API error: ${JSON.stringify(res.data.errors)}`);
    }
    return res.data.data;
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async createGroup(boardId, groupName) {
    if (this.dryRun) return `dry-run-group-${groupName}`;
    const data = await this.query(`
      mutation($boardId: ID!, $name: String!) {
        create_group(board_id: $boardId, group_name: $name) { id }
      }
    `, { boardId: String(boardId), name: groupName });
    return data.create_group.id;
  }

  async getGroups(boardId) {
    const data = await this.query(`
      query($boardId: [ID!]!) {
        boards(ids: $boardId) {
          groups { id title }
        }
      }
    `, { boardId: [String(boardId)] });
    return data.boards[0].groups; // [{ id, title }]
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  async createItem(boardId, groupId, name, columnValues = {}) {
    if (this.dryRun) return `dry-run-item-${name}`;
    const data = await this.query(`
      mutation($boardId: ID!, $groupId: String!, $name: String!, $vals: JSON!) {
        create_item(board_id: $boardId, group_id: $groupId,
                    item_name: $name, column_values: $vals,
                    create_labels_if_missing: true) { id }
      }
    `, {
      boardId: String(boardId),
      groupId,
      name,
      vals: JSON.stringify(columnValues),
    });
    return data.create_item.id;
  }

  async createSubitem(parentItemId, name, columnValues = {}) {
    if (this.dryRun) return `dry-run-subitem-${name}`;
    const data = await this.query(`
      mutation($parentId: ID!, $name: String!, $vals: JSON!) {
        create_subitem(parent_item_id: $parentId,
                       item_name: $name, column_values: $vals,
                       create_labels_if_missing: true) { id board { id } }
      }
    `, {
      parentId: String(parentItemId),
      name,
      vals: JSON.stringify(columnValues),
    });
    return {
      id:      data.create_subitem.id,
      boardId: data.create_subitem.board.id,
    };
  }

  // ── Search / idempotency ──────────────────────────────────────────────────

  async findItemByName(boardId, name) {
    // In dry-run mode, treat Monday as empty (always return null → "would create")
    if (this.dryRun) return null;
    const data = await this.query(`
      query($boardId: ID!, $name: String!) {
        items_page_by_column_values(
          limit: 1,
          board_id: $boardId,
          columns: [{ column_id: "name", column_values: [$name] }]
        ) {
          items { id name }
        }
      }
    `, { boardId: String(boardId), name });
    const items = data.items_page_by_column_values.items;
    return items.length > 0 ? items[0].id : null;
  }

  // Find a subitem by name under a specific parent item
  async findSubitemByName(parentItemId, name) {
    // In dry-run mode, treat Monday as empty (always return null → "would create")
    if (this.dryRun) return null;
    const data = await this.query(`
      query($id: [ID!]!) {
        items(ids: $id) {
          subitems { id name }
        }
      }
    `, { id: [String(parentItemId)] });
    if (!data.items || !data.items[0]) return null;
    const sub = (data.items[0].subitems || []).find(s => s.name === name);
    return sub ? sub.id : null;
  }

  // ── Updates (comments) ───────────────────────────────────────────────────

  async createUpdate(itemId, body) {
    if (this.dryRun) return { id: `dry-run-update-${itemId}` };
    const data = await this.query(`
      mutation($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) { id }
      }
    `, { itemId: String(itemId), body });
    return data.create_update;
  }

  // ── File uploads ────────────────────────────────────────────────────────

  async uploadFileToUpdate(updateId, fileBuffer, fileName) {
    if (this.dryRun) return { id: `dry-run-file-${fileName}` };
    await this._limiter.throttle();

    const form = new FormData();
    form.append('query',
      `mutation ($file: File!) { add_file_to_update(update_id: ${updateId}, file: $file) { id } }`);
    form.append('map', JSON.stringify({ image: 'variables.file' }));
    form.append('image', fileBuffer, { filename: fileName });

    const res = await axios.post(`${MONDAY_API}/file`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: this.token,
        'API-Version':  '2024-01',
      },
      timeout: 60000,
    });

    if (res.data.errors && res.data.errors.length > 0) {
      throw new Error(`Monday file upload error: ${JSON.stringify(res.data.errors)}`);
    }
    return res.data.data ? res.data.data.add_file_to_update : null;
  }

  // ── Column value helpers ──────────────────────────────────────────────────

  static statusValue(label) {
    return { label };
  }

  static dateValue(isoDate) {
    // Wrike may return 'YYYY-MM-DDTHH:MM:SS' — Monday needs 'YYYY-MM-DD' only
    const dateOnly = isoDate ? isoDate.substring(0, 10) : isoDate;
    return { date: dateOnly };
  }

  static peopleValue(mondayUserIds) {
    if (!mondayUserIds || mondayUserIds.length === 0) return {};
    return {
      personsAndTeams: mondayUserIds.map(id => ({ id: Number(id), kind: 'person' })),
    };
  }

  static boardRelationValue(itemIds) {
    if (!itemIds || itemIds.length === 0) return {};
    return { item_ids: itemIds.map(Number) };
  }

  // ── Column mutations ─────────────────────────────────────────────────────

  async changeColumnValue(boardId, itemId, columnId, value) {
    if (this.dryRun) return itemId;
    const data = await this.query(`
      mutation($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $colId, value: $val) { id }
      }
    `, { boardId: String(boardId), itemId: String(itemId), colId: columnId, val: JSON.stringify(value) });
    return data.change_column_value.id;
  }

}

module.exports = MondayClient;
