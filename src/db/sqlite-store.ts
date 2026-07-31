/**
 * Generic, parameterized SQLite connection + versioned-migration runner.
 *
 * Extracted from what was `DroverDb`'s own constructor/migrate/close logic
 * so it can be reused by a second SQLite-backed consumer (Grader's
 * `grader.sqlite`, see `src/grader/db.ts`) without copy-pasting the runner —
 * the third instance of "reuse shared low-level infra opportunistically
 * without becoming part of the tier stack," after the `ModelProvider` shape
 * and the budget-ceiling pattern (see FUTUREPLAN.md Grader Session 1).
 *
 * Each consumer supplies its own file path and its own migration set;
 * nothing here is aware of Drover's or Grader's specific schema.
 */

import Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class SqliteStore {
  protected readonly db: Database.Database;

  /** @param path SQLite file path, or ":memory:" for tests. */
  constructor(path: string, migrations: Migration[]) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate(migrations);
  }

  private migrate(migrations: Migration[]): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const applied = new Set(
      this.db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((r) => (r as { version: number }).version),
    );
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(m.version, m.name, Date.now());
      })();
    }
  }

  close(): void {
    this.db.close();
  }
}
