import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';
import { normalizeBookmarkName, normalizeBookmarkDesc, normalizeCategoryName } from '../../lib/validators';

const MAX_ACTIONS = 250;
const BATCH_SIZE = 50;
const UNDO_TTL = 7 * 24 * 60 * 60;

function normalizeText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function executeBatches(db, statements) {
  for (const group of chunks(statements, BATCH_SIZE)) {
    if (group.length) await db.batch(group);
  }
}

async function createOrReuseCategory(env, raw, refMap, categoryMap, createdCategoryIds) {
  const tempKey = normalizeText(raw?.tempKey, 80);
  if (!/^[a-zA-Z0-9_-]{2,80}$/.test(tempKey)) return null;

  const normalizedName = normalizeCategoryName(raw?.name);
  if (!normalizedName.ok) return null;

  let parentId = Number.parseInt(raw?.parentId, 10) || 0;
  const parentRef = normalizeText(raw?.parentRef, 80);
  if (parentRef) {
    parentId = Number(refMap.get(parentRef) || 0);
    if (!parentId) return null;
  }
  if (parentId > 0 && !categoryMap.has(parentId)) return null;

  const existing = await env.NAV_DB.prepare(`
    SELECT id, catelog, parent_id, is_private
    FROM category
    WHERE LOWER(catelog) = LOWER(?) AND COALESCE(parent_id, 0) = ?
    LIMIT 1
  `).bind(normalizedName.value, parentId).first();

  if (existing) {
    const id = Number(existing.id);
    refMap.set(tempKey, id);
    categoryMap.set(id, existing);
    return { id, name: existing.catelog, reused: true };
  }

  const isPrivate = Number(raw?.isPrivate) === 1 ? 1 : 0;
  const created = await env.NAV_DB.prepare(`
    INSERT INTO category (catelog, sort_order, parent_id, is_private, create_time, update_time)
    VALUES (?, 9999, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id, catelog, parent_id, is_private
  `).bind(normalizedName.value, parentId, isPrivate).first();

  if (!created?.id) return null;
  const id = Number(created.id);
  refMap.set(tempKey, id);
  categoryMap.set(id, created);
  createdCategoryIds.push(id);
  return { id, name: created.catelog, reused: false };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);

  try {
    if (!env.NAV_DB || !env.NAV_AUTH) return errorResponse('NAV_DB / NAV_AUTH binding not found', 500);

    const { actions } = await request.json();
    if (!Array.isArray(actions) || !actions.length) return errorResponse('没有可执行的变更', 400);
    if (actions.length > MAX_ACTIONS) return errorResponse(`单次最多执行 ${MAX_ACTIONS} 个变更`, 400);

    const siteIds = [...new Set(actions
      .filter(action => action?.type !== 'create_category')
      .map(action => Number.parseInt(action?.siteId, 10))
      .filter(value => Number.isFinite(value) && value > 0))];

    let sites = [];
    if (siteIds.length) {
      const placeholders = siteIds.map(() => '?').join(',');
      const query = await env.NAV_DB.prepare(`
        SELECT id, name, url, desc, catelog_id, catelog_name, is_private
        FROM sites WHERE id IN (${placeholders})
      `).bind(...siteIds).all();
      sites = query.results || [];
    }
    const siteMap = new Map(sites.map(site => [Number(site.id), site]));

    const categoryQuery = await env.NAV_DB.prepare('SELECT id, catelog, parent_id, is_private FROM category').all();
    const categoryMap = new Map((categoryQuery.results || []).map(category => [Number(category.id), category]));
    const refMap = new Map();
    const createdCategoryIds = [];
    const createdCategoryNames = [];

    // 分类必须先落库，后续 move_bookmark 才能通过 categoryRef 引用真实 ID。
    for (const raw of actions) {
      if (raw?.type !== 'create_category') continue;
      const created = await createOrReuseCategory(env, raw, refMap, categoryMap, createdCategoryIds);
      if (created && !created.reused) createdCategoryNames.push(created.name);
    }

    const valid = [];
    for (const raw of actions) {
      const type = raw?.type;
      if (type === 'create_category') continue;

      const siteId = Number.parseInt(raw?.siteId, 10);
      if (!siteMap.has(siteId)) continue;

      if (type === 'rename_bookmark') {
        const normalized = normalizeBookmarkName(raw?.name);
        if (normalized.ok && normalized.value !== siteMap.get(siteId).name) {
          valid.push({ type, siteId, name: normalized.value });
        }
        continue;
      }

      if (type === 'update_description') {
        const normalized = normalizeBookmarkDesc(raw?.description);
        if (normalized.ok && normalized.value && normalized.value !== (siteMap.get(siteId).desc || '')) {
          valid.push({ type, siteId, description: normalized.value });
        }
        continue;
      }

      if (type === 'move_bookmark') {
        let categoryId = Number.parseInt(raw?.categoryId, 10) || 0;
        const categoryRef = normalizeText(raw?.categoryRef, 80);
        if (!categoryId && categoryRef) categoryId = Number(refMap.get(categoryRef) || 0);
        if (categoryId && categoryMap.has(categoryId) && categoryId !== Number(siteMap.get(siteId).catelog_id)) {
          valid.push({ type, siteId, categoryId });
        }
      }
    }

    if (!valid.length && !createdCategoryIds.length) {
      return errorResponse('没有通过校验的变更', 400);
    }

    const affectedSiteIds = [...new Set(valid.map(action => action.siteId))];
    const snapshots = affectedSiteIds.map(id => siteMap.get(id)).filter(Boolean);
    const statements = [];

    for (const action of valid) {
      if (action.type === 'rename_bookmark') {
        statements.push(
          env.NAV_DB.prepare('UPDATE sites SET name = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?')
            .bind(action.name, action.siteId)
        );
      } else if (action.type === 'update_description') {
        statements.push(
          env.NAV_DB.prepare('UPDATE sites SET desc = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?')
            .bind(action.description, action.siteId)
        );
      } else if (action.type === 'move_bookmark') {
        const category = categoryMap.get(action.categoryId);
        statements.push(env.NAV_DB.prepare(`
          UPDATE sites
          SET catelog_id = ?, catelog_name = ?,
              is_private = CASE WHEN ? = 1 THEN 1 ELSE is_private END,
              update_time = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(action.categoryId, category.catelog, Number(category.is_private) || 0, action.siteId));
      }
    }

    await executeBatches(env.NAV_DB, statements);
    await markHomeCacheDirty(env, 'all');

    const undoToken = crypto.randomUUID();
    await env.NAV_AUTH.put(
      `assistant_undo_${undoToken}`,
      JSON.stringify({ snapshots, createdCategoryIds }),
      { expirationTtl: UNDO_TTL }
    );

    const applied = valid.length + createdCategoryIds.length;
    return jsonResponse({
      code: 200,
      message: `已执行 ${applied} 个变更${createdCategoryNames.length ? `，新建 ${createdCategoryNames.length} 个分类` : ''}`,
      data: {
        applied,
        changedBookmarks: valid.length,
        createdCategories: createdCategoryNames,
        undoToken,
      },
    });
  } catch (error) {
    console.error('Assistant apply failed:', error);
    return errorResponse(`执行失败: ${error.message}`, 500);
  }
}
