/**
 * A small Nova Poshta directory for local work and CI: a few cities with a
 * handful of branches. The refs are made up (the real ones are 36-character
 * UUIDs from the carrier API and arrive with the worker sync).
 */
import { npSettlements, npWarehouses } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';

const CITIES = [
  { key: 'kyiv', name: 'Київ', area: 'Київська', branches: 5 },
  { key: 'lviv', name: 'Львів', area: 'Львівська', branches: 4 },
  { key: 'odesa', name: 'Одеса', area: 'Одеська', branches: 4 },
  { key: 'dnipro', name: 'Дніпро', area: 'Дніпропетровська', branches: 3 },
  { key: 'kharkiv', name: 'Харків', area: 'Харківська', branches: 3 },
  { key: 'kyivske', name: 'Київське', area: 'Одеська', branches: 1 },
] as const;

export async function seedNpDirectory(tx: Tx): Promise<void> {
  await tx.insert(npSettlements).values(
    CITIES.map((city) => ({
      ref: `seed-city-${city.key}`,
      nameUk: city.name,
      areaNameUk: `${city.area} область`,
      settlementTypeUk: 'місто',
      warehousesCount: city.branches,
    })),
  );
  await tx.insert(npWarehouses).values(
    CITIES.flatMap((city) =>
      Array.from({ length: city.branches }, (_, index) => ({
        ref: `seed-wh-${city.key}-${String(index + 1)}`,
        settlementRef: `seed-city-${city.key}`,
        number: String(index + 1),
        descriptionUk: `Відділення №${String(index + 1)}: ${city.name}, вул. Центральна, ${String(index + 1)}`,
        type: 'branch' as const,
      })),
    ),
  );
}
