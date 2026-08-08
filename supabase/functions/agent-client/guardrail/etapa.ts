/**
 * PASO 0 — Clasificador de etapa de conversación (v16).
 *
 * Llamado corto a Claude, con prompt propio y una sola tarea: decir en qué
 * etapa está la conversación (`explorando` / `quiere_agendar` / `agendando` /
 * `agendado`). Corre ANTES del redactor; el redactor recibe el resultado como
 * dato de contexto de solo lectura y nunca lo recalcula.
 *
 * Diseño: `proyectos/P05_plan_rediseno_guardrail.md` sección 4 (Opción B,
 * clasificador aparte estilo `StageAnalyzerChain` de SalesGPT). El set de
 * etapas es chico a propósito — se valida con conversaciones reales antes de
 * afinarlo más.
 *
 * ── FAIL-SOFT, no fail-closed ──
 *
 * A diferencia del resto del guardrail, un error acá NO corta la respuesta:
 * la etapa es un dato de tono, no de seguridad. Si el llamado falla, se
 * devuelve la etapa que ya estaba guardada (o `explorando`) y el pipeline
 * sigue normal. Silenciar a una paciente porque no se pudo calcular el tono
 * sería peor que contestarle con el tono de la etapa anterior.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../../_shared/logger.ts";
import type { ContactRow } from "../../_shared/supabase.ts";
import {
  agregarTurnoFinal,
  callStructured,
  GuardrailLLMError,
  type GuardrailTurn,
  type InfoLlamado,
} from "./anthropic.ts";
import {
  ETAPA_INICIAL,
  type EtapaConversacion,
  ETAPAS,
  type SalidaEtapa,
  SCHEMA_ETAPA,
  systemEtapa,
  userEtapa,
} from "./prompts.ts";

/** Lee la etapa guardada en `contacts.extra.etapa`. Ausente/rara = inicial. */
export function leerEtapa(contact?: ContactRow): EtapaConversacion {
  const extra = contact?.extra as Record<string, unknown> | null | undefined;
  const raw = extra?.etapa;

  return typeof raw === "string" && (ETAPAS as readonly string[]).includes(raw)
    ? raw as EtapaConversacion
    : ETAPA_INICIAL;
}

/**
 * Persiste la etapa en `contacts.extra`, reusando el mismo RPC de merge que
 * `email`/`nombre_completo` (`merge_contact_datos_contacto`) — no hace falta
 * una función SQL nueva: mergea el patch sin pisar las otras claves.
 * Best effort: si falla, se loguea y se sigue.
 */
export async function guardarEtapa(
  client: SupabaseClient,
  contact: ContactRow | undefined,
  etapa: EtapaConversacion,
): Promise<void> {
  if (!contact?.id) return;

  const { error } = await client.rpc("merge_contact_datos_contacto", {
    _contact_id: contact.id,
    _datos: { etapa },
  });

  if (error) {
    log.error("Guardrail — no se pudo guardar la etapa (se ignora)", error);
  }
}

export interface ClasificarEtapaParams {
  apiKey: string;
  model?: string;
  headers?: Record<string, string>;
  mensajePaciente: string;
  historial: GuardrailTurn[];
  /** La etapa que venía guardada — es el fallback si el llamado falla. */
  etapaGuardada: EtapaConversacion;
  onLlamado?: (info: InfoLlamado) => void;
}

/**
 * Devuelve la etapa nueva. Nunca tira: ante cualquier error devuelve
 * `etapaGuardada`.
 *
 * `maxTokens` fijo y chico (128): la salida es un solo enum, no hay razón
 * para pagar el default de 1024 en un llamado que corre en CADA mensaje.
 */
export async function clasificarEtapa(
  params: ClasificarEtapaParams,
): Promise<EtapaConversacion> {
  const {
    apiKey,
    model,
    headers,
    mensajePaciente,
    historial,
    etapaGuardada,
    onLlamado,
  } = params;

  try {
    const salida = await callStructured<SalidaEtapa>({
      apiKey,
      model,
      headers,
      maxTokens: 128,
      system: [systemEtapa()],
      messages: agregarTurnoFinal(historial, {
        role: "user",
        content: userEtapa(mensajePaciente, etapaGuardada),
      }),
      schema: SCHEMA_ETAPA,
      onLlamado,
    });

    // Defensa por las dudas: structured outputs garantiza el enum, pero si
    // algo cambia del lado de la API no queremos escribir basura en
    // `contacts.extra`.
    if ((ETAPAS as readonly string[]).includes(salida.etapa)) {
      return salida.etapa;
    }

    log.warn("Guardrail — etapa desconocida devuelta por el clasificador", {
      etapa: salida.etapa,
    });

    return etapaGuardada;
  } catch (error) {
    const detalle = error instanceof GuardrailLLMError
      ? error.message
      : String(error);

    log.warn(
      "Guardrail — falló el clasificador de etapa; se usa la guardada",
      { etapaGuardada, detalle },
    );

    return etapaGuardada;
  }
}
