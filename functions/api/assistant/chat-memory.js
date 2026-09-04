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

function buildForwardMessage(originalMessage, previousHistory) {
  const original = String(originalMessage || '').trim().slice(0, 1800);
  const memory = compactOlderMemory(previousHistory);
  if (!memory) return original;

  return `${original}\n\n【较早的同一会话记忆，仅用于理解“刚才、之前、那些、第一个”等指代；若与当前数据库状态冲突，以重新调用工具读取的数据为准】\n${memory}`.slice(0, 2950);
}

function titleFromHistory(history) {
  const firstUser = history.find(item => item.role === 'user' && item.content);
  return firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 80) : '未命名对话';
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

  const before = await loadRawSession(env, sessionId);
  const previousHistory = cleanHistory(before?.history).slice(-MAX_PERSISTED_MESSAGES);
  const forwardedBody = {
    ...body,
    message: buildForwardMessage(originalMessage, previousHistory),
  };

  const forwardedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(forwardedBody),
  });

  const response = await runAgentChat({ ...context, request: forwardedRequest });

  try {
    const responseData = await response.clone().json();
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
      }), { expirationTtl: 7 * 24 * 60 * 60 });
    }
  } catch (error) {
    console.warn('Failed to persist extended assistant memory:', error);
  }

  return response;
}
