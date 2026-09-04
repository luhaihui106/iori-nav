import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';

const MAX_ACTIONS = 100;
const UNDO_TTL = 7 * 24 * 60 * 60;

function normalizeText(value, max) {
  return String(value || '').trim().slice(0, max);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);

  try {
    const { actions } = await request.json();
    if (!Array.isArray(actions) || !actions.length) return errorResponse('没有可执行的变更', 400);
    if (actions.length > MAX_ACTIONS) return errorResponse(`单次最多执行 ${MAX_ACTIONS} 个变更`, 400);

    const siteIds = [...new Set(actions.map(a => Number(a?.siteId)).filter(Number.isFinite))];
    if (!siteIds.length) return errorResponse('书签 ID 无效', 400);

    const placeholders = siteIds.map(() => '?').join(',');
    const { results: sites } = await env.NAV_DB.prepare(`
      SELECT id, name, url, desc, catelog_id, catelog_name, is_private
      FROM sites WHERE id IN (${placeholders})
    `).bind(...siteIds).all();
    const siteMap = new Map((sites || []).map(site => [Number(site.id), site]));

    const { results: categories } = await env.NAV_DB.prepare('SELECT id, catelog, is_private FROM category').all();
    const categoryMap = new Map((categories || []).map(cat => [Number(cat.id), cat]));

    const valid = [];
    for (const raw of actions) {
      const type = raw?.type;
      const siteId = Number(raw?.siteId);
      if (!siteMap.has(siteId)) continue;

      if (type === 'rename_bookmark') {
        const name = normalizeText(raw?.name, 80);
        if (name) valid.push({ type, siteId, name });
      } else if (type === 'update_description') {
        const description = normalizeText(raw?.description, 300);
        if (description) valid.push({ type, siteId, description });
      } else if (type === 'move_bookmark') {
        const categoryId = Number(raw?.categoryId);
        if (categoryMap.has(categoryId)) valid.push({ type, siteId, categoryId });
      }
    }

    if (!valid.length) return errorResponse('没有通过校验的变更', 400);

    const snapshots = siteIds.filter(id => siteMap.has(id)).map(id => siteMap.get(id));
    const statements = [];
    for (const action of valid) {
      if (action.type === 'rename_bookmark') {
        statements.push(env.NAV_DB.prepare('UPDATE sites SET name = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?').bind(action.name, action.siteId));
      } else if (action.type === 'update_description') {
        statements.push(env.NAV_DB.prepare('UPDATE sites SET desc = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?').bind(action.description, action.siteId));
      } else if (action.type === 'move_bookmark') {
        const category = categoryMap.get(action.categoryId);
        statements.push(env.NAV_DB.prepare(`
          UPDATE sites
          SET catelog_id = ?, catelog_name = ?, is_private = CASE WHEN ? = 1 THEN 1 ELSE is_private END,
              update_time = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(action.categoryId, category.catelog, category.is_private || 0, action.siteId));
      }
    }

    await env.NAV_DB.batch(statements);
    await markHomeCacheDirty(env, 'all');

    const undoToken = crypto.randomUUID();
    await env.NAV_AUTH.put(`assistant_undo_${undoToken}`, JSON.stringify({ snapshots }), { expirationTtl: UNDO_TTL });

    return jsonResponse({
      code: 200,
      message: `已执行 ${valid.length} 个变更`,
      data: { applied: valid.length, undoToken }
    });
  } catch (error) {
    console.error('Assistant apply failed:', error);
    return errorResponse(`执行失败: ${error.message}`, 500);
  }
}
