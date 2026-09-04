import { isAdminAuthenticated, errorResponse, jsonResponse } from '../../_middleware';
import { normalizeBookmarkName, normalizeBookmarkDesc, normalizeCategoryName } from '../../lib/validators';
import { callAssistantAi, loadAssistantAiSettings, parseAssistantJson } from '../../lib/assistant-ai';
import { ASSISTANT_TOOL_GUIDE, executeAssistantTool } from '../../lib/assistant-tools';

const SESSION_TTL = 7 * 24 * 60 * 60;
const MAX_HISTORY_MESSAGES = 10;
const MAX_TOOL_ROUNDS = 7;
const MAX_TOOL_CALLS_PER_ROUND = 6;
const MAX_RESULTS = 12;
const MAX_ACTIONS = 250;

function normalizeText(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function normalizeSessionId(value) {
  const raw = String(value || '').trim();
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

function buildSessionKey(sessionId) {
  return `assistant_session_${sessionId}`;
}

async function loadSession(env, sessionId) {
  try {
    const raw = await env.NAV_AUTH.get(buildSessionKey(sessionId));
    if (!raw) return { history: [], lastResults: [], pendingActions: [], plan: null };
    const parsed = JSON.parse(raw);
    return {
      history: Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY_MESSAGES) : [],
      lastResults: Array.isArray(parsed.lastResults) ? parsed.lastResults.slice(0, MAX_RESULTS) : [],
      pendingActions: Array.isArray(parsed.pendingActions) ? parsed.pendingActions.slice(0, MAX_ACTIONS) : [],
      plan: parsed.plan && typeof parsed.plan === 'object' ? parsed.plan : null,
    };
  } catch (error) {
    console.warn('Failed to load assistant session:', error);
    return { history: [], lastResults: [], pendingActions: [], plan: null };
  }
}

async function saveSession(env, sessionId, session) {
  const payload = {
    history: (session.history || []).slice(-MAX_HISTORY_MESSAGES),
    lastResults: (session.lastResults || []).slice(0, MAX_RESULTS),
    pendingActions: (session.pendingActions || []).slice(0, MAX_ACTIONS),
    plan: session.plan || null,
    updatedAt: new Date().toISOString(),
  };
  await env.NAV_AUTH.put(buildSessionKey(sessionId), JSON.stringify(payload), { expirationTtl: SESSION_TTL });
}

function buildSystemPrompt(settings, session) {
  const provider = settings.provider || 'workers-ai';
  const model = settings.model || (provider === 'workers-ai' ? '部署默认 Workers AI 模型' : '服务商默认模型');
  const lastResults = (session.lastResults || []).map(item => ({ id: item.id, name: item.name, url: item.url, category: item.category }));
  const pendingSummary = (session.pendingActions || []).slice(0, 30).map(action => ({
    type: action.type,
    siteId: action.siteId,
    name: action.name,
    category: action.category,
    tempKey: action.tempKey,
  }));

  return `你是 iori-nav 的 AI 书签管理 Agent。你不是普通聊天机器人，而是可以通过后端工具读取真实书签库并提出受控操作方案的助手。\n\n` +
    `当前 AI 提供商：${provider}；模型：${model}。如果用户询问你使用什么模型，可以如实说明这个信息。\n\n` +
    `${ASSISTANT_TOOL_GUIDE}\n` +
    `你的工作方式：\n` +
    `- 先理解用户目标，再决定是否需要读取数据库。凡是涉及“我的书签/现有分类/那个网站/全部整理”等内容，都应优先调用工具获取真实数据。\n` +
    `- 支持多轮上下文。用户说“第一个、这些、刚才那些”时，可结合最近结果继续处理。\n` +
    `- 查找任务只返回结果，不生成写操作。\n` +
    `- 修改、整理、重命名、重新分组等任务，只生成待确认 actions，不得直接执行数据库写入。\n` +
    `- 可以规划新分类，但不得删除书签、删除分类、执行 SQL 或修改 URL。\n` +
    `- 对全库整理，必须实际读取全库（按页读取）后再声称“已分析全部”。如果书签太多导致本轮无法全部读取，要明确说明覆盖范围并给出分阶段方案。\n\n` +
    `最终答案必须严格返回 JSON，格式：\n` +
    `{"type":"final","reply":"中文回复","results":[{"id":1,"reason":"匹配原因"}],` +
    `"plan":{"title":"可选标题","summary":"可选方案摘要","scope":"覆盖范围","estimatedChanges":0},` +
    `"actions":[` +
    `{"type":"create_category","tempKey":"cat_network_test","name":"网络测试","parentId":0},` +
    `{"type":"rename_bookmark","siteId":1,"name":"新名称"},` +
    `{"type":"update_description","siteId":1,"description":"新描述"},` +
    `{"type":"move_bookmark","siteId":1,"categoryId":2},` +
    `{"type":"move_bookmark","siteId":1,"categoryRef":"cat_network_test","category":"网络测试"}` +
    `]}。\n` +
    `create_category 的 tempKey 仅用于本次方案内引用；新建子分类时可用 parentRef 指向另一个新分类 tempKey。` +
    `move_bookmark 移动到已有分类用 categoryId，移动到本次新建分类用 categoryRef。\n\n` +
    `最近一次搜索/分析结果：${JSON.stringify(lastResults)}\n` +
    `上一轮待确认操作摘要：${JSON.stringify(pendingSummary)}\n`;
}

function sanitizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    title: normalizeText(plan.title, 100),
    summary: normalizeText(plan.summary, 1200),
    scope: normalizeText(plan.scope, 300),
    estimatedChanges: Math.max(0, Number.parseInt(plan.estimatedChanges, 10) || 0),
  };
}

async function fetchValidationContext(db, payload) {
  const siteIds = new Set();
  for (const result of Array.isArray(payload?.results) ? payload.results : []) {
    const id = Number.parseInt(result?.id, 10);
    if (Number.isFinite(id) && id > 0) siteIds.add(id);
  }
  for (const action of Array.isArray(payload?.actions) ? payload.actions : []) {
    const id = Number.parseInt(action?.siteId, 10);
    if (Number.isFinite(id) && id > 0) siteIds.add(id);
  }

  let sites = [];
  if (siteIds.size) {
    const ids = [...siteIds].slice(0, MAX_ACTIONS + MAX_RESULTS);
    const placeholders = ids.map(() => '?').join(',');
    const query = await db.prepare(`
      SELECT id, name, url, desc, catelog_id, catelog_name, is_private
      FROM sites WHERE id IN (${placeholders})
    `).bind(...ids).all();
    sites = query.results || [];
  }

  const categoryQuery = await db.prepare('SELECT id, catelog, parent_id, is_private FROM category ORDER BY sort_order, id').all();
  return {
    siteMap: new Map(sites.map(site => [Number(site.id), site])),
    categoryMap: new Map((categoryQuery.results || []).map(category => [Number(category.id), category])),
  };
}

async function validateFinalPayload(db, payload) {
  const { siteMap, categoryMap } = await fetchValidationContext(db, payload);
  const safe = {
    reply: normalizeText(payload?.reply || '已完成分析。', 2000),
    results: [],
    plan: sanitizePlan(payload?.plan),
    actions: [],
  };

  for (const item of (Array.isArray(payload?.results) ? payload.results : []).slice(0, MAX_RESULTS)) {
    const id = Number.parseInt(item?.id, 10);
    const site = siteMap.get(id);
    if (!site) continue;
    safe.results.push({
      id,
      name: site.name || '',
      url: site.url || '',
      desc: site.desc || '',
      category: site.catelog_name || '',
      reason: normalizeText(item?.reason, 220),
    });
  }

  const rawActions = (Array.isArray(payload?.actions) ? payload.actions : []).slice(0, MAX_ACTIONS);
  const createdRefs = new Set();

  for (const raw of rawActions) {
    if (raw?.type !== 'create_category') continue;
    const tempKey = normalizeText(raw.tempKey, 80);
    if (!/^[a-zA-Z0-9_-]{2,80}$/.test(tempKey) || createdRefs.has(tempKey)) continue;
    const normalizedName = normalizeCategoryName(raw.name);
    if (!normalizedName.ok) continue;

    const parentId = Number.parseInt(raw.parentId, 10) || 0;
    const parentRef = normalizeText(raw.parentRef, 80);
    if (parentId > 0 && !categoryMap.has(parentId)) continue;
    if (parentRef && !createdRefs.has(parentRef)) continue;

    createdRefs.add(tempKey);
    safe.actions.push({
      type: 'create_category',
      tempKey,
      name: normalizedName.value,
      parentId,
      parentRef: parentRef || '',
      isPrivate: Number(raw.isPrivate) === 1 ? 1 : 0,
    });
  }

  for (const raw of rawActions) {
    const type = raw?.type;
    if (type === 'create_category') continue;

    const siteId = Number.parseInt(raw?.siteId, 10);
    const site = siteMap.get(siteId);
    if (!site) continue;

    if (type === 'rename_bookmark') {
      const normalized = normalizeBookmarkName(raw.name);
      if (normalized.ok && normalized.value !== site.name) {
        safe.actions.push({ type, siteId, name: normalized.value, currentName: site.name || '' });
      }
      continue;
    }

    if (type === 'update_description') {
      const normalized = normalizeBookmarkDesc(raw.description);
      if (normalized.ok && normalized.value && normalized.value !== (site.desc || '')) {
        safe.actions.push({
          type,
          siteId,
          description: normalized.value,
          currentDescription: site.desc || '',
        });
      }
      continue;
    }

    if (type === 'move_bookmark') {
      const categoryId = Number.parseInt(raw.categoryId, 10) || 0;
      const categoryRef = normalizeText(raw.categoryRef, 80);
      if (categoryId > 0 && categoryMap.has(categoryId) && categoryId !== Number(site.catelog_id)) {
        const category = categoryMap.get(categoryId);
        safe.actions.push({
          type,
          siteId,
          categoryId,
          category: category.catelog || '',
          currentCategoryId: Number(site.catelog_id) || 0,
          currentCategory: site.catelog_name || '',
        });
      } else if (categoryRef && createdRefs.has(categoryRef)) {
        safe.actions.push({
          type,
          siteId,
          categoryRef,
          category: normalizeText(raw.category, 80) || categoryRef,
          currentCategoryId: Number(site.catelog_id) || 0,
          currentCategory: site.catelog_name || '',
        });
      }
    }
  }

  return safe;
}

function summarizeToolResult(name, result) {
  if (name === 'library_stats') return `统计：${result.totalBookmarks || 0} 个书签，${result.totalCategories || 0} 个分类`;
  if (name === 'list_categories') return `读取 ${Array.isArray(result) ? result.length : 0} 个分类`;
  if (name === 'list_bookmarks') return `读取第 ${result.page || 1} 页 ${result.bookmarks?.length || 0}/${result.total || 0} 个书签`;
  if (name === 'search_bookmarks') return `检索返回 ${result.bookmarks?.length || 0} 个候选`;
  if (name === 'get_bookmarks') return `读取 ${result.bookmarks?.length || 0} 个指定书签`;
  if (name === 'find_duplicates') return `发现 ${result.groups?.length || 0} 组重复 URL`;
  return name;
}

async function runToolCalls(env, calls, trace) {
  const safeCalls = (Array.isArray(calls) ? calls : []).slice(0, MAX_TOOL_CALLS_PER_ROUND);
  const results = [];

  for (const call of safeCalls) {
    const name = normalizeText(call?.name, 80);
    const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    try {
      const result = await executeAssistantTool(env, name, args);
      results.push({ name, ok: true, result });
      trace.push(summarizeToolResult(name, result));
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      trace.push(`${name} 失败：${error.message}`);
    }
  }

  return results;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);

  try {
    if (!env.NAV_DB || !env.NAV_AUTH) return errorResponse('NAV_DB / NAV_AUTH binding not found', 500);

    const body = await request.json();
    const message = normalizeText(body?.message, 3000);
    if (!message) return errorResponse('请输入任务或问题', 400);

    const sessionId = normalizeSessionId(body?.sessionId);
    const [settings, session] = await Promise.all([
      loadAssistantAiSettings(env.NAV_DB),
      loadSession(env, sessionId),
    ]);

    const messages = [
      { role: 'system', content: buildSystemPrompt(settings, session) },
      ...session.history
        .filter(item => item && ['user', 'assistant'].includes(item.role) && item.content)
        .slice(-MAX_HISTORY_MESSAGES)
        .map(item => ({ role: item.role, content: normalizeText(item.content, 2500) })),
      { role: 'user', content: message },
    ];

    const toolTrace = [];
    let finalPayload = null;
    let invalidJsonRetries = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const aiText = await callAssistantAi(env, settings, messages, { temperature: 0.12 });
      const parsed = parseAssistantJson(aiText);

      if (!parsed) {
        if (invalidJsonRetries >= 1) throw new Error('AI 连续返回非 JSON 内容，请重试或更换模型');
        invalidJsonRetries++;
        messages.push({ role: 'assistant', content: normalizeText(aiText, 2500) });
        messages.push({ role: 'user', content: '你的上一次输出不是合法 JSON。请严格按工具调用或 final JSON 格式重新输出，不要附加 Markdown。' });
        continue;
      }

      if (parsed.type === 'tool_calls') {
        const toolResults = await runToolCalls(env, parsed.calls, toolTrace);
        if (!toolResults.length) {
          messages.push({ role: 'user', content: '没有有效工具调用。请直接给出 final JSON，或使用工具指南中的合法工具名。' });
          continue;
        }
        messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
        messages.push({ role: 'user', content: `TOOL_RESULTS:\n${JSON.stringify(toolResults)}` });
        continue;
      }

      finalPayload = parsed.type === 'final' ? parsed : { ...parsed, type: 'final' };
      break;
    }

    if (!finalPayload) {
      messages.push({ role: 'user', content: '工具读取阶段已结束。现在不得再调用工具，请基于已获取的数据严格返回 final JSON；若没有覆盖全库，必须在 reply 和 plan.scope 中说明实际覆盖范围。' });
      const aiText = await callAssistantAi(env, settings, messages, { temperature: 0.1 });
      const parsed = parseAssistantJson(aiText);
      if (!parsed) throw new Error('AI 未能生成有效的最终 JSON');
      finalPayload = parsed.type === 'final' ? parsed : { ...parsed, type: 'final' };
    }

    const data = await validateFinalPayload(env.NAV_DB, finalPayload);
    const nextHistory = [
      ...session.history,
      { role: 'user', content: message },
      { role: 'assistant', content: data.reply },
    ].slice(-MAX_HISTORY_MESSAGES);

    await saveSession(env, sessionId, {
      history: nextHistory,
      lastResults: data.results,
      pendingActions: data.actions,
      plan: data.plan,
    });

    return jsonResponse({
      code: 200,
      data: {
        sessionId,
        provider: settings.provider || 'workers-ai',
        model: settings.model || '',
        reply: data.reply,
        results: data.results,
        plan: data.plan,
        actions: data.actions,
        toolsUsed: toolTrace,
      },
    });
  } catch (error) {
    console.error('Assistant Agent failed:', error);
    return errorResponse(`AI 助手处理失败: ${error.message}`, 500);
  }
}
