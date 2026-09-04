import { resolveWorkersAiModel } from './workers-ai-models';

const DEFAULT_AI_TIMEOUT_MS = 40000;

export function stripAssistantJsonFence(text) {
  return String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

export function parseAssistantJson(text) {
  const clean = stripAssistantJsonFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    // 兼容模型在 JSON 前后附带少量解释文本的情况。
  }

  const firstObject = clean.indexOf('{');
  const lastObject = clean.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    try {
      return JSON.parse(clean.slice(firstObject, lastObject + 1));
    } catch {
      // fall through
    }
  }

  return null;
}

export async function loadAssistantAiSettings(db) {
  const keys = ['provider', 'apiKey', 'baseUrl', 'model'];
  const { results } = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).bind(...keys).all();

  const settings = {};
  for (const row of results || []) {
    settings[row.key] = row.value;
  }
  return settings;
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
  if (content && !Array.isArray(content) && typeof content === 'object') {
    return stringifyStructuredContent(content);
  }
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

  const choiceMessage = response.choices?.[0]?.message;
  const choice = getMessageContentText(choiceMessage?.content);
  if (choice) return choice;

  const candidates = [
    response.output_text,
    response.generated_text,
    response.text,
    response.result?.response,
    response.result?.output_text,
    response.result?.generated_text,
    response.result?.text,
    response.result?.choices?.[0]?.message?.content,
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
    data?.output_text,
    data?.response,
    data?.result?.choices?.[0]?.message?.content,
    data?.result?.output_text,
    data?.data?.choices?.[0]?.message?.content,
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
    response.choices?.[0]?.message?.reasoning ||
    response.choices?.[0]?.message?.reasoning_content ||
    response.result?.choices?.[0]?.message?.reasoning ||
    response.result?.choices?.[0]?.message?.reasoning_content
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

async function fetchWithTimeout(url, init, ms = DEFAULT_AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs(ms));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`请求超时（${Math.round(timeoutMs(ms) / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callWorkersAi(env, settings, messages, options = {}) {
  if (!env.AI) throw new Error('Workers AI binding (env.AI) not found');

  // 正常使用 Workers AI 时可沿用后台模型；作为 GPT 的 fallback 时，不能把 GPT 模型名传给 Workers AI。
  const model = options.fallbackMode
    ? resolveWorkersAiModel(env.WORKERS_AI_MODEL)
    : resolveWorkersAiModel(settings.model, env.WORKERS_AI_MODEL);

  const input = {
    messages,
    temperature: Number.isFinite(options.temperature) ? options.temperature : 0.15,
    max_completion_tokens: 4096,
  };

  if (model.includes('/gemma-4-')) {
    input.chat_template_kwargs = { enable_thinking: false };
  }

  const response = await env.AI.run(model, input);
  const text = extractWorkersAiText(response);
  if (!text) {
    throw new Error(`Workers AI response did not include generated content (${describeWorkersAiResponse(response)})`);
  }

  return { text, provider: 'workers-ai', model, fallbackUsed: Boolean(options.fallbackMode) };
}

async function callOpenAi(env, settings, messages, options = {}) {
  if (!settings.apiKey) throw new Error('OpenAI API Key 未配置');
  if (!settings.baseUrl) throw new Error('OpenAI Base URL 未配置');

  const url = normalizeOpenAiChatUrl(settings.baseUrl);
  const model = settings.model || 'gpt-4o-mini';
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number.isFinite(options.temperature) ? options.temperature : 0.15,
    }),
  }, options.timeoutMs);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body.slice(0, 600)}`);
  }

  const data = await response.json();
  const text = extractOpenAiText(data);
  if (!text) throw new Error('OpenAI response did not include generated content');
  return { text, provider: 'openai', model, fallbackUsed: false };
}

async function callGemini(settings, messages, options = {}) {
  if (!settings.apiKey) throw new Error('Gemini API Key 未配置');

  const model = settings.model || 'gemini-1.5-flash';
  const systemMessage = messages.find(message => message.role === 'system')?.content || '';
  const contents = messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content || '') }],
    }));

  const payload = {
    contents,
    generationConfig: {
      temperature: Number.isFinite(options.temperature) ? options.temperature : 0.15,
    },
  };
  if (systemMessage) payload.systemInstruction = { parts: [{ text: systemMessage }] };

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey,
      },
      body: JSON.stringify(payload),
    },
    options.timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Gemini API ${response.status}: ${(await response.text()).slice(0, 600)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  if (!text) throw new Error('Gemini response did not include generated content');
  return { text, provider: 'gemini', model, fallbackUsed: false };
}

async function callProvider(env, settings, messages, options, provider) {
  if (provider === 'workers-ai') return callWorkersAi(env, settings, messages, options);
  if (provider === 'openai') return callOpenAi(env, settings, messages, options);
  if (provider === 'gemini') return callGemini(settings, messages, options);
  throw new Error(`Unsupported provider: ${provider}`);
}

export async function callAssistantAiWithMeta(env, settings, messages, options = {}) {
  const primaryProvider = options.forceProvider || settings.provider || 'workers-ai';
  const allowFallback = options.allowFallback !== false && !options.forceProvider;

  try {
    return await callProvider(env, settings, messages, options, primaryProvider);
  } catch (primaryError) {
    // GPT/中转站或 Gemini 故障时，自动回退到 Cloudflare Workers AI。
    // Workers AI 是部署级绑定，不依赖外部中转站，可作为稳定兜底。
    if (allowFallback && primaryProvider !== 'workers-ai' && env.AI) {
      try {
        const fallback = await callWorkersAi(env, settings, messages, { ...options, fallbackMode: true });
        return {
          ...fallback,
          fallbackUsed: true,
          fallbackFrom: primaryProvider,
          primaryError: primaryError.message,
        };
      } catch (fallbackError) {
        throw new Error(`主模型失败：${primaryError.message}；Workers AI 回退也失败：${fallbackError.message}`);
      }
    }
    throw primaryError;
  }
}

// 保留旧调用签名，其他调用方仍可只取得纯文本。
export async function callAssistantAi(env, settings, messages, options = {}) {
  const result = await callAssistantAiWithMeta(env, settings, messages, options);
  return result.text;
}
