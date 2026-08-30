import { SelectField, Field } from '../../components/Field';
import { useCustomerDirectory } from './useCustomerDirectory';

interface CustomerFieldProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}

export function CustomerField({ value, onChange, error }: CustomerFieldProps) {
  const directory = useCustomerDirectory();

  if (directory.mode === 'list' && directory.state.status === 'success') {
    return (
      <SelectField
        label="Customer"
        value={value}
        options={directory.state.data}
        getValue={(c) => c.id}
        getLabel={(c) => `${c.name} · ${c.email}`}
        placeholder="Choose a customer"
        error={error}
        onChange={onChange}
      />
    );
  }

  // Paste fallback: also what you get while the list is loading, or if it fails.
  return (
    <Field label="Customer ID" hint="From `pnpm db:seed` output." error={error}>
      {({ id, className }) => (
        <input
          id={id}
          className={`${className} field__control--mono`}
          value={value}
          placeholder="00000000-0000-0000-0000-000000000000"
          onChange={(event) => onChange(event.target.value.trim())}
        />
      )}
    </Field>
  );
}
