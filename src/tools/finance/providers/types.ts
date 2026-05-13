/**
 * Provider abstraction for the finance data layer.
 *
 * All finance tools call `api.get(endpoint, params)` / `api.post(endpoint, body)`
 * using Financial Datasets–style endpoints (e.g. `/financials/income-statements/`).
 * A provider's job is to satisfy those calls — either by hitting that exact API
 * (the financialdatasets provider) or by translating to a different upstream
 * and normalizing the response back into the FD shape (e.g. the fmp provider).
 *
 * Tools never see which provider answered. Switching is a one-env-var change.
 */
export type ApiParams = Record<string, string | number | string[] | undefined>;

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

export interface FinanceProvider {
  /** Human-readable identifier, used in logs and cache keys. */
  readonly name: string;

  /** GET request against the provider, returning an FD-shaped response. */
  get(endpoint: string, params: ApiParams): Promise<ApiResponse>;

  /** POST request against the provider, returning an FD-shaped response. */
  post(endpoint: string, body: Record<string, unknown>): Promise<ApiResponse>;
}

/** Error thrown when an endpoint isn't supported on the active provider/plan. */
export class ProviderUnsupportedError extends Error {
  constructor(public readonly endpoint: string, message: string) {
    super(message);
    this.name = 'ProviderUnsupportedError';
  }
}
