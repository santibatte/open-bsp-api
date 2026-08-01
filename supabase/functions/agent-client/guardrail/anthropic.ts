/**
 * Cliente mínimo contra la Messages API NATIVA de Anthropic, con salida
 * estructurada (JSON forzado por schema).
 *
 * ── Por qué esto y no el ChatCompletionsHandler que ya existe ──
 *
 * `protocols/chat-completions.ts` habla con Claude a través del SDK de OpenAI
 * apuntado a la capa de compatibilidad de Anthropic
 * (https://api.anthropic.com/v1 + openai.chat.completions.create).
 *
 * Esa capa IGNORA EN SILENCIO los dos mecanismos que garantizan conformidad de
 * schema (confirmado en la doc oficial, platform.claude.com/docs/en/api/openai-sdk):
 *
 *   - `response_format` (json_schema) → "Ignored. For JSON output, use
 *     Structured Outputs with the native Claude API"
 *   - `strict` en tools           → "Ignored [...] the tool use JSON is not
 *     guaranteed to follow the supplied schema"
 *
 * Para un guardrail médico, "el schema se ignora en silencio" no alcanza: el
 * juez tiene que devolver un booleano confiable, no un texto que casi siempre
 * parsea. Por eso este módulo pega directo a POST /v1/messages, donde
 * `output_config.format` SÍ está soportado y el JSON viene garantizado.
 *
 * Se usa `fetch` pelado a propósito: son dos llamados sin streaming ni tools,
 * no justifica agregar @anthropic-ai/sdk al import map de deno.json.
 */

import * as log from "../../_shared/logger.ts";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Modelo por defecto. Confirmado contra la skill `claude-api`: el id exacto
 * es `claude-haiku-4-5` (sin sufijo de fecha), y Haiku 4.5 soporta structured
 * outputs. Coincide con lo que ya declara setup.sql para el agente. */
export const DEFAULT_GUARDRAIL_MODEL = "claude-haiku-4-5";

/** JSON Schema, restringido a lo que acepta structured outputs. */
// deno-lint-ignore no-explicit-any
export type JSONSchema = Record<string, any>;

export class GuardrailLLMError extends Error {}

export interface StructuredCallOptions {
  apiKey: string;
  model?: string;
  system: string;
  userMessage: string;
  schema: JSONSchema;
  maxTokens?: number;
  /** 0 por defecto: queremos el guardrail lo más determinístico posible. */
  temperature?: number;
  /** Headers de trazabilidad (organization-id, conversation-id, etc.). */
  headers?: Record<string, string>;
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content?: AnthropicTextBlock[];
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string | null };
  usage?: Record<string, number>;
}

/**
 * Hace UN llamado a Claude y devuelve el JSON ya parseado y validado contra el
 * schema por la API.
 *
 * Tira GuardrailLLMError ante cualquier cosa rara (HTTP != 2xx, refusal,
 * truncado por max_tokens, JSON no parseable). El caller trata el error como
 * "no mandar nada" — fail-closed, nunca fail-open.
 */
export async function callStructured<T>(
  options: StructuredCallOptions,
): Promise<T> {
  const {
    apiKey,
    model = DEFAULT_GUARDRAIL_MODEL,
    system,
    userMessage,
    schema,
    maxTokens = 1024,
    temperature = 0,
    headers = {},
  } = options;

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...headers,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: userMessage }],
      // El parámetro que toda esta gimnasia justifica: JSON garantizado.
      output_config: {
        format: {
          type: "json_schema",
          schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new GuardrailLLMError(
      `Anthropic devolvió ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as AnthropicMessageResponse;

  // Un refusal del clasificador de seguridad llega como HTTP 200. Hay que
  // chequearlo ANTES de leer content, que puede venir vacío.
  if (data.stop_reason === "refusal") {
    throw new GuardrailLLMError(
      `Claude rechazó la request (categoría: ${
        data.stop_details?.category ?? "desconocida"
      })`,
    );
  }

  if (data.stop_reason === "max_tokens") {
    throw new GuardrailLLMError(
      "Respuesta truncada por max_tokens: el JSON quedaría incompleto",
    );
  }

  const text = data.content?.find((block) => block.type === "text")?.text;

  if (!text) {
    throw new GuardrailLLMError(
      `Respuesta sin bloque de texto (stop_reason: ${data.stop_reason})`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // Con output_config.format esto no debería pasar nunca; si pasa, es una
    // señal fuerte de que algo cambió del lado de la API.
    log.error("JSON inválido pese a output_config.format", text.slice(0, 500));

    throw new GuardrailLLMError("La respuesta no es JSON parseable");
  }
}
