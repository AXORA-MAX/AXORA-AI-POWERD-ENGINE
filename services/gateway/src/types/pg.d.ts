/**
 * Minimal ambient types for the `pg` package, covering only the surface
 * `postgresStore.ts` actually uses. Written by hand because this sandbox
 * has no network access to install the real `@types/pg` package.
 *
 * DELETE THIS FILE once `npm install pg @types/pg` has actually been run
 * in an environment with network access — the real type definitions are
 * more complete and this file's only job is to unblock static checking
 * here. If real `@types/pg` are present, this file will conflict/be
 * redundant; keep only one.
 */
declare module "pg" {
  export interface QueryResultRow {
    [column: string]: any;
  }

  export interface QueryResult<R extends QueryResultRow = any> {
    rows: R[];
    rowCount: number | null;
  }

  export interface PoolConfig {
    connectionString?: string;
    max?: number;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<R extends QueryResultRow = any>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
