import { onRequestPost as runMemoryCore } from './chat-memory-core';

const SESSION_PREFIX = 'assistant_session_';
const SESSION_TTL = 7 * 24 * 60 * 60;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PERSISTED_MESSAGES = 40;
const MAX_TASK_INDEX = 16;
const MAX_ACTIONS = 250;

function normalizeSessionId(value) {
  const raw = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(raw) ? raw : '';
}

function sessionKey(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`;
}

function detectRequestMode(message) {
  const text = String(message || '').replace(/\s+/g, ' ');
  const analysisOnly = /(只给方案|先给方案|仅给方案|先不要修改|不要修改任何数据|不要修改数据|不修改数据|先别修改|仅分析|只分析|先分析|只做分析|不要生成可执行|不生成预览|不要生成预览|不用生成预览|不做预览|不要预览|先别生成预览|暂不生成预览)/.test(text);
  const explicitNoPreview = /(?:不生成预览|不要生成预览|不用生成预览|不做预览|不要预览|先别生成预览|暂不生成预览|不需要预览)/.test(text);
  const explicitPrepare = /(?:生成|做|创建|准备|给出|给我).{0,16}(?:变更|整理|操作)?预览|预览.{0,12}(?:变更|修改|操作)|生成.{0,16}actions?/i.test(text);

  if (explicitNoPreview) return 'analysis_only';
  if (analysisOnly && !explicitPrepare) return 'analysis_only';
  if (explicitPrepare) return 'prepare_changes';
  if (analysisOnly) return 'analysis_only';
  return 'normal';
}

function cleanMessage(item) {
  if (!item || !['user', 'assistant'].includes(item.role) || !item.content) return null;
  return {
    role: item.role,
    content: String(item.content || '').trim().slice(0, 4000),
  };
}

function cleanHistory(history) {
  return (Array.isArray(history) ? history : []).map(cleanMessage).filter(Boolean);
}

function cleanTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((task, index) => ({
    index: Number.parseInt(task?.index, 10) || index + 1,
    turnId: String(task?.turnId || '').slice(0, 40),
    user: String(task?.user || '').trim().slice(0, 800),
    reply: String(task?.reply || '').trim().replace(/\s+/g, ' ').slice(0, 900),
    resultIds: (Array.isArray(task?.resultIds) ? task.resultIds : [])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value) && value > 0)
      .slice(0, 60),
    planTitle: String(task?.planTitle || '').trim().slice(0, 120),
  })).slice(-MAX_TASK_INDEX);
}

function titleFromHistory(history) {
  const firstUser = history.find(item => item.role === 'user' && item.content);
  return firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 80) : '未命名对话';
}

async function loadSession(env, sessionId) {
  try {
    const raw = await env.NAV_AUTH.get(sessionKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function createDeferredAuth(env, targetSessionKey) {
  const original = env.NAV_AUTH;
  return {
    get: (...args) => original.get(...args),
    getWithMetadata: (...args) => original.getWithMetadata(...args),
    list: (...args) => original.list(...args),
    put: async (key, ...args) => {
      if (String(key) === targetSessionKey) return undefined;
      return original.put(key, ...args);
    },
    delete: async (key, ...args) => {
      if (String(key) === targetSessionKey) return undefined;
      return original.delete(key, ...args);
    },
  };
}

function createDeferredContext(context, sessionId, request) {
  const targetSessionKey = sessionKey(sessionId);
  const safeEnv = new Proxy(context.env, {
    get(target, prop) {
      if (prop === 'NAV_AUTH') return createDeferredAuth(context.env, targetSessionKey);
      return Reflect.get(target, prop);
    },
  });
  return { ...context, request, env: safeEnv };
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

async function digestActions(actions) {
  const bytes = new TextEncoder().encode(canonicalize(actions));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function invalidatePendingPreview(env, sessionId) {
  if (!env.NAV_AUTH || !sessionId) return;
  const key = sessionKey(sessionId);
  try {
    const raw = await env.NAV_AUTH.get(key);
    if (!raw) return;
    const current = JSON.parse(raw);
    await env.NAV_AUTH.put(key, JSON.stringify({
      ...current,
      pendingActions: [],
      preview: null,
      updatedAt: new Date().toISOString(),
    }), { expirationTtl: SESSION_TTL });
  } catch (error) {
    console.warn('Failed to invalidate assistant preview, deleting assistant session:', error);
    try { await env.NAV_AUTH.delete(key); } catch {}
  }
}

function jsonResponseLike(source, payload, status = source?.status || 200) {
  const headers = new Headers(source?.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload), {
    status,
    statusText: source?.statusText || '',
    headers,
  });
}

function failClosedResponse(sessionId, mode, error) {
  return new Response(JSON.stringify({
    code: 500,
    message: `AI 助手安全处理失败，本轮未生成任何可执行变更：${String(error?.message || error || '未知错误')}`,
    data: {
      sessionId,
      mode,
      actions: [],
      pendingWriteAllowed: false,
      safetyFailClosed: true,
    },
  }), {
    status: 500,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function persistFinalSession(env, sessionId, before, originalMessage, responseData, outerMode) {
  const data = responseData.data;
  const innerMode = String(data.mode || '');
  if (!innerMode || innerMode !== outerMode) {
    throw new Error(`安全模式不一致：outer=${outerMode || 'none'} inner=${innerMode || 'missing'}`);
  }
  if (outerMode === 'prepare_changes' && !Number.isFinite(Number(data.prepareAttempt))) {
    throw new Error('prepare_changes 缺少最终安全校验标记');
  }

  let safeActions = (Array.isArray(data.actions) ? data.actions : [])
    .slice(0, MAX_ACTIONS)
    .map(stripPreviewMeta)
    .filter(Boolean);

  if (outerMode === 'analysis_only') {
    safeActions = [];
    data.actions = [];
    data.pendingWriteAllowed = false;
  }

  const previousHistory = cleanHistory(before?.history).slice(-MAX_PERSISTED_MESSAGES);
  const previousTasks = cleanTasks(before?.tasks);
  const now = new Date().toISOString();
  const fullHistory = [
    ...previousHistory,
    { role: 'user', content: String(originalMessage || '').slice(0, 4000) },
    { role: 'assistant', content: String(data.reply || '').slice(0, 4000) },
  ].slice(-MAX_PERSISTED_MESSAGES);

  const nextIndex = Number.parseInt(data.taskIndex, 10)
    || ((previousTasks[previousTasks.length - 1]?.index || 0) + 1);
  const task = {
    index: nextIndex,
    turnId: String(data.turnId || crypto.randomUUID().slice(0, 8)).slice(0, 40),
    user: String(originalMessage || '').slice(0, 800),
    reply: String(data.reply || '').replace(/\s+/g, ' ').slice(0, 900),
    resultIds: (Array.isArray(data.results) ? data.results : [])
      .map(item => Number.parseInt(item?.id, 10))
      .filter(value => Number.isFinite(value) && value > 0)
      .slice(0, 60),
    planTitle: String(data.plan?.title || '').slice(0, 120),
  };
  const tasks = [...previousTasks, task].slice(-MAX_TASK_INDEX);

  let preview = null;
  if (safeActions.length > 0) {
    const token = crypto.randomUUID();
    const digest = await digestActions(safeActions);
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
    preview = {
      token,
      digest,
      actionCount: safeActions.length,
      createdAt: now,
      expiresAt,
      status: 'ready',
      mode: outerMode,
    };
    data.actions = safeActions.map(action => ({ ...action, previewToken: token }));
    data.previewToken = token;
    data.previewDigest = digest;
    data.previewExpiresAt = expiresAt;
    data.pendingWriteAllowed = true;
  } else {
    data.actions = [];
    data.previewToken = '';
    data.previewDigest = '';
    data.previewExpiresAt = '';
    data.pendingWriteAllowed = false;
  }

  await env.NAV_AUTH.put(sessionKey(sessionId), JSON.stringify({
    ...(before || {}),
    title: before?.title || titleFromHistory(fullHistory),
    createdAt: before?.createdAt || now,
    updatedAt: now,
    history: fullHistory,
    tasks,
    lastResults: Array.isArray(data.results) ? data.results : [],
    plan: data.plan || null,
    pendingActions: preview ? safeActions : [],
    preview,
  }), { expirationTtl: SESSION_TTL });

  data.taskIndex = nextIndex;
  data.turnId = task.turnId;
  return responseData;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.NAV_AUTH) return failClosedResponse('', 'unknown', new Error('NAV_AUTH binding not found'));

  let body;
  try {
    body = await request.clone().json();
  } catch {
    return new Response(JSON.stringify({ code: 400, message: '请求格式错误', data: { actions: [], pendingWriteAllowed: false } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const originalMessage = String(body?.message || '').trim();
  const sessionId = normalizeSessionId(body?.sessionId);
  const outerMode = detectRequestMode(originalMessage);
  if (!originalMessage || !sessionId) {
    return new Response(JSON.stringify({ code: 400, message: '缺少有效的消息或会话ID', data: { actions: [], pendingWriteAllowed: false } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const before = await loadSession(env, sessionId);
  const deferredContext = createDeferredContext(context, sessionId, request);

  try {
    const response = await runMemoryCore(deferredContext);
    if (!response.ok) {
      await invalidatePendingPreview(env, sessionId);
      return response;
    }

    const responseData = await response.clone().json();
    if (responseData?.code !== 200 || !responseData?.data) {
      await invalidatePendingPreview(env, sessionId);
      return jsonResponseLike(response, responseData, response.status);
    }

    const secured = await persistFinalSession(env, sessionId, before, originalMessage, responseData, outerMode);
    return jsonResponseLike(response, secured, response.status);
  } catch (error) {
    console.error('Assistant secure wrapper failed closed:', error);
    await invalidatePendingPreview(env, sessionId);
    return failClosedResponse(sessionId, outerMode, error);
  }
}
