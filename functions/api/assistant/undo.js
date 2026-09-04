import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);

  try {
    const { undoToken } = await request.json();
    const token = String(undoToken || '').trim();
    if (!token) return errorResponse('缺少撤销令牌', 400);

    const key = `assistant_undo_${token}`;
    const raw = await env.NAV_AUTH.get(key);
    if (!raw) return errorResponse('撤销记录不存在或已过期', 404);

    const payload = JSON.parse(raw);
    const snapshots = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
    if (!snapshots.length) return errorResponse('撤销记录为空', 400);

    const statements = snapshots.map(site => env.NAV_DB.prepare(`
      UPDATE sites
      SET name = ?, url = ?, desc = ?, catelog_id = ?, catelog_name = ?, is_private = ?, update_time = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      site.name,
      site.url,
      site.desc,
      site.catelog_id,
      site.catelog_name,
      site.is_private || 0,
      site.id
    ));

    await env.NAV_DB.batch(statements);
    await env.NAV_AUTH.delete(key);
    await markHomeCacheDirty(env, 'all');

    return jsonResponse({ code: 200, message: `已撤销 ${snapshots.length} 条书签的修改` });
  } catch (error) {
    console.error('Assistant undo failed:', error);
    return errorResponse(`撤销失败: ${error.message}`, 500);
  }
}
