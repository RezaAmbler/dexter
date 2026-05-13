/**
 * Financial Datasets provider — the original/default backend.
 *
 * Hits api.financialdatasets.ai directly. Endpoint strings are passed
 * through unchanged; the response shape is already what the tools expect.
 */
import { logger } from '../../../utils/logger.js';
import type { ApiParams, ApiResponse, FinanceProvider } from './types.js';

const BASE_URL = 'https://api.financialdatasets.ai';

function getApiKey(): string {
  return process.env.FINANCIAL_DATASETS_API_KEY || '';
}

async function executeRequest(
  url: string,
  label: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const apiKey = getApiKey();

  if (!apiKey) {
    logger.warn(`[Financial Datasets API] call without key: ${label}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'x-api-key': apiKey,
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Financial Datasets API] network error: ${label} — ${message}`);
    throw new Error(`[Financial Datasets API] request failed for ${label}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[Financial Datasets API] error: ${label} — ${detail}`);
    throw new Error(`[Financial Datasets API] request failed: ${detail}`);
  }

  const data = await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[Financial Datasets API] parse error: ${label} — ${detail}`);
    throw new Error(`[Financial Datasets API] request failed: ${detail}`);
  });

  return data as Record<string, unknown>;
}

function buildUrl(endpoint: string, params: ApiParams): URL {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, v));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url;
}

export const financialDatasetsProvider: FinanceProvider = {
  name: 'financialdatasets',

  async get(endpoint, params) {
    const url = buildUrl(endpoint, params);
    const data = await executeRequest(url.toString(), endpoint, {});
    return { data, url: url.toString() };
  },

  async post(endpoint, body) {
    const url = `${BASE_URL}${endpoint}`;
    const data = await executeRequest(url, `POST ${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { data, url };
  },
};
