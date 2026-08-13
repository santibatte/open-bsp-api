/**
 * Transcripción de audio con Gemini para el guardrail (2026-08-09).
 *
 * A diferencia de `media-preprocessor` (dispara solo, async, vía trigger de
 * Postgres — el guardrail no puede esperarlo porque ya se dispara en
 * paralelo apenas se inserta el mensaje, sin orden garantizado), esto corre
 * SINCRÓNICO dentro de `agent-client`, ANTES de entrar al pipeline
 * redactor/juez: si Gemini transcribe bien, el texto pasa a ser
 * `mensajePaciente` y sigue el camino normal, como si la paciente lo hubiera
 * tipeado. Si falla por cualquier motivo, el llamador trata el mensaje como
 * silencio (fail-closed, no como la redirección fija a mail que sigue
 * aplicando a foto/video/documento).
 *
 * Deliberadamente no reusa `media-preprocessor/index.ts` completo — esa
 * función también factura contra `billing.costs`/`billing.ledger`
 * (multi-tenant SaaS, no aplica acá) y persiste description/table/otros
 * tipos de media; acá solo hace falta transcribir audio y devolver texto.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ApiError,
  type GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import { downloadFromStorage } from "../../_shared/media.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import * as log from "../../_shared/logger.ts";
import type { FilePart } from "../../_shared/types/message_types.ts";

const AUDIO_MIME_TYPES = [
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
];

// Mismo límite que `media-preprocessor` (Gemini File API no implementada
// todavía — ver el comentario ahí).
const INLINE_DATA_SIZE_LIMIT = 19 * 1000 * 1000;

export type ResultadoTranscripcion =
  | { ok: true; texto: string }
  | { ok: false; motivo: string };

interface ConfigMediaPreprocessing {
  mode?: string;
  model?: string;
  language?: string;
  api_key?: string;
}

export async function transcribirAudio(
  client: SupabaseClient,
  org: { id: string; extra: Record<string, unknown> | null },
  content: FilePart,
): Promise<ResultadoTranscripcion> {
  const config = (org.extra?.media_preprocessing ??
    {}) as ConfigMediaPreprocessing;

  if (config.mode !== "active") {
    return { ok: false, motivo: "media_preprocessing no está activo" };
  }

  const apiKey = config.api_key || Deno.env.get("GOOGLE_API_KEY");

  if (!apiKey) {
    return { ok: false, motivo: "sin API key de Gemini configurada" };
  }

  const mimeType = content.file.mime_type;
  const baseMime = mimeType.split(";")[0]; // "audio/ogg; codecs=opus" -> "audio/ogg"

  if (!AUDIO_MIME_TYPES.includes(baseMime)) {
    return {
      ok: false,
      motivo: `mime type de audio no soportado: ${mimeType}`,
    };
  }

  if (content.file.size * 1.33 > INLINE_DATA_SIZE_LIMIT) {
    return { ok: false, motivo: "audio supera el límite de 19MB" };
  }

  const model = config.model || "gemini-2.5-flash";
  const language = config.language || "Spanish";

  let fileBlob: Blob;

  try {
    fileBlob = await downloadFromStorage(client, content.file.uri);
  } catch (error) {
    log.error(
      "Transcripción de audio — falló la descarga del storage",
      error,
    );
    return { ok: false, motivo: "error al descargar el audio del storage" };
  }

  const base64File = encodeBase64(await fileBlob.arrayBuffer());

  const prompt =
    `Analyze this audio file. Provide a transcription of the audio content in its original language and a brief description in ${language} of what it contains (voice, music, noises, etc.). If it's voice, include emotion recognition in the description.`;

  const responseSchema = {
    type: "object",
    properties: {
      transcription: { type: "string" },
      description: { type: "string" },
    },
  };

  const genai = new GoogleGenAI({ apiKey });

  let response: GenerateContentResponse;

  try {
    response = await genai.models.generateContent({
      model,
      contents: [
        { text: prompt },
        { inlineData: { mimeType, data: base64File } },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema,
      },
    });
  } catch (error) {
    const status = (error as ApiError).status;
    const message = String(error);
    const isQuotaExhausted = status === 429 &&
      (message.includes("quota") || message.includes("RESOURCE_EXHAUSTED"));

    log.error(
      `Transcripción de audio — error de Gemini (status ${status}${
        isQuotaExhausted ? ", cuota agotada" : ""
      })`,
      error,
    );

    return { ok: false, motivo: `error de Gemini: ${message}` };
  }

  if (!response?.text) {
    return { ok: false, motivo: "Gemini no devolvió texto" };
  }

  let parsed: { transcription?: string; description?: string };

  try {
    parsed = JSON.parse(response.text);
  } catch (_error) {
    return { ok: false, motivo: "no se pudo parsear la respuesta de Gemini" };
  }

  const texto = parsed.transcription?.trim();

  if (!texto) {
    return {
      ok: false,
      motivo: "Gemini no detectó contenido transcribible (sin voz reconocible)",
    };
  }

  return { ok: true, texto };
}
