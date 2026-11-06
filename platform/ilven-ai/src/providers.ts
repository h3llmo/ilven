import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export interface ProviderConfig { id: "anthropic" | "openai" | "google"; model: string; apiKey: string }

/** BYOK: the operator's key (from Nevli) is used per request and never stored, logged or sent to the model or browser. */
export function languageModel(p: ProviderConfig): LanguageModel {
  switch (p.id) {
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey })(p.model);
    case "openai":
      return createOpenAI({ apiKey: p.apiKey })(p.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: p.apiKey })(p.model);
  }
}
