
import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../_middleware';
import { getSettingsKeys, normalizeSettingValueForStorage } from '../lib/settings-parser';
import { sanitizeUrl } from '../lib/utils';
import { validateOpaqueText } from '../lib/validators';

const LAYOUT_SETTING_KEYS = new Set(getSettingsKeys());
const AI_SETTING_KEYS = new Set([
  'provider', 'apiKey', 'baseUrl', 'model',
  'ai_fallback_enabled', 'ai_fallback_provider', 'ai_fallback_model',
  'ai_fallback_on_timeout', 'ai_fallback_on_5xx', 'ai_fallback_on_empty', 'ai_fallback_on_format'
]);
// WebDAV 配置刻意不进 SETTINGS_SCHEMA：那份 schema 会被公开接口 /api/public-config 整体吐出去
const WEBDAV_SETTING_KEYS = new Set(['webdav_url', 'webdav_username', 'webdav_password', 'webdav_dir']);
const IGNORED_SETTING_KEYS = new Set(['has_api_key', 'debug_api_key_info', 'has_webdav_password']);
const ALLOWED_PROVIDERS = new Set(['workers-ai', 'gemini', 'openai']);
const ALLOWED_FALLBACK_PROVIDERS = new Set(['workers-ai']);
const BOOLEAN_AI_SETTING_KEYS = new Set([
  'ai_fallback_enabled', 'ai_fallback_on_timeout', 'ai_fallback_on_5xx',
  'ai_fallback_on_empty', 'ai_fallback_on_format'
]);

function normalizeWebdavSettingValue(key, value) {
  const rawText = String(value ?? '');
  const text = key === 'webdav_password' ? rawText : rawText.trim();

  if (key === 'webdav_url') {
    if (!text) return { ok: true, value: '' };
    const safeUrl = sanitizeUrl(text);
    if (!safeUrl) return { ok: false, message: 'Invalid webdav_url' };

    const parsed = new URL(safeUrl);
    if (parsed.protocol !== 'https:') {
      return { ok: false, message: 'webdav_url must use HTTPS' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, message: 'webdav_url must not contain credentials' };
    }

    return { ok: true, value: safeUrl };
  }

  if (key === 'webdav_dir') {
    if (!validateOpaqueText(text, 200).ok) {
      return { ok: false, message: 'Invalid webdav_dir' };
    }
    if (text.includes('\\')) {
      return { ok: false, message: 'Invalid webdav_dir' };
    }
    if (/%(?:2f|5c)/i.test(text)) {
      return { ok: false, message: 'Invalid webdav_dir' };
    }
    if (text.split('/').some(segment => segment.trim() === '..')) {
      return { ok: false, message: 'Invalid webdav_dir' };
    }
    return { ok: true, value: text };
  }

  if (key === 'webdav_username') {
    if (!validateOpaqueText(text, 256).ok) {
      return { ok: false, message: 'Invalid webdav_username' };
    }
    return { ok: true, value: text };
  }

  if (key === 'webdav_password') {
    const normalized = validateOpaqueText(rawText, 512);
    if (!normalized.ok) {
      return { ok: false, message: 'Invalid webdav_password' };
    }
    return { ok: true, value: normalized.value };
  }

  return { ok: false, message: `Unknown setting key: ${key}` };
}

function normalizeBooleanSetting(value, defaultValue = '0') {
  if (value === true || value === 1 || value === '1' || value === 'true') return { ok: true, value: '1' };
  if (value === false || value === 0 || value === '0' || value === 'false' || value === '') return { ok: true, value: '0' };
  return { ok: true, value: defaultValue };
}

function normalizeAiSettingValue(key, value) {
  const text = String(value ?? '').trim();

  if (BOOLEAN_AI_SETTING_KEYS.has(key)) {
    return normalizeBooleanSetting(value);
  }

  if (key === 'provider') {
    return ALLOWED_PROVIDERS.has(text)
      ? { ok: true, value: text }
      : { ok: false, message: 'Invalid provider' };
  }

  if (key === 'ai_fallback_provider') {
    return ALLOWED_FALLBACK_PROVIDERS.has(text || 'workers-ai')
      ? { ok: true, value: text || 'workers-ai' }
      : { ok: false, message: 'Invalid ai_fallback_provider' };
  }

  if (key === 'baseUrl') {
    if (!text) return { ok: true, value: '' };
    const safeUrl = sanitizeUrl(text);
    return safeUrl
      ? { ok: true, value: safeUrl.replace(/\/+$/, '') }
      : { ok: false, message: 'Invalid baseUrl' };
  }

  if (key === 'model' || key === 'ai_fallback_model') {
    if (!validateOpaqueText(text, 200).ok) {
      return { ok: false, message: `Invalid ${key}` };
    }
    return { ok: true, value: text };
  }

  if (key === 'apiKey') {
    if (!validateOpaqueText(text, 4096).ok) {
      return { ok: false, message: 'Invalid apiKey' };
    }
    return { ok: true, value: text };
  }

  return { ok: false, message: `Unknown setting key: ${key}` };
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const { results } = await env.NAV_DB.prepare('SELECT key, value FROM settings').all();

    const settings = {};
    if (results) {
      results.forEach(row => {
        if (IGNORED_SETTING_KEYS.has(row.key)) return;
        if (!LAYOUT_SETTING_KEYS.has(row.key) && !AI_SETTING_KEYS.has(row.key) && !WEBDAV_SETTING_KEYS.has(row.key)) return;

        if (row.key === 'apiKey' || row.key === 'webdav_password') {
          if (row.value && row.value.length > 0) {
            settings[row.key === 'apiKey' ? 'has_api_key' : 'has_webdav_password'] = true;
          } else {
            settings[row.key === 'apiKey' ? 'has_api_key' : 'has_webdav_password'] = false;
          }
        } else {
          settings[row.key] = row.value;
        }
      });
    }

    return jsonResponse({ code: 200, data: settings });
  } catch (e) {
    if (e.message && e.message.includes('no such table')) {
      return jsonResponse({ code: 200, data: {} });
    }
    return errorResponse(`Failed to fetch settings: ${e.message}`, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const body = await request.json();
    const settings = body;

    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return errorResponse('Invalid settings data', 400);
    }

    const normalizedEntries = [];
    for (const [key, value] of Object.entries(settings)) {
      if (IGNORED_SETTING_KEYS.has(key)) continue;

      if (key === 'webdav_password') {
        if (value === null) {
          normalizedEntries.push([key, '']);
          continue;
        }
        if (String(value ?? '') === '') continue;
      }

      let normalized;
      if (LAYOUT_SETTING_KEYS.has(key)) {
        normalized = normalizeSettingValueForStorage(key, value);
      } else if (AI_SETTING_KEYS.has(key)) {
        normalized = normalizeAiSettingValue(key, value);
      } else if (WEBDAV_SETTING_KEYS.has(key)) {
        normalized = normalizeWebdavSettingValue(key, value);
      } else {
        return errorResponse(`Invalid setting key: ${key}`, 400);
      }

      if (!normalized.ok) return errorResponse(normalized.message, 400);
      normalizedEntries.push([key, normalized.value]);
    }

    let changedEntries = normalizedEntries;
    if (normalizedEntries.length > 0) {
      const keys = normalizedEntries.map(([key]) => key);
      const placeholders = keys.map(() => '?').join(',');
      const { results = [] } = await env.NAV_DB
        .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
        .bind(...keys)
        .all();
      const existingSettings = new Map(results.map(row => [row.key, row.value]));
      changedEntries = normalizedEntries.filter(([key, value]) => existingSettings.get(key) !== value);
    }

    if (changedEntries.length > 0) {
      const stmt = env.NAV_DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      await env.NAV_DB.batch(changedEntries.map(([key, value]) => stmt.bind(key, value)));
    }

    const touchesRenderedSettings = normalizedEntries.some(([key]) => !WEBDAV_SETTING_KEYS.has(key));
    if (touchesRenderedSettings) {
      try {
        await Promise.all([
          env.NAV_AUTH.delete('settings_cache'),
          markHomeCacheDirty(env, 'all'),
        ]);
      } catch (e) {
        console.warn('Failed to clear caches:', e);
      }
    }

    return jsonResponse({ code: 200, message: 'Settings saved' });
  } catch (e) {
    return errorResponse(`Failed to save settings: ${e.message}`, 500);
  }
}
