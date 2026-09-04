import { resolveWorkersAiModel } from './workers-ai-models';

const DEFAULT_AI_TIMEOUT_MS = 40000;
const DEFAULT_FALLBACK_MODEL = '@cf/google/gemma-4-26b-a4b-it';

export function stripAssistantJsonFence(text) {
  return String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeJsonPunctuation(text) {
  return String(text || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/，/g, ',')
    .replace(/：/g, ':');
}

export function parseAssistantJson(text) {
  const clean = stripAssistantJsonFence(text);
  if (!clean) return null;

  const direct = tryParseJson(clean);
  if (direct) return direct;

  const firstObject = clean.indexOf('{');
  const lastObject = clean.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    const objectText = clean.slice(firstObject, lastObject + 1);
    const parsed = tryParseJson(objectText) || tryParseJson(normalizeJsonPunctuation(objectText));
    if (parsed) return parsed;
  }

  // 某些 OpenAI 兼容中转/模型会忽略“只返回 JSON”的要求，直接输出正常中文答案。
  // 这种情况下不要把整个 Agent 任务判定为失败：将其降级为只读 final 回复，绝不生成写操作。
  // 若模型尝试输出了损坏的 JSON（以 { 或 [ 开头），仍返回 null，让上层重试/切换备用模型。
  if (!/^[\[{]/.test(clean)) {
    return {
      type: 'final',
      reply: clean.slice(0, 6000),
      results: [],
      plan: null,
      actions: [],
      formatRecovered: true,
    };
  }

  return null;
}

export async function loadAssistantAiSettings(db) {
  const keys = [
    'provider', 'apiKey', 'baseUrl', 'model',
    'ai_fallback_enabled', 'ai_fallback_provider', 'ai_fallback_model',
    'ai_fallback_on_timeout', 'ai_fallback_on_5xx', 'ai_fallback_on_empty', 'ai_fallback_on_format'
  ];
  const { results } = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).bind(...keys).all();

  const settings = {};
  for (const row of results || []) settings[row.key] = row.value;
  return settings;
}

export function settingEnabled(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function stringifyStructuredContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return '';
}

function getMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (content && !Array.isArray(content) && typeof content === 'object') return stringifyStructuredContent(content);
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return stringifyStructuredContent(part?.text ?? part?.content ?? '');
  }).join('');
}

function extractWorkersAiText(response) {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  if (typeof response.response === 'string') return response.response;
  if (response.response && typeof response.response === 'object') {
    const structured = stringifyStructuredContent(response.response);
    if (structured) return structured;
  }
  const choice = getMessageContentText(response.choices?.[0]?.message?.content);
  if (choice) return choice;
  const candidates = [
    response.output_text, response.generated_text, response.text,
    response.result?.response, response.result?.output_text, response.result?.generated_text,
    response.result?.text, response.result?.choices?.[0]?.message?.content,
    response.output?.[0]?.content,
  ];
  for (const candidate of candidates) {
    const text = getMessageContentText(candidate);
    if (text) return text;
  }
  return '';
}

function extractOpenAiText(data) {
  const direct = getMessageContentText(data?.choices?.[0]?.message?.content);
  if (direct) return direct;
  const candidates = [
    data?.output_text, data?.response, data?.result?.choices?.[0]?.message?.content,
    data?.result?.output_text, data?.data?.choices?.[0]?.message?.content,
  ];
  for (const candidate of candidates) {
    const text = getMessageContentText(candidate);
    if (text) return text;
  }
  return '';
}

function describeWorkersAiResponse(response) {
  if (!response || typeof response !== 'object') return `type=${typeof response}`;
  const keys = Object.keys(response).slice(0, 12).join(',');
  const finishReason = response.choices?.[0]?.finish_reason || response.result?.choices?.[0]?.finish_reason || '';
  const hasReasoning = Boolean(
    response.choices?.[0]?.message?.reasoning || response.choices?.[0]?.message?.reasoning_content ||
    response.result?.choices?.[0]?.message?.reasoning || response.result?.choices?.[0]?.message?.reasoning_content
  );
  return `keys=[${keys}]${finishReason ? `, finish_reason=${finishReason}` : ''}${hasReasoning ? ', reasoning_only=true' : ''}`;
}

function normalizeOpenAiChatUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

function timeoutMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_AI_TIMEOUT_MS;
  return Math.min(60000, Math.max(5000, parsed));
}

function aiError(message, kind = 'other', status = 0) {
  const error = new Error(message);
  error.aiKind = kind;
  error.status = status;
  return error;
}

async function fetchWithTimeout(url, init, ms = DEFAULT_AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const actualMs = timeoutMs(ms);
  const timer = setTimeout(() => controller.abort('timeout'), actualMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      throw aiError(`请求超时（${Math.round(actualMs / 1000)} 秒）`, 'timeout');
    }
    throw aiError(error?.message || '网络请求失败', 'network');
  } finally {
    clearTimeout(timer);
  }
}

function fallbackModel(settings, env) {
  return resolveWorkersAiModel(settings.ai_fallback_model, env.WORKERS_AI_MODEL, DEFAULT_FALLBACK_MODEL);
}

async function callWorkersAi(env, settings, messages, options = {}) {
  if (!env.AI) throw aiError('Workers AI binding (env.AI) not found', 'binding');
  const model = options.fallbackMode
    ? fallbackModel(settings, env)
    : resolveWorkersAiModel(settings.model, env.WORKERS_AI_MODEL);

  const input = {
    messages,
    temperature: Number.isFinite(options.temperature) ? options.temperature : 0.15,
    max_completion_tokens: 4096,
  };
  if (model.includes('/gemma-4-')) input.chat_template_kwargs = { enable_thinking: false };

  let response;
  try {
    response = await env.AI.run(model, input);
  } catch (error) {
    throw aiError(error?.message || 'Workers AI 调用失败', 'provider');
  }
  const text = extractWorkersAiText(response);
  if (!text) {
    throw aiError(`Workers AI response did not include generated content (${describeWorkersAiResponse(response)})`, 'empty');
  }
  return { text, provider: 'workers-ai', model, fallbackUsed: Boolean(options.fallbackMode) };
}

async function sendOpenAiRequest(url, settings, messages, options, useJsonMode) {
  const model = settings.model || 'gpt-4o-mini';
  const payload = {
    model,
    messages,
    temperature: Number.isFinite(options.temperature) ? options.temperature : 0.15,
  };
  if (useJsonMode) payload.response_format = { type: 'json_object' };

  return fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
    body: JSON.stringify(payload),
  }, options.timeoutMs);
}

async function callOpenAi(settings, messages, options = {}) {
  if (!settings.apiKey) throw aiError('OpenAI API Key 未配置', 'config');
  if (!settings.baseUrl) throw aiError('OpenAI Base URL 未配置', 'config');

  const url = normalizeOpenAiChatUrl(settings.baseUrl);
  const model = settings.model || 'gpt-4o-mini';

  // Agent 默认要求结构化 JSON。优先启用 OpenAI-compatible JSON mode；
  // 若中转站/模型不支持 response_format（常见为 400/422），自动无感重试普通请求。
  let response = await sendOpenAiRequest(url, settings, messages, options, options.jsonMode !== false);
  if (!response.ok && options.jsonMode !== false && (response.status === 400 || response.status === 422)) {
    response = await sendOpenAiRequest(url, settings, messages, options, false);
  }

  if (!response.ok) {
    const body = await response.text();
    const kind = response.status >= 500 ? '5xx' : 'http';
    throw aiError(`OpenAI API ${response.status}: ${body.slice(0, 600)}`, kind, response.status);
  }

  let data;
  try { data = await response.json(); }
  catch { throw aiError('OpenAI API 返回了无法解析的 JSON', 'format'); }
  const text = extractOpenAiText(data);
  if (!text) throw aiError('OpenAI response did not include generated content', 'empty');
  return { text, provider: 'openai', model, fallbackUsed: false };
}

async function callGemini(settings, messages, options = {}) {
  if (!settings.apiKey) throw aiError('Gemini API Key 未配置', 'config');
  const model = settings.model || 'gemini-1.5-flash';
  const systemMessage = messages.find(message => message.role === 'system')?.content || '';
  const contents = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(message.content || '') }],
  }));
  const payload = {
    contents,
    generationConfig: {
      temperature: Number.isFinite(options.temperature) ? options.temperature : 0.15,
      ...(options.jsonMode === false ? {} : { responseMimeType: 'application/json' }),
    },
  };
  if (systemMessage) payload.systemInstruction = { parts: [{ text: systemMessage }] };

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      body: JSON.stringify(payload),
    },
    options.timeoutMs,
  );
  if (!response.ok) {
    const body = await response.text();
    throw aiError(`Gemini API ${response.status}: ${body.slice(0, 600)}`, response.status >= 500 ? '5xx' : 'http', response.status);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  if (!text) throw aiError('Gemini response did not include generated content', 'empty');
  return { text, provider: 'gemini', model, fallbackUsed: false };
}

async function callProvider(env, settings, messages, options, provider) {
  if (provider === 'workers-ai') return callWorkersAi(env, settings, messages, options);
  if (provider === 'openai') return callOpenAi(settings, messages, options);
  if (provider === 'gemini') return callGemini(settings, messages, options);
  throw aiError(`Unsupported provider: ${provider}`, 'config');
}

export function isFallbackEnabledFor(settings, reason) {
  if (!settingEnabled(settings.ai_fallback_enabled, true)) return false;
  if ((settings.ai_fallback_provider || 'workers-ai') !== 'workers-ai') return false;
  if (reason === 'timeout' || reason === 'network') return settingEnabled(settings.ai_fallback_on_timeout, true);
  if (reason === '5xx') return settingEnabled(settings.ai_fallback_on_5xx, true);
  if (reason === 'empty') return settingEnabled(settings.ai_fallback_on_empty, true);
  if (reason === 'format') return settingEnabled(settings.ai_fallback_on_format, true);
  return false;
}

export async function callAssistantAiWithMeta(env, settings, messages, options = {}) {
  const primaryProvider = options.forceProvider || settings.provider || 'workers-ai';

  if (options.forceFallback) {
    if (!isFallbackEnabledFor(settings, options.fallbackReason || 'format')) {
      throw aiError('备用模型未启用或当前故障类型未允许切换', 'fallback-disabled');
    }
    const fallback = await callWorkersAi(env, settings, messages, { ...options, fallbackMode: true });
    return {
      ...fallback,
      fallbackUsed: true,
      fallbackFrom: settings.provider || 'workers-ai',
      fallbackReason: options.fallbackReason || 'manual',
    };
  }

  try {
    return await callProvider(env, settings, messages, options, primaryProvider);
  } catch (primaryError) {
    const reason = primaryError.aiKind || 'other';
    const allowFallback = options.allowFallback !== false
      && !options.forceProvider
      && primaryProvider !== 'workers-ai'
      && env.AI
      && isFallbackEnabledFor(settings, reason);

    if (allowFallback) {
      try {
        const fallback = await callWorkersAi(env, settings, messages, { ...options, fallbackMode: true });
        return {
          ...fallback,
          fallbackUsed: true,
          fallbackFrom: primaryProvider,
          fallbackReason: reason,
          primaryError: primaryError.message,
        };
      } catch (fallbackError) {
        throw new Error(`主模型失败：${primaryError.message}；备用 Workers AI 也失败：${fallbackError.message}`);
      }
    }
    throw primaryError;
  }
}

export async function callAssistantAi(env, settings, messages, options = {}) {
  const result = await callAssistantAiWithMeta(env, settings, messages, options);
  return result.text;
}
