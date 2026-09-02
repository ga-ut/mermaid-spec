import { Database } from "bun:sqlite";

const migrations = [
  {
    version: 1,
    sql: `CREATE TABLE task (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Backlog', 'InProgress', 'Done')),
      assignee TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX task_status_updated_idx ON task (status, updatedAt DESC);`,
  },
];

function migrate(database) {
  database.run("CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)");
  const applied = new Set(database.query("SELECT version FROM schema_migration").all().map((row) => row.version));
  const apply = database.transaction((entry) => {
    database.run(entry.sql);
    database.query("INSERT INTO schema_migration (version, appliedAt) VALUES (?, ?)").run(entry.version, new Date().toISOString());
  });
  for (const entry of migrations) if (!applied.has(entry.version)) apply(entry);
}

export function openTaskStore(file) {
  const database = new Database(file, { create: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA journal_mode = WAL");
  migrate(database);

  const insert = database.query(`INSERT INTO task (id, title, description, status, assignee, version, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = database.query("SELECT * FROM task WHERE id = ?");
  const firstPage = database.query("SELECT * FROM task ORDER BY id LIMIT ?");
  const afterCursor = database.query("SELECT * FROM task WHERE id > ? ORDER BY id LIMIT ?");
  const update = database.query(`UPDATE task SET status = ?, updatedAt = ?, version = version + 1
    WHERE id = ? AND version = ?`);

  return {
    schemaVersion: () => database.query("SELECT MAX(version) AS version FROM schema_migration").get()?.version ?? 0,
    create(task) {
      insert.run(task.id, task.title, task.description, task.status, task.assignee ?? null, task.version, task.createdAt, task.updatedAt);
      return byId.get(task.id);
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    list({ cursor, limit }) {
      const rows = cursor ? afterCursor.all(cursor, limit + 1) : firstPage.all(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return { items, nextCursor: hasMore ? items.at(-1).id : null };
    },
    updateStatus(task, expectedVersion) {
      const result = update.run(task.status, task.updatedAt, task.id, expectedVersion);
      return result.changes === 1 ? byId.get(task.id) : null;
    },
    close() {
      database.close();
    },
  };
}
