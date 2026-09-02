CREATE TABLE "task" (
  "id" UUID NOT NULL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL CHECK (char_length("title") >= 2) CHECK (char_length("title") <= 80),
  "description" TEXT NOT NULL CHECK (char_length("description") <= 400),
  "status" VARCHAR(255) NOT NULL CHECK ("status" IN ('Backlog', 'InProgress', 'Done')),
  "assignee" VARCHAR(255),
  "version" INTEGER NOT NULL CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);
