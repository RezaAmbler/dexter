/**
 * Financial Modeling Prep provider.
 *
 * Translates Financial Datasets–style endpoint calls into the equivalent
 * FMP `stable/*` requests and normalizes the response back into the shape
 * the rest of the codebase expects.
 *
 * The legacy v3 endpoints were retired August 2025 — we only target the
 * current `stable` API surface.
 *
 * Free-tier-restricted endpoints (news, screener, etc.) are stubbed with
 * a clear error payload so tools degrade gracefully rather than throw.
 */
import { logger } from '../../../utils/logger.js';
import type { ApiParams, ApiResponse, FinanceProvider } from './types.js';

const BASE_URL = 'https://financialmodelingprep.com/stable';

type FmpPlanLevel = 'free' | 'starter' | 'premium' | 'ultimate';

function getApiKey(): string {
  return process.env.FMP_API_KEY || '';
}

function getPlanLevel(): FmpPlanLevel {
  const level = (process.env.FMP_API_KEY_LEVEL || 'free').toLowerCase();
  if (level === 'starter' || level === 'premium' || level === 'ultimate') return level;
  return 'free';
}

// ─── Low-level HTTP ─────────────────────────────────────────────────────────

interface FmpFetchOptions {
  /** Override path. Otherwise uses the path passed to fmpGet. */
  body?: Record<string, unknown>;
  method?: 'GET' | 'POST';
}

async function fmpFetch(
  path: string,
  query: Record<string, string | number | string[] | undefined>,
  opts: FmpFetchOptions = {},
): Promise<{ data: unknown; url: string }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn(`[FMP] call without key: ${path}`);
  }

  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, String(v)));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  url.searchParams.append('apikey', apiKey);

  const init: RequestInit = { method: opts.method ?? 'GET' };
  if (opts.body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[FMP] network error: ${path} — ${message}`);
    throw new Error(`[FMP] request failed for ${path}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[FMP] error: ${path} — ${detail}`);
    throw new Error(`[FMP] request failed: ${detail}`);
  }

  const data = await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[FMP] parse error: ${path} — ${detail}`);
    throw new Error(`[FMP] request failed: ${detail}`);
  });

  // FMP signals plan-restricted endpoints with a string starting with "Restricted Endpoint"
  // or an object with an "Error Message" field. Surface those as exceptions so callers can
  // catch and degrade instead of feeding garbage to the LLM.
  if (typeof data === 'string' && data.startsWith('Restricted Endpoint')) {
    throw new Error(`[FMP] restricted endpoint (upgrade plan): ${path}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && 'Error Message' in data) {
    const msg = (data as Record<string, unknown>)['Error Message'];
    throw new Error(`[FMP] ${msg ?? 'error'}: ${path}`);
  }

  return { data, url: url.toString() };
}

// ─── Normalization helpers ──────────────────────────────────────────────────

/** camelCase → snake_case (handles consecutive caps: EPSDiluted → eps_diluted). */
function snakeKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function snakeifyKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snakeifyKeys) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[snakeKey(k)] = snakeifyKeys(v);
  }
  return out as unknown as T;
}

/** Map FD `period` arg → FMP `period` arg. FD: annual|quarterly|ttm. FMP: annual|quarter. */
function fmpPeriod(fdPeriod: string | undefined): 'annual' | 'quarter' {
  if (!fdPeriod) return 'annual';
  return fdPeriod === 'quarterly' ? 'quarter' : 'annual';
}

/** Convert FMP fiscal period ("FY", "Q1", "Q2"...) back to FD's "annual"/"quarterly". */
function fdPeriodLabel(fmpPeriod: string | undefined): 'annual' | 'quarterly' | string {
  if (!fmpPeriod) return 'annual';
  if (fmpPeriod === 'FY') return 'annual';
  if (/^Q[1-4]$/.test(fmpPeriod)) return 'quarterly';
  return fmpPeriod;
}

/**
 * Convert an FMP fundamentals row (income/balance/cashflow) to FD-style.
 * FMP returns `date`, `period`, `reportedCurrency`, plus a large flat field map.
 * FD-style adds `report_period`, `period` ("annual"|"quarterly"), `currency`.
 */
function normalizeFundamentalsRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const snake = snakeifyKeys(row) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...snake };
  if (typeof snake.date === 'string') out.report_period = snake.date;
  if (typeof snake.reported_currency === 'string') out.currency = snake.reported_currency;
  if (typeof snake.period === 'string') out.period = fdPeriodLabel(snake.period as string);
  if (typeof snake.fiscal_year === 'string') out.fiscal_year = snake.fiscal_year;
  return out;
}

/** Apply FD-style report_period filters to an already-fetched list. FMP doesn't offer them server-side. */
function applyReportPeriodFilters(
  rows: Record<string, unknown>[],
  params: ApiParams,
): Record<string, unknown>[] {
  const gt = typeof params.report_period_gt === 'string' ? params.report_period_gt : null;
  const gte = typeof params.report_period_gte === 'string' ? params.report_period_gte : null;
  const lt = typeof params.report_period_lt === 'string' ? params.report_period_lt : null;
  const lte = typeof params.report_period_lte === 'string' ? params.report_period_lte : null;
  const eq = typeof params.report_period === 'string' ? params.report_period : null;

  return rows.filter((r) => {
    const d = typeof r.report_period === 'string' ? r.report_period : null;
    if (!d) return true;
    if (eq && d !== eq) return false;
    if (gt && !(d > gt)) return false;
    if (gte && !(d >= gte)) return false;
    if (lt && !(d < lt)) return false;
    if (lte && !(d <= lte)) return false;
    return true;
  });
}

function unsupported(endpoint: string, reason: string): ApiResponse {
  return {
    data: {
      error: 'endpoint_not_supported_on_fmp',
      endpoint,
      reason,
      provider: 'fmp',
      plan: getPlanLevel(),
    },
    url: '',
  };
}

// ─── Endpoint handlers ──────────────────────────────────────────────────────

async function handlePricesSnapshot(params: ApiParams): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').toUpperCase();
  const { data, url } = await fmpFetch('/quote', { symbol: ticker });
  const first = Array.isArray(data) && data.length > 0
    ? (data[0] as Record<string, unknown>)
    : {};
  const snake = snakeifyKeys(first) as Record<string, unknown>;
  return { data: { snapshot: snake }, url };
}

async function handlePricesHistorical(params: ApiParams): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').toUpperCase();
  const interval = typeof params.interval === 'string' ? params.interval : 'day';

  // FMP only offers daily on the eod/full endpoint at this tier. Tools accept
  // week/month/year too — for now we fetch daily and downsample/return-as-is.
  // (Caller usually post-processes; we surface the granularity in the response.)
  const { data, url } = await fmpFetch('/historical-price-eod/full', {
    symbol: ticker,
    from: params.start_date,
    to: params.end_date,
  });

  const rows = Array.isArray(data) ? data : [];
  const prices = rows.map((r) => {
    const snake = snakeifyKeys(r) as Record<string, unknown>;
    return {
      ticker,
      open: snake.open,
      high: snake.high,
      low: snake.low,
      close: snake.close,
      volume: snake.volume,
      time: snake.date,
    };
  });

  return {
    data: { prices, interval, _note: interval !== 'day' ? 'FMP free tier returns daily data only' : undefined },
    url,
  };
}

async function handleFinancialStatement(
  endpoint: '/financials/income-statements/' | '/financials/balance-sheets/' | '/financials/cash-flow-statements/',
  params: ApiParams,
): Promise<ApiResponse> {
  const fmpPath = {
    '/financials/income-statements/': '/income-statement',
    '/financials/balance-sheets/': '/balance-sheet-statement',
    '/financials/cash-flow-statements/': '/cash-flow-statement',
  }[endpoint];
  const wrapper = {
    '/financials/income-statements/': 'income_statements',
    '/financials/balance-sheets/': 'balance_sheets',
    '/financials/cash-flow-statements/': 'cash_flow_statements',
  }[endpoint];

  const fdPeriod = typeof params.period === 'string' ? params.period : 'annual';
  if (fdPeriod === 'ttm') {
    return unsupported(endpoint, 'FMP does not return TTM rolled-up statements; request annual or quarterly instead');
  }

  const ticker = String(params.ticker ?? '').toUpperCase();
  const limit = typeof params.limit === 'number' ? params.limit : 4;

  const { data, url } = await fmpFetch(fmpPath, {
    symbol: ticker,
    period: fmpPeriod(fdPeriod),
    limit,
  });

  const rows = Array.isArray(data) ? data.map((r) => normalizeFundamentalsRow(r as Record<string, unknown>)) : [];
  const filtered = applyReportPeriodFilters(rows, params);
  return { data: { [wrapper]: filtered }, url };
}

async function handleAllFinancials(params: ApiParams): Promise<ApiResponse> {
  const [income, balance, cashflow] = await Promise.all([
    handleFinancialStatement('/financials/income-statements/', params),
    handleFinancialStatement('/financials/balance-sheets/', params),
    handleFinancialStatement('/financials/cash-flow-statements/', params),
  ]);

  return {
    data: {
      financials: {
        income_statements: (income.data as { income_statements?: unknown }).income_statements ?? [],
        balance_sheets: (balance.data as { balance_sheets?: unknown }).balance_sheets ?? [],
        cash_flow_statements: (cashflow.data as { cash_flow_statements?: unknown }).cash_flow_statements ?? [],
      },
    },
    url: income.url,
  };
}

async function handleKeyRatiosSnapshot(params: ApiParams): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').toUpperCase();
  // Merge ratios-ttm + key-metrics-ttm for the broadest snapshot
  const [ratios, metrics] = await Promise.all([
    fmpFetch('/ratios-ttm', { symbol: ticker }).catch(() => ({ data: [], url: '' })),
    fmpFetch('/key-metrics-ttm', { symbol: ticker }).catch(() => ({ data: [], url: '' })),
  ]);

  const ratiosRow = Array.isArray(ratios.data) && ratios.data.length > 0
    ? (ratios.data[0] as Record<string, unknown>)
    : {};
  const metricsRow = Array.isArray(metrics.data) && metrics.data.length > 0
    ? (metrics.data[0] as Record<string, unknown>)
    : {};

  const merged = snakeifyKeys({ ...ratiosRow, ...metricsRow }) as Record<string, unknown>;
  return { data: { snapshot: merged }, url: ratios.url || metrics.url };
}

async function handleHistoricalKeyRatios(params: ApiParams): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').toUpperCase();
  const fdPeriod = typeof params.period === 'string' ? params.period : 'ttm';
  const limit = typeof params.limit === 'number' ? params.limit : 4;

  if (fdPeriod === 'ttm') {
    // For TTM history, FMP doesn't expose a series — we surface the current snapshot
    // as a single-element list so downstream code still works.
    const snap = await handleKeyRatiosSnapshot(params);
    const snapshot = (snap.data as { snapshot?: Record<string, unknown> }).snapshot ?? {};
    return { data: { financial_metrics: [snapshot] }, url: snap.url };
  }

  const [ratios, metrics] = await Promise.all([
    fmpFetch('/ratios', { symbol: ticker, period: fmpPeriod(fdPeriod), limit }).catch(() => ({ data: [], url: '' })),
    fmpFetch('/key-metrics', { symbol: ticker, period: fmpPeriod(fdPeriod), limit }).catch(() => ({ data: [], url: '' })),
  ]);

  // Zip the two arrays by date. Both endpoints return rows in the same order.
  const ratioRows = (Array.isArray(ratios.data) ? ratios.data : []) as Record<string, unknown>[];
  const metricRows = (Array.isArray(metrics.data) ? metrics.data : []) as Record<string, unknown>[];

  const metricsByDate = new Map<string, Record<string, unknown>>();
  for (const r of metricRows) {
    const d = typeof r.date === 'string' ? r.date : '';
    if (d) metricsByDate.set(d, r);
  }

  const merged = ratioRows.map((row) => {
    const date = typeof row.date === 'string' ? row.date : '';
    const partner = metricsByDate.get(date) ?? {};
    return normalizeFundamentalsRow({ ...row, ...partner });
  });

  const filtered = applyReportPeriodFilters(merged, params);
  return { data: { financial_metrics: filtered }, url: ratios.url || metrics.url };
}

async function handleEarnings(params: ApiParams): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').toUpperCase();
  const { data, url } = await fmpFetch('/earnings', { symbol: ticker, limit: 4 });
  const rows = Array.isArray(data) ? data : [];
  const normalized = rows.map((r) => snakeifyKeys(r as Record<string, unknown>) as Record<string, unknown>);
  return { data: { earnings: normalized }, url };
}

async function handleInsiderTrades(params: ApiParams): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').toUpperCase();
  const limit = typeof params.limit === 'number' ? params.limit : 10;

  try {
    const { data, url } = await fmpFetch('/insider-trading/latest', { symbol: ticker, limit });
    const rows = Array.isArray(data) ? data : [];
    const normalized = rows.map((r) => snakeifyKeys(r as Record<string, unknown>) as Record<string, unknown>);
    return { data: { insider_trades: normalized }, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unsupported('/insider-trades/', message);
  }
}

async function handleCryptoSnapshot(params: ApiParams): Promise<ApiResponse> {
  // FD uses "BTC-USD", FMP uses "BTCUSD"
  const ticker = String(params.ticker ?? '').toUpperCase().replace('-', '');
  const { data, url } = await fmpFetch('/quote', { symbol: ticker });
  const first = Array.isArray(data) && data.length > 0
    ? (data[0] as Record<string, unknown>)
    : {};
  return { data: { snapshot: snakeifyKeys(first) }, url };
}

async function handleCryptoHistorical(params: ApiParams): Promise<ApiResponse> {
  const ticker = String(params.ticker ?? '').toUpperCase().replace('-', '');
  const { data, url } = await fmpFetch('/historical-price-eod/full', {
    symbol: ticker,
    from: params.start_date,
    to: params.end_date,
  });
  const rows = Array.isArray(data) ? data : [];
  const prices = rows.map((r) => {
    const snake = snakeifyKeys(r) as Record<string, unknown>;
    return {
      ticker,
      open: snake.open,
      high: snake.high,
      low: snake.low,
      close: snake.close,
      volume: snake.volume,
      time: snake.date,
    };
  });
  return { data: { prices }, url };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

async function dispatchGet(endpoint: string, params: ApiParams): Promise<ApiResponse> {
  switch (endpoint) {
    // Stocks: prices
    case '/prices/snapshot/':
      return handlePricesSnapshot(params);
    case '/prices/':
      return handlePricesHistorical(params);
    case '/prices/snapshot/tickers/':
      return unsupported(endpoint, 'Ticker discovery is not wired up on FMP yet');

    // Fundamentals
    case '/financials/income-statements/':
    case '/financials/balance-sheets/':
    case '/financials/cash-flow-statements/':
      return handleFinancialStatement(endpoint, params);
    case '/financials/':
      return handleAllFinancials(params);
    case '/financials/segments/':
      return unsupported(endpoint, 'Revenue segmentation is paid-tier on FMP');

    // Ratios / metrics
    case '/financial-metrics/snapshot/':
      return handleKeyRatiosSnapshot(params);
    case '/financial-metrics/':
      return handleHistoricalKeyRatios(params);

    // Earnings
    case '/earnings':
      return handleEarnings(params);

    // News
    case '/news':
      return unsupported(endpoint, 'Stock news is restricted on the FMP free plan');

    // Insider
    case '/insider-trades/':
      return handleInsiderTrades(params);

    // SEC filings — stubbed in V1 (FMP gives metadata only; item parsing is out of scope)
    case '/filings/':
    case '/filings/items/':
      return unsupported(endpoint, 'SEC filing items are not yet implemented for FMP');

    // Screener
    case '/financials/search/screener/filters/':
      return unsupported(endpoint, 'Screener filter discovery is not yet implemented for FMP');

    // Crypto
    case '/crypto/prices/snapshot/':
      return handleCryptoSnapshot(params);
    case '/crypto/prices/':
      return handleCryptoHistorical(params);
    case '/crypto/prices/tickers/':
      return unsupported(endpoint, 'Crypto ticker discovery is not wired up on FMP yet');

    default:
      return unsupported(endpoint, 'no handler');
  }
}

async function dispatchPost(endpoint: string, _body: Record<string, unknown>): Promise<ApiResponse> {
  switch (endpoint) {
    case '/financials/search/screener/':
      return unsupported(endpoint, 'Screener is restricted on the FMP free plan');
    default:
      return unsupported(endpoint, 'no handler');
  }
}

export const fmpProvider: FinanceProvider = {
  name: 'fmp',
  get: dispatchGet,
  post: dispatchPost,
};
