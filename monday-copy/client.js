'use strict';
const axios        = require('axios');
const MondayClient = require('../src/monday/client');

const MONDAY_API = 'https://api.monday.com/v2';

/**
 * CopyClient — extends the base MondayClient with write/admin operations
 * needed only for the Monday→Monday workspace copy tool.
 */
class CopyClient extends MondayClient {
  constructor(token, dryRun = false) {
    super(token, dryRun);
    // Recreate http client with newer API version (board_relation requires 2025-01+)
    this.http = axios.create({
      baseURL: MONDAY_API,
      headers: {
        Authorization:  token,
        'Content-Type': 'application/json',
        'API-Version':  '2025-01',
      },
      timeout: 120000,
    });
  }

  // Returns { id, name, columns } for ALL boards in a workspace
  // (including auto-created "Subitems of …" boards)
  async getAllBoardsInWorkspace(workspaceId) {
    const all = [];
    let page = 1;
    while (true) {
      const data = await this.query(`
        query($wsId: [ID!]!, $page: Int!) {
          boards(workspace_ids: $wsId, limit: 100, page: $page) {
            id name
            columns { id title type settings_str }
          }
        }
      `, { wsId: [String(workspaceId)], page });
      const boards = data.boards || [];
      all.push(...boards);
      if (boards.length < 100) break;
      page++;
    }
    return all;
  }

  async createBoard(name, workspaceId, boardKind = 'public') {
    if (this.dryRun) return `dry-run-board-${name}`;
    const data = await this.query(`
      mutation($name: String!, $wsId: ID!, $kind: BoardKind!) {
        create_board(board_name: $name, workspace_id: $wsId, board_kind: $kind) { id }
      }
    `, { name, wsId: String(workspaceId), kind: boardKind });
    return data.create_board.id;
  }

  async createColumn(boardId, title, columnType, defaults = null) {
    if (this.dryRun) return `dry-run-col-${title}`;

    // board_relation (Connect Boards) requires:
    //   1. Inline defaults object (not a JSON string variable)
    //   2. NO variables field in the HTTP body
    //   3. NO API-Version header (2025-01 changed the defaults type and breaks inline objects)
    // This matches the curl approach that is confirmed to work.
    if (columnType === 'board_relation' && defaults) {
      const boardIdsList = (defaults.boardIds || []).join(', ');
      const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const gql = `mutation { create_column(board_id: ${boardId}, title: "${escapedTitle}", column_type: board_relation, defaults: {boardIds: [${boardIdsList}], allowMultipleItems: true, allowCreateReflectionColumn: true}) { id } }`;
      // Use a plain axios call — no API-Version header, no variables key
      const res = await axios.post(MONDAY_API, { query: gql }, {
        headers: { Authorization: this.token, 'Content-Type': 'application/json' },
        timeout: 120000,
      });
      if (res.data.errors && res.data.errors.length > 0) {
        throw new Error(`Monday API error: ${JSON.stringify(res.data.errors)}`);
      }
      return res.data.data.create_column.id;
    }

    const vars = { boardId: String(boardId), title, columnType };
    let mutation;
    if (defaults) {
      vars.defaults = JSON.stringify(defaults);
      mutation = `
        mutation($boardId: ID!, $title: String!, $columnType: ColumnType!, $defaults: JSON) {
          create_column(board_id: $boardId, title: $title, column_type: $columnType, defaults: $defaults) { id }
        }
      `;
    } else {
      mutation = `
        mutation($boardId: ID!, $title: String!, $columnType: ColumnType!) {
          create_column(board_id: $boardId, title: $title, column_type: $columnType) { id }
        }
      `;
    }
    const data = await this.query(mutation, vars);
    return data.create_column.id;
  }

  async changeColumnValue(boardId, itemId, columnId, value) {
    if (this.dryRun) return;
    await this.query(`
      mutation($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $colId, value: $val) { id }
      }
    `, {
      boardId:  String(boardId),
      itemId:   String(itemId),
      colId:    columnId,
      val:      JSON.stringify(value),
    });
  }

  async changeSimpleColumnValue(boardId, itemId, columnId, value) {
    if (this.dryRun) return;
    await this.query(`
      mutation($boardId: ID!, $itemId: ID!, $colId: String!, $val: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $colId, value: $val) { id }
      }
    `, {
      boardId:  String(boardId),
      itemId:   String(itemId),
      colId:    columnId,
      val:      String(value),
    });
  }

  async deleteItem(itemId) {
    if (this.dryRun) return;
    await this.query(`
      mutation($id: ID!) { delete_item(item_id: $id) { id } }
    `, { id: String(itemId) });
  }
}

module.exports = CopyClient;
