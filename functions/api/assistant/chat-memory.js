import { onRequestPost as runAgentChat } from './chat';

const SESSION_PREFIX = 'assistant_session_';
const MAX_PERSISTED_MESSAGES = 40;
const BASE_RECENT_MESSAGES = 10;
const MAX_OLDER_MEMORY_CHARS = 1600;

function normalizeSessionId(value) {
  const raw = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(raw) ? raw : '';
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

function compactOlderMemory(history) {
  const older = history.slice(0, Math.max(0, history.length - BASE_RECENT_MESSAGES)).slice(-12);
  if (!older.length) return '';

  const lines = [];
  let used = 0;
  for (const item of older) {
    const label = item.role === 'user' ? '用户' : '助手';
    const text = String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const line = `${label}：${text}`;
    if (used + line.length > MAX_OLDER_MEMORY_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

async function loadRawSession(env, sessionId) {
  try {
    const raw = await env.NAV_AUTH.get(`${SESSION_PREFIX}${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function detectRequestMode(message) {
  const text = String(message || '').replace(/\s+/g, ' ');
  const prepareChanges = /(生成|准备|列出|给出|给我).{0,24}(变更预览|待确认变更|可执行预览|操作预览)|预览.{0,12}(变更|修改)|生成.{0,16}actions?/i.test(text);
  if (prepareChanges) return 'prepare_changes';

  const analysisOnly = /(只给方案|先给方案|仅给方案|先不要修改|不要修改任何数据|不要修改数据|不修改数据|先别修改|仅分析|只分析|先分析|只做分析|不要生成可执行)/.test(text);
  if (analysisOnly) return 'analysis_only';

  return 'normal';
}

function modeInstruction(mode) {
  if (mode === 'analysis_only') {
    return '【本轮安全模式：analysis_only】用户只要求分析/方案。可以读取数据库并给出建议，但最终 JSON 的 actions 必须是空数组 []，不得生成任何可执行变更。';
  }
  if (mode === 'prepare_changes') {
    return '【本轮模式：prepare_changes】允许生成待确认 actions 作为预览，但绝不能直接执行数据库写入；必须等待用户在界面二次确认。';
  }
  return '【本轮模式：normal】根据用户当前指令判断是否需要工具；除非用户明确要求修改或生成变更预览，否则不要产生 actions。';
}

function buildForwardMessage(originalMessage, previousHistory, mode) {
  const original = String(originalMessage || '').trim().slice(0, 1800);
  const memory = compactOlderMemory(previousHistory);
  const parts = [original, modeInstruction(mode)];
  if (memory) {
    parts.push(`【较早的同一会话记忆，仅用于理解“刚才、之前、那些、第一个”等指代；若与当前数据库状态冲突，以重新调用工具读取的数据为准】\n${memory}`);
  }
  return parts.join('\n\n').slice(0, 2950);
}

function titleFromHistory(history) {
  const firstUser = history.find(item => item.role === 'user' && item.content);
  return firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 80) : '未命名对话';
}

function normalizeActionLabels(actions) {
  const safeActions = Array.isArray(actions) ? actions.map(item => ({ ...item })) : [];
  const created = new Map();
  for (const action of safeActions) {
    if (action.type === 'create_category' && action.tempKey && action.name) {
      created.set(String(action.tempKey), String(action.name));
    }
  }
  for (const action of safeActions) {
    if (action.type === 'move_bookmark' && action.categoryRef) {
      const official = created.get(String(action.categoryRef));
      if (official) action.category = official;
    }
  }
  return safeActions;
}

function applyResponseSafety(responseData, mode) {
  if (!responseData?.data) return responseData;
  responseData.data.mode = mode;
  responseData.data.actions = normalizeActionLabels(responseData.data.actions);

  if (mode === 'analysis_only') {
    const removed = responseData.data.actions.length;
    responseData.data.actions = [];
    responseData.data.writePreviewSuppressed = removed > 0;
    if (removed > 0) {
      responseData.data.reply = `${responseData.data.reply}\n\n（已按“只给方案”模式隐藏 ${removed} 项可执行变更；如需生成待确认预览，请明确说“生成变更预览”。）`;
    }
  }
  return responseData;
}

function rebuildResponse(originalResponse, data) {
  const headers = new Headers(originalResponse.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.NAV_AUTH) return runAgentChat(context);

  let body;
  try {
    body = await request.clone().json();
  } catch {
    return runAgentChat(context);
  }

  const originalMessage = String(body?.message || '').trim();
  const sessionId = normalizeSessionId(body?.sessionId);
  if (!originalMessage || !sessionId) return runAgentChat(context);

  const mode = detectRequestMode(originalMessage);
  const before = await loadRawSession(env, sessionId);
  const previousHistory = cleanHistory(before?.history).slice(-MAX_PERSISTED_MESSAGES);
  const forwardedBody = {
    ...body,
    message: buildForwardMessage(originalMessage, previousHistory, mode),
  };

  const forwardedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(forwardedBody),
  });

  const response = await runAgentChat({ ...context, request: forwardedRequest });
  let finalResponse = response;

  try {
    let responseData = await response.clone().json();
    responseData = applyResponseSafety(responseData, mode);

    if (response.ok && responseData?.code === 200 && responseData?.data?.reply) {
      const actualSessionId = normalizeSessionId(responseData.data.sessionId) || sessionId;
      const after = await loadRawSession(env, actualSessionId) || {};
      const fullHistory = [
        ...previousHistory,
        { role: 'user', content: originalMessage.slice(0, 4000) },
        { role: 'assistant', content: String(responseData.data.reply).slice(0, 4000) },
      ].slice(-MAX_PERSISTED_MESSAGES);

      const now = new Date().toISOString();
      await env.NAV_AUTH.put(`${SESSION_PREFIX}${actualSessionId}`, JSON.stringify({
        ...after,
        title: before?.title || after?.title || titleFromHistory(fullHistory),
        createdAt: before?.createdAt || after?.createdAt || now,
        updatedAt: now,
        history: fullHistory,
        pendingActions: responseData.data.actions || [],
      }), { expirationTtl: 7 * 24 * 60 * 60 });
    }

    finalResponse = rebuildResponse(response, responseData);
  } catch (error) {
    console.warn('Failed to apply assistant memory/safety wrapper:', error);
  }

  return finalResponse;
}
