import type { z } from 'zod';
import { log } from '../log.js';

/**
 * Minimal client for the Gemini Interactions API (POST /v1beta/interactions).
 * Raw fetch instead of the SDK: one endpoint, fully controlled retries/timeouts, no beta-SDK churn.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface MapsTool {
  type: 'google_maps';
  latitude: number;
  longitude: number;
}

export interface PlaceCitation {
  place_id: string | null;
  name: string;
  url: string;
}

export interface InteractionResult {
  text: string;
  /** place_citation annotations of the final answer (often missing even when Maps was used). */
  citations: PlaceCitation[];
  /** Every place the Maps tool returned (google_maps_result steps); used when citations are missing. */
  mapsPlaces: PlaceCitation[];
  mapsQueries: number;
  usage: { input: number; output: number; thought: number };
}

export interface InteractOptions {
  system?: string;
  input: string;
  tools?: MapsTool[];
  /** JSON schema for structured output (not combined with tools in this bot). */
  jsonSchema?: Record<string, unknown>;
  thinking?: ThinkingLevel;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Short label for logs. */
  label: string;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

interface RawStep {
  type?: string;
  content?: { type?: string; text?: string; annotations?: RawAnnotation[] }[];
  arguments?: { queries?: string[] };
  result?: { places?: { place_id?: string; name?: string; url?: string }[] }[];
}
interface RawAnnotation {
  type?: string;
  place_id?: string;
  name?: string;
  url?: string;
}
interface RawInteraction {
  status?: string;
  steps?: RawStep[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    grounding_tool_count?: { type?: string; count?: number }[];
  };
}

/** Pull the final answer + Google Maps citations out of an interaction's steps. */
export function extractResult(raw: RawInteraction): InteractionResult {
  // Tool and thought steps come first (2-12 of them); the answer is the LAST model_output step.
  const final = (raw.steps ?? []).filter((s) => s.type === 'model_output').at(-1);
  const texts: string[] = [];
  const citations: PlaceCitation[] = [];
  const seen = new Set<string>();
  if (final) {
    for (const c of final.content ?? []) {
      if (c.type && c.type !== 'text') continue;
      if (c.text) texts.push(c.text);
      for (const a of c.annotations ?? []) {
        // Keep every distinct source link (a place and "Review of <place>" share a place_id but differ in url).
        if (a.type !== 'place_citation' || !a.url || !a.name) continue;
        if (seen.has(a.url)) continue;
        seen.add(a.url);
        citations.push({ place_id: a.place_id ?? null, name: a.name, url: a.url });
      }
    }
  }
  const mapsPlaces: PlaceCitation[] = [];
  const seenPlaces = new Set<string>();
  for (const step of raw.steps ?? []) {
    if (step.type !== 'google_maps_result') continue;
    for (const r of step.result ?? []) {
      for (const p of r.places ?? []) {
        if (!p.url || !p.name || seenPlaces.has(p.url)) continue;
        seenPlaces.add(p.url);
        mapsPlaces.push({ place_id: p.place_id ?? null, name: p.name, url: p.url });
      }
    }
  }
  const mapsQueries = (raw.usage?.grounding_tool_count ?? [])
    .filter((g) => g.type === 'google_maps')
    .reduce((n, g) => n + (g.count ?? 0), 0);
  return {
    text: texts.join('').trim(),
    citations,
    mapsPlaces,
    mapsQueries,
    usage: {
      input: raw.usage?.total_input_tokens ?? 0,
      output: raw.usage?.total_output_tokens ?? 0,
      thought: raw.usage?.total_thought_tokens ?? 0,
    },
  };
}

function parseError(status: number, body: string): GeminiError {
  let code = `http_${status}`;
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as unknown;
    // Interactions errors: {"error":{"code":"not_found","message":...}}; auth errors: [{"error":{"status":"INVALID_ARGUMENT",...}}]
    const errObj = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { code?: unknown; status?: unknown; message?: unknown } };
    if (errObj?.error) {
      code = String(errObj.error.status ?? errObj.error.code ?? code);
      message = String(errObj.error.message ?? message);
    }
  } catch {
    /* non-JSON body */
  }
  // A depleted daily quota won't recover within our retry window.
  const retryable = RETRYABLE_STATUS.has(status) && !/quota_exceeded|RESOURCE_EXHAUSTED.*per day/i.test(`${code} ${message}`);
  return new GeminiError(`Gemini ${status} ${code}: ${message}`, status, code, retryable);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Gemini {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly maxRetries = 2,
  ) {}

  async interact(opts: InteractOptions): Promise<InteractionResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: opts.input,
      store: false, // no server-side history needed (and Maps-grounded results must not be kept around)
      generation_config: {
        thinking_level: opts.thinking ?? 'low',
        max_output_tokens: opts.maxOutputTokens ?? 4096,
      },
    };
    if (opts.system) body.system_instruction = opts.system;
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.jsonSchema) body.response_format = { type: 'text', mime_type: 'application/json', schema: opts.jsonSchema };

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? (opts.tools?.length ? 60_000 : 30_000)),
        });
        const text = await res.text();
        if (!res.ok) throw parseError(res.status, text);
        const raw = JSON.parse(text) as RawInteraction;
        const result = extractResult(raw);
        log.info('gemini', `${opts.label} ok`, {
          ms: Date.now() - started,
          status: raw.status,
          maps_queries: result.mapsQueries,
          citations: result.citations.length,
          usage: result.usage,
        });
        if (raw.status && raw.status !== 'completed') {
          throw new GeminiError(`Gemini interaction ${raw.status} (output token limit?)`, 200, raw.status, true);
        }
        if (!result.text) throw new GeminiError('Gemini returned no text', 200, 'empty', true);
        return result;
      } catch (err) {
        const e =
          err instanceof GeminiError
            ? err
            : new GeminiError(`Gemini request failed: ${(err as Error).message}`, 0, (err as Error).name ?? 'network', true);
        if (!e.retryable || attempt >= this.maxRetries) {
          log.error('gemini', `${opts.label} failed`, { attempt, error: e.message });
          throw e;
        }
        const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
        log.warn('gemini', `${opts.label} retry in ${Math.round(delay)}ms`, { attempt, error: e.message });
        await sleep(delay);
      }
    }
  }

  /** Structured output validated with zod. */
  async json<T>(opts: Omit<InteractOptions, 'jsonSchema' | 'tools'> & { schema: z.ZodType<T>; jsonSchema: Record<string, unknown> }): Promise<T> {
    const { schema, ...rest } = opts;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.interact(rest);
      try {
        return schema.parse(JSON.parse(stripFences(res.text)));
      } catch (err) {
        log.warn('gemini', `${opts.label} returned invalid JSON`, { attempt, error: (err as Error).message, text: res.text.slice(0, 300) });
      }
    }
    throw new GeminiError(`${opts.label}: model returned invalid JSON twice`, 200, 'invalid_json', false);
  }
}

function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1]! : text;
}
