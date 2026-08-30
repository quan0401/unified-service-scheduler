import { api } from '../../api/endpoints';
import { useResource } from '../../hooks/useResource';
import type { AsyncState } from '../../hooks/useAsync';
import type { CustomerView } from '../../api/types';

/**
 * The customer picker's data source, isolated so it can change in one place.
 *
 * `GET /customers` was added to the catalog module for exactly this: seed ids
 * are gen_random_uuid(), so without an endpoint the only way to discover one is
 * the seed script's stdout. If that endpoint were ever removed, this returns
 * `{ mode: 'paste' }` and CustomerField falls back to a uuid input -- nothing
 * else in the app moves.
 */
export type CustomerDirectory =
  { mode: 'paste' } | { mode: 'list'; state: AsyncState<CustomerView[]> };

export function useCustomerDirectory(): CustomerDirectory {
  const state = useResource('customers', (signal) => api.customers(signal).then((r) => r.data));

  return { mode: 'list', state };
}
