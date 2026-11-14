import type { ChangeEvent } from 'react';

export interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number | 'any';
  placeholder?: string;
  invalid?: boolean;
  className?: string;
}

/** Number input; an empty field reports NaN (caught by validation). */
export function NumberField({ value, onChange, label, disabled, min = 0, max, step = 'any', placeholder, invalid, className }: NumberFieldProps) {
  return (
    <input
      type="number"
      className={className ?? 'num'}
      aria-label={label}
      value={Number.isFinite(value) ? String(value) : ''}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || !Number.isFinite(value) || value < min ? true : undefined}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value.trim() === '' ? NaN : Number(e.target.value))}
    />
  );
}

export interface CurveSelectProps {
  value: string | undefined;
  names: readonly string[];
  onChange: (curve: string | undefined) => void;
  label: string;
  disabled?: boolean;
  /** Label of the "no curve" option (omitted when null). */
  none?: string | null;
}

/** Curve picker; unknown names stay selectable so that they show up as validation errors. */
export function CurveSelect({ value, names, onChange, label, disabled, none = 'constant' }: CurveSelectProps) {
  const options = value && !names.includes(value) ? [...names, value] : names;
  return (
    <select aria-label={label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
      {none !== null && <option value="">{none}</option>}
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
          {names.includes(n) ? '' : ' (unknown)'}
        </option>
      ))}
    </select>
  );
}

export const fmtVph = (v: number): string => (v >= 100 ? Math.round(v).toLocaleString('en') : (Math.round(v * 10) / 10).toLocaleString('en'));
