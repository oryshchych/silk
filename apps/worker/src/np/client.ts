/**
 * Nova Poshta API 2.0 reads for the directory sync. NOT verified against the real API yet
 * (owner queue Q2: no key): the request and response shapes follow the public documentation
 * and are exercised through recorded fixtures only. The key stays in the request body, as the
 * API requires, and is never logged.
 */
export interface NpCity {
  ref: string;
  name: string;
  area: string | null;
  type: string | null;
}

export interface NpBranch {
  ref: string;
  cityRef: string;
  number: string;
  description: string;
  kind: 'branch' | 'postomat' | 'cargo';
  maxWeightKg: number | null;
  latitude: number | null;
  longitude: number | null;
  isActive: boolean;
}

export interface NovaPoshtaDirectory {
  /** A page of cities; fewer rows than `limit` means the last page. */
  cities(page: number, limit: number): Promise<NpCity[]>;
  branches(page: number, limit: number): Promise<NpBranch[]>;
}

const ENDPOINT = 'https://api.novaposhta.ua/v2.0/json/';
const TIMEOUT_MS = 30_000;

export class NovaPoshtaError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NovaPoshtaError';
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const num = (value: unknown): number | null => {
  const parsed =
    typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
};
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};

export function parseCities(rows: unknown[]): NpCity[] {
  return rows.flatMap((row) => {
    const r = record(row);
    const ref = text(r['Ref']);
    const name = text(r['Description']);
    return ref === null || name === null
      ? []
      : [
          {
            ref,
            name,
            area: text(r['AreaDescription']),
            type: text(r['SettlementTypeDescription']),
          },
        ];
  });
}

export function parseBranches(rows: unknown[]): NpBranch[] {
  return rows.flatMap((row) => {
    const r = record(row);
    const ref = text(r['Ref']);
    const cityRef = text(r['CityRef']);
    const description = text(r['Description']);
    if (ref === null || cityRef === null || description === null) return [];
    const category = text(r['CategoryOfWarehouse']);
    return [
      {
        ref,
        cityRef,
        number: text(r['Number']) ?? '0',
        description,
        kind: category === 'Postomat' ? 'postomat' : category === 'Cargo' ? 'cargo' : 'branch',
        maxWeightKg: num(r['TotalMaxWeightAllowed']),
        latitude: num(r['Latitude']),
        longitude: num(r['Longitude']),
        isActive: text(r['WarehouseStatus']) === 'Working',
      },
    ];
  });
}

export function createNovaPoshtaDirectory(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
}): NovaPoshtaDirectory {
  const doFetch = options.fetchImpl ?? fetch;
  async function call(
    model: string,
    method: string,
    page: number,
    limit: number,
  ): Promise<unknown[]> {
    const response = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: options.apiKey,
        modelName: model,
        calledMethod: method,
        methodProperties: { Page: String(page), Limit: String(limit) },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {
      throw new NovaPoshtaError('carrier API unreachable');
    });
    if (!response.ok) throw new NovaPoshtaError(`carrier API answered ${String(response.status)}`);
    const body = record(await response.json());
    const data = body['data'];
    if (body['success'] !== true || !Array.isArray(data)) {
      throw new NovaPoshtaError('carrier API refused the request');
    }
    const rows: unknown[] = data;
    return rows;
  }
  return {
    cities: async (page, limit) => parseCities(await call('Address', 'getCities', page, limit)),
    branches: async (page, limit) =>
      parseBranches(await call('AddressGeneral', 'getWarehouses', page, limit)),
  };
}
