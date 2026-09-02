CREATE TABLE "user" (
  "id" UUID NOT NULL PRIMARY KEY,
  "email" VARCHAR(320) NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "oauth_account" (
  "id" UUID NOT NULL PRIMARY KEY,
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(255) NOT NULL,
  "access_token" VARCHAR(255) NOT NULL,
  "refresh_token" VARCHAR(255) NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "oauth_callback" (
  "code" VARCHAR(255) NOT NULL,
  "state" VARCHAR(255) NOT NULL
);

ALTER TABLE "oauth_account" ADD FOREIGN KEY ("user_id") REFERENCES "user"("id");
