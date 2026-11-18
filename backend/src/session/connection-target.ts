/**
 * Everything the transport needs to talk to Mashov as one household
 * connection, in one object.
 *
 * Deliberately dependency-free. `MashovHttpClient` takes it as a parameter and
 * `ConnectionScopeService` produces it, which is what keeps the transport from
 * importing a Prisma-dependent module: resolving ownership is a schema concern,
 * and the client that performs the request should stay unaware of the schema.
 * The positional `getForConnection(url, id, semel, year, username, password)`
 * is the same six fields spelled out one argument at a time.
 *
 * `password` is the decrypted password. It is resolved per request and never
 * stored — `HouseholdConnection.encryptedPassword` remains the only persisted
 * form.
 */
export interface ConnectionTarget {
  id: string;
  schoolCode: number;
  schoolYear: number;
  username: string;
  password: string;
  schoolName: string | null;
}
