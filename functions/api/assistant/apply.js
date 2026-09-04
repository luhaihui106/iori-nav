import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty, timingSafeEqual } from '../../_middleware';
import { normalizeBookmarkName, normalizeBookmarkDesc, normalizeCategoryName } from '../../lib/validators';

const MAX_ACTIONS = 250;
const BATCH_SIZE = 50;
const UNDO_TTL = 7 * 24 * 60 * 60;
const SESSION_TTL = 7 * 24 * 60 * 60;
const SESSION_PREFIX = 'assistant_session_';
const PREVIEW_CLAIM_PREFIX = 'assistant_preview_claim_';

function normalizeText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function normalizeSessionId(value) {
  const raw = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(raw) ? raw : '';
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

function stripPreviewMeta(action) {
  if (!action || typeof action !== 'object') return null;
  const safe = { ...action };
  delete safe.previewToken;
  delete safe.previewDigest;
  return safe;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function digestActions(actions) {
  return sha256Hex(canonicalize(actions));
}

async function claimPreviewConsumption(env, bound) {
  // KV 的 read -> put 不是 compare-and-swap。这里复用现有 settings(key PRIMARY KEY)
  // 作为 D1 原子消费墓碑：同一个随机 previewToken 只有一个并发请求能插入成功。
  // key 中只保存 token 的 SHA-256，不把实际 previewToken 落入 D1。
  const tokenHash = await sha256Hex(bound?.preview?.token || '');
  if (!tokenHash) throw Object.assign(new Error('预览令牌摘要无效，请重新生成预览'), { status: 409 });

  const claimKey = `${PREVIEW_CLAIM_PREFIX}${tokenHash}`;
  const claimValue = JSON.stringify({
    sessionId: bound.sessionId,
    previewDigest: bound.digest,
    claimedAt: new Date().toISOString(),
  });

  const claimed = await env.NAV_DB.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
    RETURNING key
  `).bind(claimKey, claimValue).first();

  if (!claimed?.key) {
    throw Object.assign(new Error('该预览已被其他请求消费或正在执行，请重新生成预览'), { status: 409 });
  }

  return claimKey;
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
  await executeBatches(db, statements);
}

async function removeCreatedCategoriesIfUnused(db, categoryIds) {
  let removed = 0;
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

async function saveUndoRecord(env, undoToken, payload) {
  await env.NAV_AUTH.put(
    `assistant_undo_${undoToken}`,
    JSON.stringify(payload),
    { expirationTtl: UNDO_TTL }
  );
}

async function loadBoundPreview(env, body) {
  const sessionId = normalizeSessionId(body?.sessionId);
  const clientActions = (Array.isArray(body?.actions) ? body.actions : [])
    .slice(0, MAX_ACTIONS)
    .map(stripPreviewMeta)
    .filter(Boolean);
  const embeddedToken = Array.isArray(body?.actions)
    ? body.actions.map(action => normalizeText(action?.previewToken, 120)).find(Boolean)
    : '';
  const previewToken = normalizeText(body?.previewToken || embeddedToken, 120);

  if (!sessionId) throw Object.assign(new Error('缺少有效会话ID'), { status: 400 });
  if (!previewToken) throw Object.assign(new Error('缺少预览令牌，请重新生成待确认变更'), { status: 409 });

  const key = `${SESSION_PREFIX}${sessionId}`;
  const raw = await env.NAV_AUTH.get(key);
  if (!raw) throw Object.assign(new Error('会话不存在或已过期，请重新生成预览'), { status: 409 });

  const session = JSON.parse(raw);
  const preview = session?.preview && typeof session.preview === 'object' ? session.preview : null;
  const storedActions = (Array.isArray(session?.pendingActions) ? session.pendingActions : [])
    .slice(0, MAX_ACTIONS)
    .map(stripPreviewMeta)
    .filter(Boolean);

  if (!preview || preview.status !== 'ready' || !preview.token) {
    throw Object.assign(new Error('当前会话没有可执行的已确认预览，请重新生成'), { status: 409 });
  }
  if (!timingSafeEqual(String(preview.token), previewToken)) {
    throw Object.assign(new Error('预览令牌不匹配或已失效，请重新生成预览'), { status: 409 });
  }
  const expiresAt = Date.parse(preview.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw Object.assign(new Error('预览已过期，请重新生成'), { status: 410 });
  }
  if (!storedActions.length || storedActions.length !== Number(preview.actionCount || 0)) {
    throw Object.assign(new Error('服务器预览动作已变化，请重新生成'), { status: 409 });
  }

  const storedDigest = await digestActions(storedActions);
  if (!preview.digest || !timingSafeEqual(String(preview.digest), storedDigest)) {
    throw Object.assign(new Error('服务器预览摘要校验失败，请重新生成'), { status: 409 });
  }

  if (clientActions.length) {
    if (clientActions.length !== storedActions.length) {
      throw Object.assign(new Error('前端待确认动作数量与服务器预览不一致'), { status: 409 });
    }
    const clientDigest = await digestActions(clientActions);
    if (!timingSafeEqual(clientDigest, storedDigest)) {
      throw Object.assign(new Error('前端待确认动作与服务器预览不一致，已拒绝执行'), { status: 409 });
    }
  }

  return { sessionId, key, session, preview, actions: storedActions, digest: storedDigest };
}

async function consumePreview(env, bound) {
  const now = new Date().toISOString();
  await env.NAV_AUTH.put(bound.key, JSON.stringify({
    ...bound.session,
    updatedAt: now,
    pendingActions: [],
    preview: {
      ...bound.preview,
      token: '',
      status: 'applying',
      consumedAt: now,
    },
  }), { expirationTtl: SESSION_TTL });
}

async function finalizePreview(env, bound, status, extra = {}) {
  const currentRaw = await env.NAV_AUTH.get(bound.key);
  const current = currentRaw ? JSON.parse(currentRaw) : bound.session;
  await env.NAV_AUTH.put(bound.key, JSON.stringify({
    ...current,
    updatedAt: new Date().toISOString(),
    pendingActions: [],
    preview: {
      ...(current?.preview || bound.preview || {}),
      token: '',
      status,
      ...extra,
    },
  }), { expirationTtl: SESSION_TTL });
}

async function createOrReuseCategory(env, raw, refMap, categoryMap, createdCategoryIds, onCreated) {
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
  if (onCreated) await onCreated(id);
  return { id, name: created.catelog, reused: false };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);

  let bound = null;
  let previewClaimed = false;
  let undoToken = '';
  let undoPrepared = false;
  let snapshots = [];
  const createdCategoryIds = [];
  const createdCategoryNames = [];

  try {
    if (!env.NAV_DB || !env.NAV_AUTH) return errorResponse('NAV_DB / NAV_AUTH binding not found', 500);

    const body = await request.json();
    try {
      bound = await loadBoundPreview(env, body);
    } catch (error) {
      return errorResponse(error.message, Number(error.status) || 409);
    }

    const actions = bound.actions;
    if (!Array.isArray(actions) || !actions.length) return errorResponse('没有可执行的服务器预览', 400);
    if (actions.length > MAX_ACTIONS) return errorResponse(`单次最多执行 ${MAX_ACTIONS} 个变更`, 400);

    // 先通过 D1 主键唯一约束原子抢占消费权，再更新 KV 状态。
    // 即使两个请求同时读取到 KV ready，只有一个请求能继续进入任何业务写入。
    try {
      await claimPreviewConsumption(env, bound);
      previewClaimed = true;
    } catch (error) {
      return errorResponse(error.message, Number(error.status) || 409);
    }

    await consumePreview(env, bound);

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
    if (siteMap.size !== siteIds.length) throw new Error('预览中的书签已不存在或发生变化，请重新生成预览');

    const categoryQuery = await env.NAV_DB.prepare('SELECT id, catelog, parent_id, is_private FROM category').all();
    const categoryMap = new Map((categoryQuery.results || []).map(category => [Number(category.id), category]));
    const refMap = new Map();

    // 在任何书签/分类业务写操作前保存完整书签快照。后续任何失败都尝试自动回滚。
    snapshots = siteIds.map(id => siteMap.get(id)).filter(Boolean);
    undoToken = crypto.randomUUID();
    const undoBase = {
      status: 'prepared',
      sessionId: bound.sessionId,
      previewDigest: bound.digest,
      createdAt: new Date().toISOString(),
      snapshots,
      createdCategoryIds: [],
    };
    await saveUndoRecord(env, undoToken, undoBase);
    undoPrepared = true;

    for (const raw of actions) {
      if (raw?.type !== 'create_category') continue;
      const created = await createOrReuseCategory(
        env,
        raw,
        refMap,
        categoryMap,
        createdCategoryIds,
        async () => {
          await saveUndoRecord(env, undoToken, {
            ...undoBase,
            status: 'prepared',
            createdCategoryIds: [...createdCategoryIds],
          });
        }
      );
      if (!created) throw new Error(`新建分类动作已失效：${raw?.name || raw?.tempKey || '未知分类'}`);
      if (created.reused) throw new Error(`预览中的新建分类“${created.name}”已存在，请重新生成预览`);
      createdCategoryNames.push(created.name);
    }

    const valid = [];
    for (const raw of actions) {
      const type = raw?.type;
      if (type === 'create_category') continue;

      const siteId = Number.parseInt(raw?.siteId, 10);
      const currentSite = siteMap.get(siteId);
      if (!currentSite) throw new Error(`书签 #${siteId || '?'} 已不存在，请重新生成预览`);

      if (type === 'rename_bookmark') {
        const normalized = normalizeBookmarkName(raw?.name);
        if (!normalized.ok) throw new Error(`书签 #${siteId} 的重命名内容无效`);
        if (raw?.currentName !== undefined && String(raw.currentName) !== String(currentSite.name || '')) {
          throw new Error(`书签 #${siteId} 名称已变化，请重新生成预览`);
        }
        if (normalized.value === currentSite.name) throw new Error(`书签 #${siteId} 已是目标名称，请重新生成预览`);
        valid.push({ type, siteId, name: normalized.value });
        continue;
      }

      if (type === 'update_description') {
        const normalized = normalizeBookmarkDesc(raw?.description);
        if (!normalized.ok || !normalized.value) throw new Error(`书签 #${siteId} 的描述内容无效`);
        if (raw?.currentDescription !== undefined && String(raw.currentDescription || '') !== String(currentSite.desc || '')) {
          throw new Error(`书签 #${siteId} 描述已变化，请重新生成预览`);
        }
        if (normalized.value === (currentSite.desc || '')) throw new Error(`书签 #${siteId} 已是目标描述，请重新生成预览`);
        valid.push({ type, siteId, description: normalized.value });
        continue;
      }

      if (type === 'move_bookmark') {
        let categoryId = Number.parseInt(raw?.categoryId, 10) || 0;
        const categoryRef = normalizeText(raw?.categoryRef, 80);
        if (!categoryId && categoryRef) categoryId = Number(refMap.get(categoryRef) || 0);
        if (!categoryId || !categoryMap.has(categoryId)) throw new Error(`书签 #${siteId} 的目标分类已失效，请重新生成预览`);
        if (raw?.currentCategoryId !== undefined && Number(raw.currentCategoryId || 0) !== Number(currentSite.catelog_id || 0)) {
          throw new Error(`书签 #${siteId} 当前分类已变化，请重新生成预览`);
        }
        if (categoryId === Number(currentSite.catelog_id)) throw new Error(`书签 #${siteId} 已在目标分类，请重新生成预览`);
        valid.push({ type, siteId, categoryId });
        continue;
      }

      throw new Error(`存在不受支持的预览动作：${String(type || 'unknown')}`);
    }

    if (valid.length + createdCategoryIds.length !== actions.length) {
      throw new Error('服务器最终可执行动作数量与已确认预览不一致');
    }

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

    await saveUndoRecord(env, undoToken, {
      ...undoBase,
      status: 'applied',
      appliedAt: new Date().toISOString(),
      snapshots,
      createdCategoryIds: [...createdCategoryIds],
    });
    await finalizePreview(env, bound, 'applied', { appliedAt: new Date().toISOString(), undoToken });
    await markHomeCacheDirty(env, 'all');

    const applied = actions.length;
    return jsonResponse({
      code: 200,
      message: `已执行 ${applied} 个已确认变更${createdCategoryNames.length ? `，新建 ${createdCategoryNames.length} 个分类` : ''}`,
      data: {
        applied,
        changedBookmarks: valid.length,
        createdCategories: createdCategoryNames,
        undoToken,
        previewDigest: bound.digest,
      },
    });
  } catch (error) {
    console.error('Assistant apply failed:', error);

    // 已取得 D1 原子消费权、但还没形成 undo 快照时也必须让 KV preview 失效。
    // claim 墓碑永久保留，保证任何已拿到旧 bound 的并发请求也无法迟到重放。
    if (previewClaimed && !undoPrepared && bound && env.NAV_AUTH) {
      try {
        await finalizePreview(env, bound, 'claim_failed', { failedAt: new Date().toISOString() });
      } catch (finalizeFailure) {
        console.error('Failed to finalize claimed preview after apply error:', finalizeFailure);
      }
    }

    let rollbackError = null;
    if (undoPrepared && env.NAV_DB && env.NAV_AUTH) {
      try {
        if (snapshots.length) await restoreSnapshots(env.NAV_DB, snapshots);
        if (createdCategoryIds.length) await removeCreatedCategoriesIfUnused(env.NAV_DB, createdCategoryIds);
        if (undoToken) await env.NAV_AUTH.delete(`assistant_undo_${undoToken}`);
        if (bound) await finalizePreview(env, bound, 'failed_rolled_back', { failedAt: new Date().toISOString() });
        await markHomeCacheDirty(env, 'all');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
        console.error('Assistant automatic rollback failed:', rollbackFailure);
        if (undoToken) {
          try {
            await saveUndoRecord(env, undoToken, {
              status: 'rollback_failed',
              sessionId: bound?.sessionId || '',
              previewDigest: bound?.digest || '',
              failedAt: new Date().toISOString(),
              snapshots,
              createdCategoryIds: [...createdCategoryIds],
              error: String(error?.message || error),
              rollbackError: String(rollbackFailure?.message || rollbackFailure),
            });
          } catch {}
        }
      }
    }

    if (rollbackError && undoToken) {
      return jsonResponse({
        code: 500,
        message: `执行失败且自动回滚未完全成功，请立即使用恢复令牌 ${undoToken} 执行撤销：${error.message}`,
        data: { undoToken, recoveryRequired: true },
      }, 500);
    }

    return errorResponse(`执行失败${undoPrepared ? '，已自动回滚' : ''}: ${error.message}`, 500);
  }
}
