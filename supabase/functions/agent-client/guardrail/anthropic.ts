/**
 * Cliente mínimo contra la Messages API NATIVA de Anthropic, con salida
 * estructurada (JSON forzado por schema) y, opcionalmente, tool use.
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
 * Se usa `fetch` pelado a propósito: no justifica agregar @anthropic-ai/sdk
 * al import map de deno.json.
 *
 * ── `messages` real, no un `userMessage` suelto (2026-08-06) ──
 *
 * Hasta la v10 esto mandaba `messages: [{role: "user", content: userMessage}]`
 * — un solo turno, sin historial. Se migró a un array real de `GuardrailTurn`
 * por dos razones (ver `proyectos/P05_plan_tools_turnos.md`, sección 2.6, en
 * el repo `consultorio_dermatologico`):
 *   1. Las tools de turnos (`guardrail/turnos.ts`) necesitan un ida-y-vuelta
 *      real de `tool_use`/`tool_result` — eso ya obliga a que `messages` sea
 *      un array de verdad, no un string.
 *   2. Meter el historial de la conversación como texto embebido en el
 *      `system` (el atajo que se usó antes) es exactamente lo que impide
 *      cachear ese prefijo — cada paciente terminaba con un `system`
 *      distinto. Con el historial viajando como turnos reales, el `system`
 *      queda estable entre pacientes y se puede activar prompt caching
 *      (`cache_control`), con un ahorro estimado de costo mucho mayor que lo
 *      que cuesta el historial en sí (~3% del input total).
 *
 * ── Combinar `tools` + `output_config.format` (verificado contra la doc
 * oficial) ──
 *
 * Sí son combinables en el mismo request
 * (`/docs/en/build-with-claude/structured-outputs`: "When combined, Claude
 * can call tools with guaranteed-valid parameters AND return structured JSON
 * responses"). PERO el schema solo se garantiza en el turno donde el modelo
 * YA NO pide una tool — puede responder con `tool_use` en vez de texto, y el
 * caller tiene que manejar las dos formas. Por eso `callStructured` con
 * `tools` devuelve una unión discriminada (`StructuredCallResult`) en vez de
 * asumir siempre texto. `disable_parallel_tool_use: true` (default cuando hay
 * `tools`) garantiza como máximo una tool por turno.
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

/**
 * Bloques de contenido para el ida-y-vuelta de una tool — un turno normal de
 * texto usa `content: string` directo (más simple), pero el turno donde el
 * modelo pidió una tool, y el turno donde le devolvemos el resultado, tienen
 * que ser bloques tipados (requisito de la Messages API, no algo que se
 * pueda simplificar a texto plano).
 */
export type GuardrailContentBlock =
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Un turno de la conversación real (historial o ida-y-vuelta de tool). */
export interface GuardrailTurn {
  role: "user" | "assistant";
  content: string | GuardrailContentBlock[];
}

/**
 * Agrega el turno final (el mensaje actual) al historial, colapsando con el
 * último turno si ambos son del mismo rol — la Messages API exige roles
 * alternados, y el historial puede terminar en "user" si la paciente mandó
 * varios mensajes sin que el bot contestara entre medio.
 *
 * Vive acá (no en `guardrail/index.ts`, donde se escribió originalmente)
 * para que `guardrail/turnos.ts` también pueda importarla sin crear un
 * import circular (`index.ts` ya importa `ejecutarPasoTurnos` de
 * `turnos.ts`). Reusada también en `guardrail-golden-set/index.ts`.
 *
 * Descarta turnos `assistant` iniciales por las dudas — `getRecentHistoryTurns`
 * (`agent-client/index.ts`) ya lo garantiza para el camino real, pero esta
 * función no debería asumir que TODO caller respeta esa invariante
 * (encontrado 2026-08-06: un fixture a mano del golden set la violó y el
 * request a Anthropic falló, porque el primer turno de `messages` tiene que
 * ser `role: "user"`).
 */
export function agregarTurnoFinal(
  historialCrudo: GuardrailTurn[],
  turnoFinal: GuardrailTurn,
): GuardrailTurn[] {
  const historial = [...historialCrudo];

  while (historial.length && historial[0].role !== "user") {
    historial.shift();
  }

  const ultimo = historial[historial.length - 1];

  if (
    ultimo && ultimo.role === turnoFinal.role &&
    typeof ultimo.content === "string" && typeof turnoFinal.content === "string"
  ) {
    return [
      ...historial.slice(0, -1),
      {
        role: ultimo.role,
        content: `${ultimo.content}\n${turnoFinal.content}`,
      },
    ];
  }

  return [...historial, turnoFinal];
}

/**
 * Un bloque del `system`. `cache: true` marca el breakpoint de prompt
 * caching al final de ese bloque — usarlo en el ÚLTIMO bloque del contenido
 * ESTÁTICO (idéntico entre pacientes/mensajes), nunca en un bloque que
 * cambie por request (eso invalida la caché en cada llamado, sin beneficio).
 */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/** Tool en formato Anthropic (mismo shape que `input_schema` + `strict`). */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
  strict?: boolean;
}

export interface StructuredCallOptions {
  apiKey: string;
  model?: string;
  /** string = un solo bloque sin caché. Array = bloques con breakpoint opcional. */
  system: string | SystemBlock[];
  /** El primer turno tiene que ser `role: "user"`. */
  messages: GuardrailTurn[];
  schema: JSONSchema;
  maxTokens?: number;
  /** 0 por defecto: queremos el guardrail lo más determinístico posible. */
  temperature?: number;
  /** Headers de trazabilidad (organization-id, conversation-id, etc.). */
  headers?: Record<string, string>;
  tools?: AnthropicTool[];
  /** Default cuando hay `tools`: `{type: "auto", disable_parallel_tool_use: true}`. */
  toolChoice?: Record<string, unknown>;
  /** Deadline opcional del request (ej. el deadline global de un paso con tools). */
  signal?: AbortSignal;
  /**
   * Observabilidad de costo (v16). Se invoca una vez por llamado real a
   * Anthropic que haya devuelto HTTP 200, con el usage crudo y la latencia
   * medida acá adentro (es el único lugar que ve las dos puntas del fetch).
   *
   * Es sincrónico y a propósito NO se espera: el caller lo usa para disparar
   * un insert fire-and-forget (ver `guardrail/costos.ts`). Cualquier
   * excepción que tire se traga — un problema de logueo nunca puede tumbar
   * una respuesta a una paciente.
   */
  onLlamado?: (info: InfoLlamado) => void;
}

/** Lo que se sabe de un llamado real a Claude, para `agent_llm_calls`. */
export interface InfoLlamado {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens servidos desde la caché de prompt (`cache_read_input_tokens`). */
  cachedTokens: number;
  /** Tokens ESCRITOS a la caché (`cache_creation_input_tokens`) — cuestan
   * 1.25x el input normal, por eso se cobran aparte en `estimarCosto`. */
  cacheCreationTokens: number;
  latencyMs: number;
}

export type StructuredCallResult<T> =
  | { kind: "texto"; data: T }
  | { kind: "tool_use"; id: string; name: string; input: unknown };

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string | null };
  usage?: Record<string, number>;
}

function systemToApiBlocks(
  system: string | SystemBlock[],
): { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] {
  const blocks = typeof system === "string" ? [{ text: system }] : system;

  return blocks.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function logUsage(usage: Record<string, number> | undefined): void {
  if (!usage) return;

  log.info("Guardrail — usage de Anthropic", {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  });
}

/**
 * Hace UN llamado a Claude. Sin `tools`, devuelve directamente el JSON ya
 * parseado y validado contra el schema (comportamiento idéntico al de antes
 * de 2026-08-06 — los callers existentes, redactor y juez, no cambian su
 * forma de leer el resultado). Con `tools`, devuelve una unión discriminada
 * porque el modelo puede responder con `tool_use` en vez de texto.
 *
 * Tira GuardrailLLMError ante cualquier cosa rara (HTTP != 2xx, refusal,
 * truncado por max_tokens, JSON no parseable). El caller trata el error como
 * "no mandar nada" — fail-closed, nunca fail-open.
 */
export async function callStructured<T>(
  options: StructuredCallOptions & { tools?: undefined },
): Promise<T>;
export async function callStructured<T>(
  options: StructuredCallOptions & { tools: AnthropicTool[] },
): Promise<StructuredCallResult<T>>;
export async function callStructured<T>(
  options: StructuredCallOptions,
): Promise<T | StructuredCallResult<T>> {
  const {
    apiKey,
    model = DEFAULT_GUARDRAIL_MODEL,
    system,
    messages,
    schema,
    maxTokens = 1024,
    temperature = 0,
    headers = {},
    tools,
    toolChoice,
    signal,
    onLlamado,
  } = options;

  if (messages.length === 0 || messages[0].role !== "user") {
    throw new GuardrailLLMError(
      'El primer turno de `messages` tiene que ser role:"user" (requisito de la Messages API).',
    );
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemToApiBlocks(system),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    // El parámetro que toda esta gimnasia justifica: JSON garantizado.
    output_config: {
      format: {
        type: "json_schema",
        schema,
      },
    },
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? {
      type: "auto",
      disable_parallel_tool_use: true,
    };
  }

  const arranque = Date.now();

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text();

    throw new GuardrailLLMError(
      `Anthropic devolvió ${response.status}: ${errBody.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as AnthropicMessageResponse;
  const latencyMs = Date.now() - arranque;

  logUsage(data.usage);

  // Observabilidad de costo — best effort, nunca puede romper la respuesta.
  // Se emite ANTES de los chequeos de refusal/max_tokens a propósito: un
  // llamado que terminó en refusal igual se pagó y tiene que aparecer en la
  // tabla de costos.
  if (onLlamado) {
    try {
      onLlamado({
        model,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cachedTokens: data.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? 0,
        latencyMs,
      });
    } catch (error) {
      log.error("Guardrail — falló el hook de costo (se ignora)", error);
    }
  }

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

  const toolUseBlock = data.content?.find((block) => block.type === "tool_use");

  if (toolUseBlock) {
    if (!tools) {
      // No debería pasar nunca (no mandamos tools), pero si pasa es una señal
      // fuerte de que algo cambió del lado de la API — fail-closed, no
      // intentar interpretarlo como texto.
      throw new GuardrailLLMError(
        `Claude devolvió tool_use ('${toolUseBlock.name}') sin que se hayan mandado tools`,
      );
    }

    return {
      kind: "tool_use",
      id: toolUseBlock.id ?? "",
      name: toolUseBlock.name ?? "",
      input: toolUseBlock.input,
    };
  }

  const text = data.content?.find((block) => block.type === "text")?.text;

  if (!text) {
    throw new GuardrailLLMError(
      `Respuesta sin bloque de texto (stop_reason: ${data.stop_reason})`,
    );
  }

  let parsed: T;

  try {
    parsed = JSON.parse(text) as T;
  } catch {
    // Con output_config.format esto no debería pasar nunca; si pasa, es una
    // señal fuerte de que algo cambió del lado de la API.
    log.error("JSON inválido pese a output_config.format", text.slice(0, 500));

    throw new GuardrailLLMError("La respuesta no es JSON parseable");
  }

  return tools ? { kind: "texto", data: parsed } : parsed;
}
