import type { Migration } from "@ilven/common";

export const migrations: Migration[] = [
  {
    id: "001_init",
    sql: `
CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT ''
);
INSERT INTO plans (id, name, description) VALUES ('free', 'Free', 'Issues your Ilven API key so the assistant can act for you.');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub text NOT NULL UNIQUE,
  is_admin boolean NOT NULL DEFAULT false,
  plan_id text REFERENCES plans(id),
  -- Opt-in profile attributes. NULL = not shared. Birth year only, never a full birth date.
  birth_year integer CHECK (birth_year BETWEEN 1900 AND 2100),
  gender text CHECK (gender IN ('female', 'male', 'non_binary', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,      -- keyed hash, used for verification
  sealed_key text NOT NULL,           -- AES-GCM sealed copy, only released to Ilven-AI for the user's connexes
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX api_keys_one_active ON api_keys(user_id) WHERE revoked_at IS NULL;

CREATE TABLE apps (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('platform', 'integration')),
  mcp_url text NOT NULL,
  base_url text,
  secret_hash text,
  tools jsonb NOT NULL DEFAULT '[]',
  tools_refreshed_at timestamptz,
  tools_error text,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  tools text[] NOT NULL DEFAULT '{}',
  rules text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);
CREATE UNIQUE INDEX presets_one_default ON presets(app_id) WHERE is_default;

CREATE TABLE preset_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  preset_id uuid NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  priority integer NOT NULL,
  min_age integer CHECK (min_age >= 0),
  max_age integer CHECK (max_age >= 0),
  gender text CHECK (gender IN ('female', 'male', 'non_binary', 'other')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  preset_id uuid REFERENCES presets(id) ON DELETE SET NULL,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, app_id)
);

CREATE TABLE ai_providers (
  id text PRIMARY KEY CHECK (id IN ('anthropic', 'openai', 'google')),
  sealed_key text NOT NULL,
  model text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "002_conversation_scope",
    sql: `
-- What Ilven-AI may talk about, per preset. 'actions' (default, safe): only what the allowed tools serve;
-- 'app': also questions about the app and the preset's topics; 'open': general assistant.
ALTER TABLE presets ADD COLUMN conversation text NOT NULL DEFAULT 'actions' CHECK (conversation IN ('actions', 'app', 'open'));
ALTER TABLE presets ADD COLUMN topics text NOT NULL DEFAULT '';
-- Small model used for the per-message scope check.
ALTER TABLE ai_providers ADD COLUMN guard_model text;
`,
  },
  {
    id: "003_delegated_keys",
    sql: `
-- Delegated keys: an app acts for a user while the user is away (e.g. Locke's automated workflows reading vault
-- sources). Issued only when the app presents its own secret AND the user's live login; one active key per
-- (user, app); valid only at the services in its audience; revocable by the user in Ilven-Account.
-- Never released again: only the keyed hash is stored here, the holder app keeps the key.
CREATE TABLE delegated_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  audience text[] NOT NULL,
  purpose text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX delegated_keys_one_active ON delegated_keys(user_id, app_id) WHERE revoked_at IS NULL;
`,
  },
];
