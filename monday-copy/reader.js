'use strict';

/**
 * MondayReader — reads a Monday workspace (source account) for copying.
 * Uses a CopyClient instance (token must be for the source account).
 *
 * IMPORTANT: Read-only. Never writes or deletes anything.
 */
class MondayReader {
  constructor(copyClient, logger) {
    this.client = copyClient;
    this.log    = logger || console.log;
  }

  // ── Workspace / Boards ────────────────────────────────────────────────────

  async getWorkspaceBoards(workspaceId, folderId = null) {
    const folderNote = folderId ? ` (folder ${folderId})` : '';
    this.log(`[Reader] Fetching boards in workspace ${workspaceId}${folderNote}...`);

    // If folder filter: use folders.children which returns boards directly
    if (folderId) {
      const folderData = await this.client.query(`
        query($ids: [ID!]!) {
          folders(ids: $ids) {
            id name
            children {
              id name description board_kind
              workspace { id name }
              columns { id title type settings_str }
              groups   { id title color position }
            }
          }
        }
      `, { ids: [String(folderId)] });
      const folder = (folderData.folders || [])[0];
      if (!folder) throw new Error(`Folder ${folderId} not found`);
      const boards = (folder.children || []).filter(b => !b.name.toLowerCase().includes('subitems'));
      this.log(`[Reader] Folder "${folder.name}": ${boards.length} boards`);
      return boards;
    }

    const all = [];
    let page = 1;
    while (true) {
      const data = await this.client.query(`
        query($wsId: [ID!]!, $page: Int!) {
          boards(workspace_ids: $wsId, limit: 100, page: $page,
                 board_kind: public, order_by: created_at) {
            id name description board_kind
            workspace { id name }
            columns { id title type settings_str }
            groups   { id title color position }
          }
        }
      `, { wsId: [String(workspaceId)], page });
      const boards = data.boards || [];
      all.push(...boards);
      if (boards.length < 100) break;
      page++;
    }
    const nonSubitem = all.filter(b => !b.name.toLowerCase().includes('subitems'));
    this.log(`[Reader] Found ${all.length} boards (${nonSubitem.length} non-subitem)`);
    return nonSubitem;
  }

  // Returns subitems boards (the auto-created companion boards) with their columns
  async getSubitemBoards(workspaceId) {
    const all = await this.client.getAllBoardsInWorkspace(workspaceId);
    return all.filter(b => b.name.toLowerCase().includes('subitems'));
  }

  // ── Items (paginated) ─────────────────────────────────────────────────────

  /**
   * Async generator that yields items page by page.
   * Each item: { id, name, group { id }, column_values [{ id, value, text }],
   *              subitems [{ id, name, column_values }] }
   */
  async *iterateBoardItems(boardId) {
    let cursor = null;
    while (true) {
      let data;
      if (!cursor) {
        data = await this.client.query(`
          query($boardId: ID!) {
            boards(ids: [$boardId]) {
              items_page(limit: 50) {
                cursor
                items {
                  id name
                  group { id }
                  column_values { id type value text ... on BoardRelationValue { linked_item_ids } }
                  subitems {
                    id name
                    column_values { id type value text ... on BoardRelationValue { linked_item_ids } }
                  }
                }
              }
            }
          }
        `, { boardId: String(boardId) });
        const page = data.boards[0].items_page;
        cursor = page.cursor;
        for (const item of page.items) yield item;
        if (!cursor) break;
      } else {
        data = await this.client.query(`
          query($cursor: String!) {
            next_items_page(limit: 50, cursor: $cursor) {
              cursor
              items {
                id name
                group { id }
                column_values { id type value text ... on BoardRelationValue { linked_item_ids } }
                subitems {
                  id name
                  column_values { id type value text ... on BoardRelationValue { linked_item_ids } }
                }
              }
            }
          }
        `, { cursor });
        const page = data.next_items_page;
        cursor = page.cursor;
        for (const item of page.items) yield item;
        if (!cursor) break;
      }
    }
  }

  // ── Updates (comments) ────────────────────────────────────────────────────

  async getItemUpdates(itemId) {
    const data = await this.client.query(`
      query($id: [ID!]!) {
        items(ids: $id) {
          updates(limit: 100) {
            id body
            creator { id name }
            created_at
            assets { id url name file_extension }
          }
        }
      }
    `, { id: [String(itemId)] });
    if (!data.items || !data.items[0]) return [];
    return data.items[0].updates || [];
  }

  // Download a file asset from Monday (requires source token auth)
  async downloadAsset(url, sourceToken) {
    const axios = require('axios');
    const res = await axios.get(url, {
      headers: { Authorization: sourceToken },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(res.data);
  }
}

module.exports = MondayReader;
