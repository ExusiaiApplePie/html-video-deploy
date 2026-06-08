/**
 * @html-video/core — Xiaomi MiMo TTS provider.
 *
 * Xiaomi's Token Plan offers TTS via the OpenAI-compatible chat/completions
 * endpoint. The request body uses messages + audio config, and the response
 * returns base64-encoded audio in choices[0].message.audio.data.
 *
 * This is a drop-in alternative to MiniMax TTS — same return shape
 * (MinimaxAudioResult), different request/response format internally.
 *
 * TTS is FREE on Xiaomi Token Plan (0x token consumption during promo).
 *
 * Models:
 *   - mimo-v2.5-tts      : preset voices (mimo_default, 冰糖, 茉莉, 苏打, 白桦, Mia, Chloe, Milo, Dean)
 *   - mimo-v2.5-tts-voiceclone : clone from audio sample
 *   - mimo-v2.5-tts-voicedesign : generate voice from text description
 *   - mimo-v2-tts        : supports <style> tags (开心, 悲伤, 唱歌, etc.)
 */

import { HtmlVideoError } from './errors.js';
import type { MinimaxAudioResult } from './minimax.js';

const XIAOMI_DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const XIAOMI_DEFAULT_MODEL = 'mimo-v2.5-tts';
const XIAOMI_DEFAULT_VOICE = 'Chloe';
const XIAOMI_REQUEST_TIMEOUT_MS = 120_000;

export interface XiaomiTtsCredentials {
  apiKey: string;
  baseUrl: string;
}

/**
 * Resolve Xiaomi TTS credentials from environment.
 * Key precedence:  XIAOMI_API_KEY
 * Base precedence: XIAOMI_BASE_URL → default
 */
export function resolveXiaomiTtsCredentials(
  env: NodeJS.ProcessEnv = process.env,
): XiaomiTtsCredentials | null {
  const apiKey = (env.XIAOMI_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseUrl = (env.XIAOMI_BASE_URL || XIAOMI_DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

/**
 * Generate spoken narration via Xiaomi MiMo TTS.
 * Uses the OpenAI-compatible chat/completions endpoint.
 */
export async function generateXiaomiTts(opts: {
  text: string;
  voiceId?: string;
  model?: string;
  format?: 'wav' | 'mp3';
  creds: XiaomiTtsCredentials;
  signal?: AbortSignal;
}): Promise<MinimaxAudioResult> {
  const text = (opts.text || '').trim();
  if (!text) {
    throw new HtmlVideoError('invalid-input', 'narration text is empty');
  }

  const model = opts.model || XIAOMI_DEFAULT_MODEL;
  const voice = opts.voiceId || XIAOMI_DEFAULT_VOICE;
  const format = opts.format || 'mp3';

  const body = {
    model,
    messages: [{ role: 'assistant', content: text }],
    audio: { format, voice },
  };

  const timeoutSignal = AbortSignal.timeout(XIAOMI_REQUEST_TIMEOUT_MS);
  const effectiveSignal = opts.signal
    ? (AbortSignal.any ? AbortSignal.any([opts.signal, timeoutSignal]) : opts.signal)
    : timeoutSignal;

  let resp: Response;
  try {
    resp = await fetch(`${opts.creds.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.creds.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: effectiveSignal,
    });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const msg = e instanceof Error ? e.message : String(e);
    throw new HtmlVideoError(
      'render-failed',
      isTimeout
        ? `xiaomi tts timed out after ${Math.round(XIAOMI_REQUEST_TIMEOUT_MS / 1000)}s`
        : `xiaomi tts request failed: ${msg}`,
      true,
    );
  }

  const respText = await resp.text();
  if (!resp.ok) {
    throw new HtmlVideoError(
      'render-failed',
      `xiaomi tts ${resp.status}: ${respText.slice(0, 240)}`,
      resp.status >= 500,
    );
  }

  let data: {
    choices?: Array<{ message?: { audio?: { data?: string } } }>;
    error?: { message?: string };
  };
  try {
    data = JSON.parse(respText);
  } catch {
    throw new HtmlVideoError('render-failed', `xiaomi tts non-JSON: ${respText.slice(0, 200)}`);
  }

  if (data.error?.message) {
    throw new HtmlVideoError('render-failed', `xiaomi tts api error: ${data.error.message}`);
  }

  const audioData = data.choices?.[0]?.message?.audio?.data;
  if (typeof audioData !== 'string' || !audioData) {
    throw new HtmlVideoError('render-failed', 'xiaomi tts response missing choices[0].message.audio.data');
  }

  const bytes = Buffer.from(audioData, 'base64');
  if (bytes.length === 0) {
    throw new HtmlVideoError('render-failed', 'xiaomi tts decoded zero bytes');
  }

  return {
    bytes,
    ext: '.mp3',
    providerNote: `xiaomi/${model} · ${voice} · ${bytes.length} bytes`,
  };
}
