import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export interface ProviderConfig { id: "anthropic" | "openai" | "google"; model: string; guardModel: string; apiKey: string }

/** BYOK: the operator's key (from Nevli) is used per request and never stored, logged or sent to the model or browser. */
export function languageModel(p: ProviderConfig, modelId = p.model): LanguageModel {
  switch (p.id) {
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey: p.apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: p.apiKey })(modelId);
  }
}
