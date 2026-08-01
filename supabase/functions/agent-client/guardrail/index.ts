/**
 * Guardrail redactor + juez — Consultorio de la Vampiresa Meli.
 *
 * Reemplaza el bucle ReAct genérico por un pipeline determinístico de DOS
 * llamados a Claude por cada mensaje entrante:
 *
 *   1. REDACTOR  clasifica y redacta   → { tipo, mensaje }
 *   2. JUEZ      aprueba o rechaza     → { aprobado, motivo }
 *
 * Ambos con JSON forzado por schema (output_config.format, Messages API nativa
 * — ver el comentario largo en anthropic.ts sobre por qué no se reusa
 * ChatCompletionsHandler).
 *
 * Principio de diseño: FAIL-CLOSED. Cualquier cosa que salga mal — API caída,
 * JSON raro, catálogo sin cargar, contacto inexistente — termina en "no mandar
 * nada". Nunca en "mandar algo sin verificar".
 *
 * El envío real NO llama a whatsapp-dispatcher directo: inserta una fila
 * `direction: 'outgoing'` en public.messages y el trigger
 * handle_outgoing_message_to_dispatcher dispara el dispatcher, igual que hace
 * processRespondCall() en el protocolo de chat completions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../../_shared/logger.ts";
import type {
  ContactRow,
  ConversationRow,
  MessageInsert,
} from "../../_shared/supabase.ts";
import type { AgentRowWithExtra } from "../protocols/base.ts";
import { callStructured, GuardrailLLMError } from "./anthropic.ts";
import { cargarCatalogo, guardrailListo } from "./catalogo.ts";
import {
  type SalidaJuez,
  type SalidaRedactor,
  SCHEMA_JUEZ,
  SCHEMA_REDACTOR,
  systemJuez,
  systemRedactor,
  type TipoRespuesta,
  userJuez,
  userRedactor,
} from "./prompts.ts";

export interface GuardrailParams {
  client: SupabaseClient;
  conversation: ConversationRow;
  contact?: ContactRow;
  agent: AgentRowWithExtra;
  /** Texto del mensaje entrante de la paciente. */
  mensajePaciente: string;
  /** Headers de trazabilidad (organization-id, conversation-id, ...). */
  headers?: Record<string, string>;
}

export interface GuardrailResult {
  enviado: boolean;
  tipo?: TipoRespuesta;
  motivo: string;
}

/**
 * Lee el contador de fuera-de-tema del contacto. Ausente = 0.
 */
function leerOfftopicCount(contact?: ContactRow): number {
  const raw = (contact?.extra as Record<string, unknown> | null | undefined)
    ?.offtopic_count;

  const parsed = typeof raw === "number" ? raw : Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Incremento ATÓMICO del contador vía RPC (ver
 * supabase/vampiresa_meli/agent_guardrails.sql).
 *
 * Se hace en una sola sentencia SQL a propósito: si llegan dos mensajes muy
 * seguidos del mismo contacto, dos invocaciones concurrentes de agent-client
 * haciendo read-modify-write por separado dejarían el contador en 1 en vez de
 * 2, y la paciente se ganaría un "pase gratis" extra.
 */
async function incrementarOfftopic(
  client: SupabaseClient,
  contact: ContactRow | undefined,
): Promise<void> {
  if (!contact?.id) {
    log.warn(
      "No se pudo incrementar offtopic_count: la conversación no tiene contacto asociado",
    );

    return;
  }

  const { error } = await client.rpc("bump_offtopic_count", {
    _contact_id: contact.id,
  });

  if (error) {
    // No es fatal: ya decidimos no responder. Pero sí hay que verlo en los logs,
    // porque significa que la próxima repregunta va a recibir saludo de nuevo.
    log.error("Falló bump_offtopic_count", error);
  }
}

/**
 * Registra en `public.agent_respuestas_no_enviadas` todo lo que NO se envió.
 * Es para revisión humana en bloque; no dispara ninguna acción automática.
 */
async function registrarNoEnviada(
  client: SupabaseClient,
  conversation: ConversationRow,
  contact: ContactRow | undefined,
  datos: {
    mensajePaciente: string;
    tipo: TipoRespuesta;
    mensajeBorrador: string;
    motivo: string;
    offtopicCount: number;
  },
): Promise<void> {
  const { error } = await client
    .from("agent_respuestas_no_enviadas")
    .insert({
      organization_id: conversation.organization_id,
      contact_id: contact?.id ?? null,
      contact_address: conversation.contact_address,
      conversation_id: conversation.id,
      mensaje_paciente: datos.mensajePaciente,
      tipo_declarado: datos.tipo,
      mensaje_borrador: datos.mensajeBorrador,
      motivo: datos.motivo,
      offtopic_count: datos.offtopicCount,
    });

  if (error) {
    log.error("Falló el log de respuesta no enviada", error);
  }
}

/**
 * Envía el mensaje: inserta la fila outgoing y deja que el trigger de la base
 * despierte al dispatcher.
 */
async function enviarMensaje(
  client: SupabaseClient,
  conversation: ConversationRow,
  agent: AgentRowWithExtra,
  texto: string,
): Promise<void> {
  const outgoing: MessageInsert = {
    organization_id: conversation.organization_id,
    conversation_id: conversation.id,
    service: conversation.service,
    organization_address: conversation.organization_address,
    contact_address: conversation.contact_address,
    direction: "outgoing",
    agent_id: agent.id,
    content: {
      version: "1",
      type: "text",
      kind: "text",
      text: texto,
    },
  };

  await client.from("messages").insert(outgoing).throwOnError();
}

/**
 * Corre el pipeline completo. Nunca tira: cualquier error se traduce en
 * "no se envió nada" + log.
 */
export async function runGuardrail(
  params: GuardrailParams,
): Promise<GuardrailResult> {
  const { client, conversation, contact, agent, mensajePaciente, headers } =
    params;

  const offtopicCount = leerOfftopicCount(contact);

  // ── Portón 0: falta la config que se edita a mano ──
  // Sin lista curada de servicios habilitados (o sin link de Calendly) el
  // redactor no tiene contra qué matchear y mandaría saludo genérico a todo el
  // mundo, quemándole el "pase gratis" a cada paciente. Abortamos antes de
  // gastar un llamado a Claude.
  if (!guardrailListo()) {
    log.warn(
      "Guardrail activo pero falta config manual (SERVICIOS_HABILITADOS y/o CALENDLY_LINK). No se responde nada. Editar guardrail/catalogo.ts.",
    );

    return {
      enviado: false,
      motivo: "configuración del catálogo pendiente",
    };
  }

  // ── Portón 1: precios vigentes desde Supabase ──
  // Se leen en cada mensaje a propósito: `precios_vigentes` se sincroniza sola
  // cuando Meli edita el Google Sheets, así un cambio de precio impacta al toque
  // sin redeploy. Si la query falla, fail-closed: no se responde nada, porque
  // sin catálogo el bot no tiene fuente de verdad y solo podría improvisar.
  let catalogo: string;

  try {
    const cargado = await cargarCatalogo(client, conversation.organization_id);

    if (!cargado.cantidad) {
      log.error(
        "Ningún servicio habilitado matcheó con precios_vigentes. No se responde nada.",
      );

      return { enviado: false, motivo: "catálogo vacío" };
    }

    log.info(`Guardrail — catálogo cargado (${cargado.cantidad} servicios)`);

    catalogo = cargado.texto;
  } catch (error) {
    log.error("No se pudo cargar el catálogo de precios", error as Error);

    return { enviado: false, motivo: "error al cargar el catálogo" };
  }

  const apiKey = agent.extra.api_key ?? Deno.env.get("ANTHROPIC_API_KEY");

  if (!apiKey) {
    log.error(
      "Guardrail activo pero falta ANTHROPIC_API_KEY (ni en agent.extra.api_key ni como secret). No se responde nada.",
    );

    return { enviado: false, motivo: "falta ANTHROPIC_API_KEY" };
  }

  const model = agent.extra.model;
  const llamado = { apiKey, model, headers, maxTokens: agent.extra.max_tokens };

  // ══════════════ PASO 1 — REDACTOR ══════════════

  let redactor: SalidaRedactor;

  try {
    redactor = await callStructured<SalidaRedactor>({
      ...llamado,
      system: systemRedactor(catalogo, offtopicCount),
      userMessage: userRedactor(mensajePaciente),
      schema: SCHEMA_REDACTOR,
    });
  } catch (error) {
    const detalle = error instanceof GuardrailLLMError
      ? error.message
      : String(error);

    log.error("Falló el redactor. No se responde nada.", detalle);

    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: "silencio",
      mensajeBorrador: "",
      motivo: `error técnico en el redactor: ${detalle}`,
      offtopicCount,
    });

    return { enviado: false, motivo: "error en el redactor" };
  }

  log.info("Guardrail — redactor", {
    tipo: redactor.tipo,
    offtopic_count: offtopicCount,
  });

  // ── Camino SILENCIO: no hay juez, no hay nada que aprobar ──
  if (redactor.tipo === "silencio") {
    await incrementarOfftopic(client, contact);

    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: "silencio",
      mensajeBorrador: "",
      motivo: "silencio - contador >= 1",
      offtopicCount,
    });

    return {
      enviado: false,
      tipo: "silencio",
      motivo: "silencio - contador >= 1",
    };
  }

  // Defensa por las dudas: tipo que sí debería llevar texto, pero vino vacío.
  if (!redactor.mensaje?.trim()) {
    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: redactor.tipo,
      mensajeBorrador: "",
      motivo: `el redactor devolvió tipo '${redactor.tipo}' con mensaje vacío`,
      offtopicCount,
    });

    return { enviado: false, tipo: redactor.tipo, motivo: "borrador vacío" };
  }

  // ══════════════ PASO 2 — JUEZ ══════════════

  let juez: SalidaJuez;

  try {
    juez = await callStructured<SalidaJuez>({
      ...llamado,
      system: systemJuez(catalogo, offtopicCount),
      userMessage: userJuez(mensajePaciente, redactor.tipo, redactor.mensaje),
      schema: SCHEMA_JUEZ,
    });
  } catch (error) {
    const detalle = error instanceof GuardrailLLMError
      ? error.message
      : String(error);

    log.error("Falló el juez. No se responde nada.", detalle);

    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: redactor.tipo,
      mensajeBorrador: redactor.mensaje,
      motivo: `error técnico en el juez: ${detalle}`,
      offtopicCount,
    });

    return { enviado: false, tipo: redactor.tipo, motivo: "error en el juez" };
  }

  log.info("Guardrail — juez", {
    aprobado: juez.aprobado,
    motivo: juez.motivo,
  });

  // ── Rechazado: no se manda nada, se loguea, y nada más ──
  // (decisión explícita de Santi: no escalar a humano automáticamente)
  if (!juez.aprobado) {
    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: redactor.tipo,
      mensajeBorrador: redactor.mensaje,
      motivo: juez.motivo,
      offtopicCount,
    });

    return {
      enviado: false,
      tipo: redactor.tipo,
      motivo: `rechazado por el juez: ${juez.motivo}`,
    };
  }

  // ── Aprobado: se manda de verdad ──
  try {
    await enviarMensaje(client, conversation, agent, redactor.mensaje);
  } catch (error) {
    log.error("Falló el envío del mensaje aprobado", error as Error);

    return { enviado: false, tipo: redactor.tipo, motivo: "error al enviar" };
  }

  // El "pase gratis" recién se cobra cuando el saludo se envió de verdad.
  // Si fue tipo 'catalogo', el contador NO se toca.
  if (redactor.tipo === "saludo_generico") {
    await incrementarOfftopic(client, contact);
  }

  return {
    enviado: true,
    tipo: redactor.tipo,
    motivo: juez.motivo,
  };
}
