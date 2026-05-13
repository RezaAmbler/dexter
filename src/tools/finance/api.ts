/**
 * Finance API router.
 *
 * Tools call `api.get(endpoint, params, options)` using
 * Financial Datasets–style endpoint strings (e.g. `/prices/`).
 * This module routes those calls to whichever provider is active
 * (FINANCE_PROVIDER env var) and layers caching on top.
 *
 * Caches are namespaced per-provider so switching providers does not
 * serve stale entries shaped for a different upstream.
 */
import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { financialDatasetsProvider } from './providers/financialdatasets.js';
import { fmpProvider } from './providers/fmp.js';
import type { ApiParams, ApiResponse, FinanceProvider } from './providers/types.js';

export type { ApiResponse } from './providers/types.js';

const PROVIDERS: Record<string, FinanceProvider> = {
  financialdatasets: financialDatasetsProvider,
  fmp: fmpProvider,
};

let warnedAboutUnknown = false;

function getProvider(): FinanceProvider {
  const requested = (process.env.FINANCE_PROVIDER || 'financialdatasets').toLowerCase();
  const provider = PROVIDERS[requested];
  if (provider) return provider;

  if (!warnedAboutUnknown) {
    logger.warn(
      `[Finance API] unknown FINANCE_PROVIDER="${requested}" — falling back to financialdatasets. ` +
      `Known providers: ${Object.keys(PROVIDERS).join(', ')}`,
    );
    warnedAboutUnknown = true;
  }
  return financialDatasetsProvider;
}

/** Build a provider-scoped cache key prefix so different upstreams don't share cache entries. */
function cacheEndpoint(provider: FinanceProvider, endpoint: string): string {
  return `${provider.name}:${endpoint}`;
}

/**
 * Remove redundant fields from API payloads before they are returned to the LLM.
 * This reduces token usage while preserving the financial metrics needed for analysis.
 */
export function stripFieldsDeep(value: unknown, fields: readonly string[]): unknown {
  const fieldsToStrip = new Set(fields);

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (fieldsToStrip.has(key)) continue;
      cleaned[key] = walk(child);
    }
    return cleaned;
  }

  return walk(value);
}

export const api = {
  async get(
    endpoint: string,
    params: ApiParams,
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<ApiResponse> {
    const provider = getProvider();
    const label = describeRequest(endpoint, params);
    const cacheKey = cacheEndpoint(provider, endpoint);

    if (options?.cacheable) {
      const cached = readCache(cacheKey, params, options.ttlMs);
      if (cached) return cached;
    }

    let response: ApiResponse;
    try {
      response = await provider.get(endpoint, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${provider.name}] ${label} — ${message}`);
      throw error;
    }

    if (options?.cacheable) {
      writeCache(cacheKey, params, response.data, response.url);
    }

    return response;
  },

  async post(endpoint: string, body: Record<string, unknown>): Promise<ApiResponse> {
    const provider = getProvider();
    try {
      return await provider.post(endpoint, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${provider.name}] POST ${endpoint} — ${message}`);
      throw error;
    }
  },
};

/** @deprecated Use `api.get` instead */
export const callApi = api.get;
