/**
 * Smoke test for the FMP finance provider.
 *
 * Hits each endpoint through the public `api` interface to confirm the
 * provider abstraction and FMP normalization actually produce
 * Financial Datasets–shaped responses for downstream tools.
 *
 * Run with:
 *   FINANCE_PROVIDER=fmp FMP_API_KEY=... FMP_API_KEY_LEVEL=free \
 *     npx tsx scripts/smoke-fmp.ts
 */
import { api } from '../src/tools/finance/api.js';

type Check = {
  name: string;
  endpoint: string;
  run: () => Promise<unknown>;
  /** Field on `data` we expect populated, or "_error" for stubbed endpoints. */
  expect: string;
};

const TICKER = 'AAPL';

const checks: Check[] = [
  {
    name: 'price snapshot',
    endpoint: '/prices/snapshot/',
    run: () => api.get('/prices/snapshot/', { ticker: TICKER }),
    expect: 'snapshot',
  },
  {
    name: 'historical prices (10d)',
    endpoint: '/prices/',
    run: () =>
      api.get('/prices/', {
        ticker: TICKER,
        interval: 'day',
        start_date: '2025-01-02',
        end_date: '2025-01-15',
      }),
    expect: 'prices',
  },
  {
    name: 'income statements',
    endpoint: '/financials/income-statements/',
    run: () =>
      api.get('/financials/income-statements/', {
        ticker: TICKER,
        period: 'annual',
        limit: 2,
      }),
    expect: 'income_statements',
  },
  {
    name: 'balance sheets',
    endpoint: '/financials/balance-sheets/',
    run: () =>
      api.get('/financials/balance-sheets/', {
        ticker: TICKER,
        period: 'annual',
        limit: 2,
      }),
    expect: 'balance_sheets',
  },
  {
    name: 'cash flow statements',
    endpoint: '/financials/cash-flow-statements/',
    run: () =>
      api.get('/financials/cash-flow-statements/', {
        ticker: TICKER,
        period: 'annual',
        limit: 2,
      }),
    expect: 'cash_flow_statements',
  },
  {
    name: 'all financials',
    endpoint: '/financials/',
    run: () =>
      api.get('/financials/', { ticker: TICKER, period: 'annual', limit: 2 }),
    expect: 'financials',
  },
  {
    name: 'key ratios snapshot',
    endpoint: '/financial-metrics/snapshot/',
    run: () => api.get('/financial-metrics/snapshot/', { ticker: TICKER }),
    expect: 'snapshot',
  },
  {
    name: 'historical key ratios (annual)',
    endpoint: '/financial-metrics/',
    run: () =>
      api.get('/financial-metrics/', {
        ticker: TICKER,
        period: 'annual',
        limit: 2,
      }),
    expect: 'financial_metrics',
  },
  {
    name: 'earnings',
    endpoint: '/earnings',
    run: () => api.get('/earnings', { ticker: TICKER }),
    expect: 'earnings',
  },
  {
    name: 'insider trades',
    endpoint: '/insider-trades/',
    run: () => api.get('/insider-trades/', { ticker: TICKER, limit: 3 }),
    expect: 'insider_trades',
  },

  // Endpoints we expect to be unsupported on free / not yet implemented
  {
    name: 'news (expected: stub)',
    endpoint: '/news',
    run: () => api.get('/news', { ticker: TICKER, limit: 3 }),
    expect: 'error',
  },
  {
    name: 'segments (expected: stub)',
    endpoint: '/financials/segments/',
    run: () =>
      api.get('/financials/segments/', {
        ticker: TICKER,
        period: 'annual',
        limit: 2,
      }),
    expect: 'error',
  },
  {
    name: 'filings (expected: stub)',
    endpoint: '/filings/',
    run: () => api.get('/filings/', { ticker: TICKER, limit: 3 }),
    expect: 'error',
  },
];

function summarize(value: unknown, expect: string): string {
  if (!value || typeof value !== 'object') return `unexpected: ${typeof value}`;
  const data = (value as { data?: Record<string, unknown> }).data;
  if (!data) return 'no data field';
  if (expect === 'error') {
    return data.error ? `stub ok (${data.error})` : `expected stub, got ${Object.keys(data).join(',')}`;
  }
  const target = data[expect];
  if (target === undefined) return `missing "${expect}" field; keys: ${Object.keys(data).join(',')}`;
  if (Array.isArray(target)) return `${expect}: ${target.length} item(s)`;
  if (typeof target === 'object' && target !== null) {
    const keys = Object.keys(target as Record<string, unknown>);
    return `${expect}: ${keys.length} key(s)`;
  }
  return `${expect}: ${String(target).slice(0, 40)}`;
}

(async () => {
  console.log(`Provider: ${process.env.FINANCE_PROVIDER}`);
  console.log(`Plan:     ${process.env.FMP_API_KEY_LEVEL ?? '(unset)'}`);
  console.log('');

  let pass = 0;
  let fail = 0;
  for (const check of checks) {
    try {
      const result = await check.run();
      const line = summarize(result, check.expect);
      const ok = !line.startsWith('expected') && !line.startsWith('missing') && !line.startsWith('unexpected');
      console.log(`${ok ? '✓' : '✗'} ${check.name.padEnd(38)} ${line}`);
      if (ok) pass++; else fail++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`✗ ${check.name.padEnd(38)} threw: ${message}`);
      fail++;
    }
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed (${checks.length} total)`);
  process.exit(fail === 0 ? 0 : 1);
})();
