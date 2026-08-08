/**
 * Observabilidad de costo del guardrail — un insert por cada llamado real a
 * Claude, en `public.agent_llm_calls` (ver `vampiresa_meli/agent_guardrails.sql`).
 *
 * Diseñado en `proyectos/P05_plan_rediseno_guardrail.md` sección 3 (Opción A:
 * tabla propia en Supabase, sin Langfuse por ahora). Sin dashboard todavía —
 * primero que el dato exista y se pueda consultar por SQL directo.
 *
 * ── BEST EFFORT, SIEMPRE ──
 *
 * Mismo patrón que `scripts/lib/meta_send_log.py` del repo
 * `consultorio_dermatologico`: fire-and-forget. `registrarLlamado()` NO se
 * espera con `await` en el camino caliente y NUNCA tira: si el insert falla
 * (tabla sin crear, base caída, red), se loguea y se sigue. Una paciente
 * nunca se queda sin respuesta porque no se pudo escribir una fila de
 * auditoría de costo.
 *
 * ── Por qué el costo se calcula acá y no en SQL ──
 *
 * Los precios por millón de token cambian por modelo y con el tiempo. Se
 * guarda el `cost_estimate` YA CALCULADO junto con los tokens crudos: si
 * mañana cambia el precio, las filas viejas siguen reflejando lo que
 * realmente se pagó, y los tokens crudos permiten recalcular si hace falta.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../../_shared/logger.ts";
import type { InfoLlamado } from "./anthropic.ts";

/**
 * Qué paso del pipeline hizo el llamado. Tiene que coincidir con el CHECK de
 * `agent_llm_calls.step` en `agent_guardrails.sql` — si se agrega uno acá,
 * hay que agregarlo allá o el insert falla en silencio (bueno: es best
 * effort, pero deja de haber dato).
 */
export type PasoLLM =
  | "etapa"
  | "redactor"
  | "juez"
  | "reescritura"
  | "turnos";

export const PASOS_LLM: readonly PasoLLM[] = [
  "etapa",
  "redactor",
  "juez",
  "reescritura",
  "turnos",
] as const;

/**
 * Precios de Anthropic en USD por millón de tokens, confirmados contra la
 * skill `claude-api` (2026-08-08). `cacheRead` es ~0.1x el input y
 * `cacheWrite` ~1.25x el input (TTL de 5 minutos, el default que usa
 * `cache_control: {type: "ephemeral"}` en `anthropic.ts`).
 *
 * Si el modelo del agente no está en esta tabla, `estimarCosto` devuelve null
 * (se guarda la fila igual, con los tokens crudos y sin costo estimado — es
 * preferible a inventar un número).
 */
const PRECIOS_USD_POR_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
};

const UN_MILLON = 1_000_000;

/** USD estimados de un llamado, o null si el modelo no está tarifado acá. */
export function estimarCosto(info: InfoLlamado): number | null {
  const precio = PRECIOS_USD_POR_MTOK[info.model];

  if (!precio) return null;

  const usd = (info.inputTokens * precio.input +
    info.outputTokens * precio.output +
    info.cachedTokens * precio.cacheRead +
    info.cacheCreationTokens * precio.cacheWrite) / UN_MILLON;

  // 8 decimales: un llamado de Haiku con caché caliente puede costar menos de
  // un millonésimo de dólar y redondear a 0 perdería la señal.
  return Number(usd.toFixed(8));
}

export interface RegistroLlamadoParams {
  client: SupabaseClient;
  organizationId: string;
  conversationId: string | null;
  step: PasoLLM;
  info: InfoLlamado;
}

/**
 * Inserta la fila de costo. **No se espera** desde el camino caliente: se
 * llama sin `await` y la promesa se resuelve siempre (nunca rechaza).
 */
export async function registrarLlamado(
  params: RegistroLlamadoParams,
): Promise<void> {
  const { client, organizationId, conversationId, step, info } = params;

  try {
    const { error } = await client
      .from("agent_llm_calls")
      .insert({
        organization_id: organizationId,
        conversation_id: conversationId,
        step,
        model: info.model,
        input_tokens: info.inputTokens,
        output_tokens: info.outputTokens,
        cached_tokens: info.cachedTokens,
        cache_creation_tokens: info.cacheCreationTokens,
        cost_estimate: estimarCosto(info),
        latency_ms: info.latencyMs,
      });

    if (error) {
      log.error("Guardrail — falló el log de costo (se ignora)", error);
    }
  } catch (error) {
    log.error("Guardrail — falló el log de costo (se ignora)", error);
  }
}

/**
 * Arma el callback `onLlamado` que espera `callStructured`, ya atado a la
 * conversación y al paso. Devuelve una función sincrónica que dispara el
 * insert sin esperarlo — el `void` es deliberado, no un olvido de `await`.
 */
export function hookCosto(
  params: Omit<RegistroLlamadoParams, "info">,
): (info: InfoLlamado) => void {
  return (info: InfoLlamado) => {
    void registrarLlamado({ ...params, info });
  };
}
