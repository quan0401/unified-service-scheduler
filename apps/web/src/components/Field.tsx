import { useId, type ReactNode } from 'react';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  /** Receives the id to wire label and control together. */
  children: (props: { id: string; className: string }) => ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const className = 'field__control';

  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, className })}
      {error ? <p className="field__error">{error}</p> : null}
      {!error && hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

interface SelectFieldProps<T> {
  label: string;
  hint?: string;
  error?: string | null;
  value: string;
  options: readonly T[];
  getValue: (option: T) => string;
  getLabel: (option: T) => string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function SelectField<T>({
  label,
  hint,
  error,
  value,
  options,
  getValue,
  getLabel,
  placeholder,
  disabled,
  onChange,
}: SelectFieldProps<T>) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, className }) => (
        <select
          id={id}
          className={className}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={getValue(option)} value={getValue(option)}>
              {getLabel(option)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
