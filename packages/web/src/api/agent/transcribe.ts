import { experimental_transcribe as transcribe } from "ai";
import { openai } from "@ai-sdk/openai";

/**
 * Whisper transcription, direct to OpenAI. The Runable AI Gateway does not
 * proxy transcription models (confirmed 404 on `transcriptionModel`), so this
 * one call uses `OPENAI_API_KEY` directly instead of `gateway`. Everything
 * else in the voice quote pipeline (structured extraction) stays on the
 * gateway — see `extract.ts`.
 */
export async function transcribeAudio(audio: Uint8Array): Promise<string> {
  const result = await transcribe({
    model: openai.transcription("whisper-1"),
    audio,
  });
  return result.text;
}
