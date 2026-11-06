import type { Db, Sealer } from "@ilven/common";

export interface Ctx {
  db: Db;
  sealer: Sealer;
  masterKey: string;
  projectName: string;
  dockerHost?: string;
}

/** Who performs an operation. Admin operations require isAdmin. */
export interface Actor {
  sub: string;
  isAdmin: boolean;
  via: "rest" | "mcp";
}

export const GENDERS = ["female", "male", "non_binary", "other"] as const;
export type Gender = (typeof GENDERS)[number];

export const CONVERSATION_SCOPES = ["actions", "app", "open"] as const;
export type ConversationScope = (typeof CONVERSATION_SCOPES)[number];
