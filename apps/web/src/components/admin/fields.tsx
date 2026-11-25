import { fieldClass } from './auth-card';

interface BaseProps {
  label: string;
  name: string;
  hint?: string;
}

export function TextField({
  label,
  name,
  hint,
  defaultValue,
  maxLength,
  required,
  inputMode,
  onChange,
}: BaseProps & {
  defaultValue?: string | null | undefined;
  maxLength?: number;
  required?: boolean;
  inputMode?: 'text' | 'decimal' | 'numeric';
  onChange?: (value: string) => void;
}) {
  return (
    <label className="block">
      {label}
      <input
        name={name}
        defaultValue={defaultValue ?? ''}
        maxLength={maxLength}
        required={required}
        inputMode={inputMode}
        onChange={
          onChange === undefined
            ? undefined
            : (event) => {
                onChange(event.currentTarget.value);
              }
        }
        className={fieldClass}
      />
      {hint === undefined ? null : (
        <span className="mt-1 block text-sm text-text-muted">{hint}</span>
      )}
    </label>
  );
}

export function TextArea({
  label,
  name,
  defaultValue,
  maxLength,
  rows = 4,
  onChange,
}: BaseProps & {
  defaultValue?: string | null | undefined;
  maxLength?: number;
  rows?: number;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="block">
      {label}
      <textarea
        name={name}
        defaultValue={defaultValue ?? ''}
        maxLength={maxLength}
        rows={rows}
        onChange={
          onChange === undefined
            ? undefined
            : (event) => {
                onChange(event.currentTarget.value);
              }
        }
        className={`${fieldClass} py-2`}
      />
    </label>
  );
}

export function CheckField({
  label,
  name,
  defaultChecked,
}: BaseProps & { defaultChecked?: boolean | undefined }) {
  return (
    <label className="flex min-h-11 items-center gap-2">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="size-5" />
      {label}
    </label>
  );
}

export function SelectField({
  label,
  name,
  defaultValue,
  options,
}: BaseProps & {
  defaultValue?: string | undefined;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <label className="block">
      {label}
      <select name={name} defaultValue={defaultValue} className={fieldClass}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What a form reports back: a polite live region, never colour alone. */
export function StatusLine({
  message,
}: {
  message: { kind: 'ok' | 'error'; text: string } | null;
}) {
  return (
    <p
      role={message?.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={`min-h-6 ${message?.kind === 'error' ? 'text-danger' : 'text-text-muted'}`}
    >
      {message?.text ?? ''}
    </p>
  );
}
