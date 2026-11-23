'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

interface City {
  ref: string;
  name: string;
  area: string | null;
}
interface Branch {
  ref: string;
  number: string;
  description: string;
}

const FIELD = 'min-h-10 rounded-sm border border-border bg-surface px-3';

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/** City autocomplete and (optionally) branch choice, both read from our own directory. */
export function CityPicker({
  needBranch,
  onChange,
}: {
  needBranch: boolean;
  onChange: (value: { settlementRef: string; warehouseRef: string }) => void;
}) {
  const t = useTranslations('checkout');
  const cityId = useId();
  const branchId = useId();
  const [text, setText] = useState('');
  const [cities, setCities] = useState<City[]>([]);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<City | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState('');

  useEffect(() => {
    if (chosen !== null || text.trim().length < 2) {
      setCities([]);
      return;
    }
    const timer = setTimeout(() => {
      void fetchJson<{ cities: City[] }>(
        `/api/np/cities?q=${encodeURIComponent(text.trim())}`,
      ).then((data) => {
        setFailed(data === null);
        setCities(data?.cities ?? []);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [text, chosen]);

  useEffect(() => {
    onChange({ settlementRef: chosen?.ref ?? '', warehouseRef: needBranch ? branch : '' });
  }, [chosen, branch, needBranch, onChange]);

  useEffect(() => {
    setBranch('');
    if (chosen === null || !needBranch) {
      setBranches([]);
      return;
    }
    void fetchJson<{ warehouses: Branch[] }>(
      `/api/np/warehouses?city=${encodeURIComponent(chosen.ref)}`,
    ).then((data) => {
      setFailed(data === null);
      setBranches(data?.warehouses ?? []);
    });
  }, [chosen, needBranch]);

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={cityId} className="flex flex-col gap-1 text-sm">
        {t('city')}
        <input
          id={cityId}
          value={text}
          autoComplete="off"
          aria-describedby={`${cityId}-help`}
          onChange={(event) => {
            setText(event.target.value);
            setChosen(null);
          }}
          className={FIELD}
        />
      </label>
      <p id={`${cityId}-help`} className="text-xs text-text-muted">
        {t('cityHelp')}
      </p>
      <div aria-live="polite">
        {failed ? <p className="text-sm text-danger">{t('directoryDown')}</p> : null}
        {cities.length === 0 || chosen !== null ? null : (
          <ul className="flex flex-col rounded-sm border border-border">
            {cities.map((city) => (
              <li key={city.ref}>
                <button
                  type="button"
                  className="min-h-10 w-full px-3 text-left hover:bg-surface-raised"
                  onClick={() => {
                    setChosen(city);
                    setText(city.name);
                    setCities([]);
                  }}
                >
                  {city.name}
                  {city.area === null ? '' : `, ${city.area}`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {needBranch && chosen !== null ? (
        <label htmlFor={branchId} className="flex flex-col gap-1 text-sm">
          {t('branch')}
          <select
            id={branchId}
            value={branch}
            required
            onChange={(event) => {
              setBranch(event.target.value);
            }}
            className={FIELD}
          >
            <option value="">{t('branchChoose')}</option>
            {branches.map((item) => (
              <option key={item.ref} value={item.ref}>
                {item.description}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
