CREATE TABLE "user" (
  "id" UUID NOT NULL PRIMARY KEY,
  "email" VARCHAR(320) NOT NULL UNIQUE,
  "display_name" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "issue" (
  "id" UUID NOT NULL PRIMARY KEY,
  "user_id" UUID NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL,
  "status" VARCHAR(255) NOT NULL CHECK ("status" IN ('Backlog', 'InProgress', 'Resolved')),
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "comment" (
  "id" UUID NOT NULL PRIMARY KEY,
  "issue_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL
);

ALTER TABLE "issue" ADD FOREIGN KEY ("user_id") REFERENCES "user"("id");

ALTER TABLE "comment" ADD FOREIGN KEY ("issue_id") REFERENCES "issue"("id");

ALTER TABLE "comment" ADD FOREIGN KEY ("user_id") REFERENCES "user"("id");
