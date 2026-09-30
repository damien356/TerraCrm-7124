import { createGateway } from "ai";

/** Runable's own AI Gateway. Structured extraction goes through this — it does
 * not proxy Whisper transcription, which is why transcription uses OpenAI
 * directly instead (see `transcribe.ts`). */
export const gateway = createGateway({
  baseURL: process.env.AI_GATEWAY_BASE_URL,
  apiKey: process.env.AI_GATEWAY_API_KEY,
});
