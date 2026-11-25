import { expect, it } from 'vitest';
import { databasePoolConfig, withDatabasePool } from '../../src/database';

// Validate the destination before constructing any pool or opening a connection.
// Missing or unsafe configuration fails collection; there is no fallback.
databasePoolConfig('integration');

it('connects only to taskflow_test with UTF8 and read-only sessions', async () => {
  try {
    await withDatabasePool('integration', async (pool) => {
      const result = await pool.query<{
        database: string;
        encoding: string;
        read_only: string;
      }>(`SELECT current_database() AS database,
          current_setting('server_encoding') AS encoding,
          current_setting('transaction_read_only') AS read_only`);
      expect(result.rows[0]).toEqual({
        database: 'taskflow_test',
        encoding: 'UTF8',
        read_only: 'on',
      });
    });
  } catch {
    // Driver errors can contain connection details. Report a fixed diagnostic.
    throw new Error('Integration database check failed; verify taskflow_test configuration and availability locally');
  }
});
