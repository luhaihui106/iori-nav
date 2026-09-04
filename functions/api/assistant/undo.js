import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';

const BATCH_SIZE = 50;

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function restoreSnapshots(db, snapshots) {
  const statements = snapshots.map(site => db.prepare(`
    UPDATE sites
    SET name = ?, url = ?, desc = ?, catelog_id = ?, catelog_name = ?, is_private = ?, update_time = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    site.name,
    site.url,
    site.desc,
    site.catelog_id,
    site.catelog_name,
    Number(site.is_private) || 0,
    site.id
  ));

  for (const group of chunks(statements, BATCH_SIZE)) {
    if (group.length) await db.batch(group);
  }
}

async function removeCreatedCategoriesIfUnused(db, categoryIds) {
  let removed = 0;
  // 子分类先删，避免父分类因为仍有 child 而无法清理。
  for (const id of [...categoryIds].reverse()) {
    const categoryId = Number.parseInt(id, 10);
    if (!categoryId) continue;

    const usage = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sites WHERE catelog_id = ?) AS site_count,
        (SELECT COUNT(*) FROM category WHERE parent_id = ?) AS child_count
    `).bind(categoryId, categoryId).first();

    if (Number(usage?.site_count || 0) === 0 && Number(usage?.child_count || 0) === 0) {
      await db.prepare('DELETE FROM category WHERE id = ?').bind(categoryId).run();
      removed++;
    }
  }
  return removed;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);

  try {
    if (!env.NAV_DB || !env.NAV_AUTH) return errorResponse('NAV_DB / NAV_AUTH binding not found', 500);

    const { undoToken } = await request.json();
    const token = String(undoToken || '').trim();
    if (!token) return errorResponse('缺少撤销令牌', 400);

    const key = `assistant_undo_${token}`;
    const raw = await env.NAV_AUTH.get(key);
    if (!raw) return errorResponse('撤销记录不存在或已过期', 404);

    const payload = JSON.parse(raw);
    const snapshots = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
    const createdCategoryIds = Array.isArray(payload?.createdCategoryIds) ? payload.createdCategoryIds : [];
    if (!snapshots.length && !createdCategoryIds.length) return errorResponse('撤销记录为空', 400);

    if (snapshots.length) await restoreSnapshots(env.NAV_DB, snapshots);
    const removedCategories = createdCategoryIds.length
      ? await removeCreatedCategoriesIfUnused(env.NAV_DB, createdCategoryIds)
      : 0;

    await env.NAV_AUTH.delete(key);
    await markHomeCacheDirty(env, 'all');

    return jsonResponse({
      code: 200,
      message: `已撤销 ${snapshots.length} 条书签修改${removedCategories ? `，并清理 ${removedCategories} 个本次新建的空分类` : ''}`,
    });
  } catch (error) {
    console.error('Assistant undo failed:', error);
    return errorResponse(`撤销失败: ${error.message}`, 500);
  }
}
