import { isAdminAuthenticated, errorResponse, jsonResponse } from '../../_middleware';
import { resolveWorkersAiModel } from '../../lib/workers-ai-models';

const MAX_CANDIDATES = 80;
const MAX_ACTIONS = 100;

function normalizeText(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function stripJsonFence(text) {
  return String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

function extractJson(text) {
  const clean = stripJsonFence(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  try { return JSON.parse(clean); } catch {}
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  }
  return null;
}

function tokenizeQuery(message) {
  return [...new Set(String(message || '')
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()（）\[\]【】"'“”‘’]/g, ' ')
    .split(/\s+/)
    .flatMap(part => part.length > 4 && /[\u4e00-\u9fff]/.test(part)
      ? [part, ...part.match(/[\u4e00-\u9fff]{2,4}/g) || []]
      : [part])
    .map(v => v.trim())
    .filter(v => v.length >= 2)
    .slice(0, 12))];
}

async function loadCandidates(db, message) {
  const tokens = tokenizeQuery(message);
  if (!tokens.length) {
    const { results } = await db.prepare(`
      SELECT id, name, url, desc, catelog_id, catelog_name, is_private, update_time
      FROM sites ORDER BY update_time DESC, id DESC LIMIT ?
    `).bind(MAX_CANDIDATES).all();
    return results || [];
  }

  const clauses = [];
  const params = [];
  for (const token of tokens.slice(0, 8)) {
    const like = `%${token}%`;
    clauses.push('(LOWER(name) LIKE ? OR LOWER(url) LIKE ? OR LOWER(COALESCE(desc,\'\')) LIKE ? OR LOWER(COALESCE(catelog_name,\'\')) LIKE ?)');
    params.push(like, like, like, like);
  }

  const sql = `
    SELECT id, name, url, desc, catelog_id, catelog_name, is_private, update_time
    FROM sites
    WHERE ${clauses.join(' OR ')}
    ORDER BY update_time DESC, id DESC
    LIMIT ?
  `;
  params.push(MAX_CANDIDATES);
  const { results } = await db.prepare(sql).bind(...params).all();

  if ((results || []).length >= 8) return results || [];

  const { results: fallback } = await db.prepare(`
    SELECT id, name, url, desc, catelog_id, catelog_name, is_private, update_time
    FROM sites ORDER BY update_time DESC, id DESC LIMIT ?
  `).bind(MAX_CANDIDATES).all();
  return fallback || [];
}

async function loadAiSettings(db) {
  const keys = ['provider', 'apiKey', 'baseUrl', 'model'];
  const { results } = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).bind(...keys).all();
  const settings = {};
  for (const row of results || []) settings[row.key] = row.value;
  return settings;
}

function getWorkersText(response) {
  if (typeof response === 'string') return response;
  return response?.response || response?.choices?.[0]?.message?.content || response?.result?.response || '';
}

async function callAi(env, settings, messages) {
  const provider = settings.provider || 'workers-ai';
  if (provider === 'workers-ai') {
    if (!env.AI) throw new Error('Workers AI binding (env.AI) not found');
    const model = resolveWorkersAiModel(settings.model, env.WORKERS_AI_MODEL);
    return getWorkersText(await env.AI.run(model, { messages }));
  }

  if (provider === 'openai') {
    if (!settings.apiKey || !settings.baseUrl) throw new Error('OpenAI API 配置不完整');
    const response = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model || 'gpt-4o-mini', messages, temperature: 0.2 })
    });
    if (!response.ok) throw new Error(`OpenAI API Error: ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'gemini') {
    if (!settings.apiKey) throw new Error('Gemini API Key 未配置');
    const model = settings.model || 'gemini-1.5-flash';
    const system = messages.find(m => m.role === 'system')?.content || '';
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature: 0.2 } })
    });
    if (!response.ok) throw new Error(`Gemini API Error: ${await response.text()}`);
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function validateAiPayload(payload, siteMap, categoryMap) {
  const safe = {
    reply: normalizeText(payload?.reply || '已完成分析。', 1000),
    results: [],
    actions: [],
  };

  for (const item of Array.isArray(payload?.results) ? payload.results.slice(0, 8) : []) {
    const id = Number(item?.id);
    const site = siteMap.get(id);
    if (!site) continue;
    safe.results.push({
      id,
      name: site.name,
      url: site.url,
      desc: site.desc || '',
      category: site.catelog_name || '',
      reason: normalizeText(item?.reason || '', 160),
    });
  }

  for (const raw of Array.isArray(payload?.actions) ? payload.actions.slice(0, MAX_ACTIONS) : []) {
    const type = raw?.type;
    const siteId = Number(raw?.siteId);
    const site = siteMap.get(siteId);
    if (!site || !['rename_bookmark', 'update_description', 'move_bookmark'].includes(type)) continue;

    if (type === 'rename_bookmark') {
      const name = normalizeText(raw?.name, 80);
      if (name && name !== site.name) safe.actions.push({ type, siteId, name, currentName: site.name });
    }
    if (type === 'update_description') {
      const description = normalizeText(raw?.description, 300);
      if (description && description !== (site.desc || '')) safe.actions.push({ type, siteId, description, currentDescription: site.desc || '' });
    }
    if (type === 'move_bookmark') {
      const categoryId = Number(raw?.categoryId);
      const category = categoryMap.get(categoryId);
      if (category && categoryId !== Number(site.catelog_id)) {
        safe.actions.push({
          type, siteId, categoryId,
          currentCategoryId: Number(site.catelog_id),
          currentCategory: site.catelog_name || '',
          category: category.catelog,
        });
      }
    }
  }
  return safe;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);

  try {
    const body = await request.json();
    const message = normalizeText(body?.message, 1500);
    if (!message) return errorResponse('请输入任务或问题', 400);

    const [candidates, categoryResult, settings] = await Promise.all([
      loadCandidates(env.NAV_DB, message),
      env.NAV_DB.prepare('SELECT id, catelog, parent_id FROM category ORDER BY sort_order, id').all(),
      loadAiSettings(env.NAV_DB),
    ]);

    const categories = categoryResult.results || [];
    const siteMap = new Map(candidates.map(site => [Number(site.id), site]));
    const categoryMap = new Map(categories.map(cat => [Number(cat.id), cat]));

    const system = `你是 iori-nav 的 AI 书签助手。你只能基于提供的书签和分类工作。\n` +
      `职责：1) 根据模糊描述找出用户想找的网站；2) 对书签提出重命名、修改描述、移动分类建议；3) 不得编造不存在的书签或分类。\n` +
      `如果用户只是查找网站，actions 必须为空。只有用户明确要求修改、整理、重命名、重新分类时才生成 actions。\n` +
      `绝不能删除书签、删除分类或执行 SQL。\n` +
      `严格只返回 JSON：{"reply":"中文回复","results":[{"id":1,"reason":"匹配原因"}],"actions":[{"type":"rename_bookmark","siteId":1,"name":"新名称"},{"type":"update_description","siteId":1,"description":"新描述"},{"type":"move_bookmark","siteId":1,"categoryId":2}]}。`;

    const compactSites = candidates.map(site => ({
      id: site.id,
      name: site.name,
      url: site.url,
      desc: site.desc || '',
      categoryId: site.catelog_id,
      category: site.catelog_name || '',
    }));
    const compactCategories = categories.map(cat => ({ id: cat.id, name: cat.catelog, parentId: cat.parent_id || 0 }));

    const aiText = await callAi(env, settings, [
      { role: 'system', content: system },
      { role: 'user', content: `用户任务：${message}\n\n可用分类：${JSON.stringify(compactCategories)}\n\n候选书签：${JSON.stringify(compactSites)}` }
    ]);

    const parsed = extractJson(aiText);
    if (!parsed) return errorResponse('AI 返回格式无效，请重试', 502);

    const data = validateAiPayload(parsed, siteMap, categoryMap);
    return jsonResponse({ code: 200, data });
  } catch (error) {
    console.error('Assistant chat failed:', error);
    return errorResponse(`AI 助手处理失败: ${error.message}`, 500);
  }
}
