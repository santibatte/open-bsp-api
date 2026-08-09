/**
 * Guardrail redactor + juez — Consultorio de la Vampiresa Meli.
 *
 * Pipeline determinístico por cada mensaje entrante (v16):
 *
 *   0. ETAPA     clasifica la conversación  → { etapa }        (etapa.ts)
 *   1. REDACTOR  clasifica y redacta        → { tipo, mensaje, datos_detectados }
 *   1b. AGENTE DE TURNOS (condicional) solo si tipo="gestion_turno" — corre
 *       en `guardrail/turnos.ts`, con tools reales contra Calendly y gating
 *       por sub-estado de agendamiento.
 *   2. JUEZ      aprueba o rechaza          → { aprobado, motivo }
 *   2b. REESCRITURA (condicional) si el juez rechazó: UN intento de corregir
 *       el motivo puntual, y el juez revisa esa versión. Segundo rechazo =
 *       silencio real.
 *
 * Entre 2 y 5 llamados a Claude según el camino. Todos con JSON forzado por
 * schema (output_config.format, Messages API nativa — ver el comentario largo
 * en anthropic.ts sobre por qué no se reusa ChatCompletionsHandler), y todos
 * logueados en `agent_llm_calls` para observabilidad de costo (costos.ts,
 * best-effort: nunca bloquea la respuesta).
 *
 * Principio de diseño: FAIL-CLOSED. Cualquier cosa que salga mal — API caída,
 * JSON raro, catálogo sin cargar, contacto inexistente, Calendly caído —
 * termina en "no mandar nada" (y, en el camino de turnos, "no ejecutar nada").
 * Nunca en "mandar/agendar algo sin verificar".
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
import { crearCalendlyTools } from "../../_shared/calendly.ts";
import {
  agregarTurnoFinal,
  callStructured,
  GuardrailLLMError,
  type GuardrailTurn,
} from "./anthropic.ts";

// Re-exportada para no romper `guardrail-golden-set/index.ts`, que la
// importaba de acá antes de que se moviera a `anthropic.ts` (evita un
// import circular con `turnos.ts`, ver el comentario en su definición).
export { agregarTurnoFinal };
import {
  cargarCatalogo,
  guardrailListo,
  MENSAJE_NO_TEXTUAL,
} from "./catalogo.ts";
import {
  type DatosContactoGuardados,
  type SalidaJuez,
  type SalidaRedactor,
  type SalidaReescritura,
  SCHEMA_JUEZ,
  SCHEMA_REDACTOR,
  SCHEMA_REESCRITURA,
  SUB_ESTADO_INICIAL,
  type SubEstadoAgendamiento,
  systemJuezContexto,
  systemJuezEstatico,
  systemRedactorBloques,
  systemRedactorContexto,
  systemReescrituraContexto,
  systemReescrituraEstatico,
  type TipoRespuesta,
  userJuez,
  userRedactor,
  userReescritura,
} from "./prompts.ts";
import {
  aplicarOverrideEtapaSobreTipo,
  calcularSubEstadoParaLlamado,
  ejecutarPasoTurnos,
  guardarSubEstado,
  leerSubEstado,
} from "./turnos.ts";
import { clasificarEtapa, guardarEtapa, leerEtapa } from "./etapa.ts";
import { hookCosto } from "./costos.ts";

export interface GuardrailParams {
  client: SupabaseClient;
  conversation: ConversationRow;
  contact?: ContactRow;
  agent: AgentRowWithExtra;
  /**
   * Tipo del contenido entrante ("text", "file", ...). Cuando no es "text" se
   * responde con una regla fija sin consultar al modelo.
   */
  tipoMensaje: string;
  /** Texto del mensaje entrante. Vacío cuando `tipoMensaje` no es "text". */
  mensajePaciente: string;
  /**
   * Últimos turnos reales de la conversación (ambas direcciones), armados en
   * `agent-client/index.ts::getRecentHistoryTurns()`. Vacío si es el primer
   * mensaje de la conversación. Reemplaza el texto embebido que se usaba
   * hasta v10 (ver el comentario largo en `guardrail/anthropic.ts`).
   */
  historialTurnos?: GuardrailTurn[];
  /** Id del mensaje entrante — clave de idempotencia de `turno_acciones`. */
  incomingMessageId: string;
  /** Headers de trazabilidad (organization-id, conversation-id, ...). */
  headers?: Record<string, string>;
}

export interface GuardrailResult {
  enviado: boolean;
  tipo?: TipoRespuesta;
  motivo: string;
}

/**
 * Lee los datos de contacto ya guardados (memoria de largo plazo). Mismo
 * campo `contacts.extra` que `etapa` y `agendamiento_estado`, claves `email`
 * y `nombre_completo`. Ausentes o vacíos = null (no "" — evita mostrarle al
 * redactor un dato guardado en blanco).
 */
function leerDatosContacto(contact?: ContactRow): DatosContactoGuardados {
  const extra = contact?.extra as Record<string, unknown> | null | undefined;

  const email = typeof extra?.email === "string" && extra.email.trim()
    ? extra.email.trim()
    : null;

  const nombreCompleto =
    typeof extra?.nombre_completo === "string" && extra.nombre_completo.trim()
      ? extra.nombre_completo.trim()
      : null;

  const turnoAdicionalAvisado = extra?.turno_adicional_avisado === true;

  return { email, nombreCompleto, turnoAdicionalAvisado };
}

/**
 * Persiste que ya se le avisó a la paciente sobre un turno existente antes
 * de agendar otro (Fix 3, 2026-08-09). Mismo RPC/patrón best-effort que
 * `guardarDatosContacto`/`guardarSubEstado`.
 */
async function guardarTurnoAdicionalAvisado(
  client: SupabaseClient,
  contact: ContactRow | undefined,
): Promise<void> {
  if (!contact?.id) return;

  const { error } = await client.rpc("merge_contact_datos_contacto", {
    _contact_id: contact.id,
    _datos: { turno_adicional_avisado: true },
  });

  if (error) {
    log.error(
      "Falló merge_contact_datos_contacto (turno_adicional_avisado)",
      error,
    );
  }
}

/**
 * Resetea el aviso de "turno adicional" junto con el sub-estado, cada vez
 * que arranca un ciclo de agendamiento nuevo — si no, una paciente que ya
 * fue avisada una vez en un ciclo viejo no recibiría el aviso en una
 * situación de turno duplicado distinta más adelante.
 */
async function resetearTurnoAdicionalAvisado(
  client: SupabaseClient,
  contact: ContactRow | undefined,
): Promise<void> {
  if (!contact?.id) return;

  const { error } = await client.rpc("merge_contact_datos_contacto", {
    _contact_id: contact.id,
    _datos: { turno_adicional_avisado: false },
  });

  if (error) {
    log.error(
      "Falló merge_contact_datos_contacto (reset turno_adicional_avisado)",
      error,
    );
  }
}

/**
 * Persiste los datos que el redactor (o el paso de turnos) detectó en el
 * mensaje (memoria de largo plazo), vía RPC atómico (ver
 * `merge_contact_datos_contacto()` en `agent_guardrails.sql`) — el mismo RPC
 * que usan `guardarEtapa()` y `guardarSubEstado()`. No hace nada si no se
 * detectó ningún dato nuevo en este mensaje puntual.
 */
async function guardarDatosContacto(
  client: SupabaseClient,
  contact: ContactRow | undefined,
  datos: { email: string | null; nombre_completo: string | null } | undefined,
): Promise<void> {
  if (!contact?.id || !datos) return;

  const patch: Record<string, string> = {};

  if (typeof datos.email === "string" && datos.email.trim()) {
    patch.email = datos.email.trim();
  }

  if (
    typeof datos.nombre_completo === "string" && datos.nombre_completo.trim()
  ) {
    patch.nombre_completo = datos.nombre_completo.trim();
  }

  if (!Object.keys(patch).length) return;

  const { error } = await client.rpc("merge_contact_datos_contacto", {
    _contact_id: contact.id,
    _datos: patch,
  });

  if (error) {
    log.error("Falló merge_contact_datos_contacto", error);
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
      // `offtopic_count` queda NULL a propósito desde v16: el contador de
      // fuera de tema se eliminó (ver prompts.ts). La columna sigue en la
      // tabla para no perder las filas históricas que sí lo tienen.
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
 * Texto plano de un turno de historial, para armar el `textoConversacion`
 * que usa el gate de seguridad de `turnos.ts` (heurística de "el día/hora
 * aparece en la conversación"). Los turnos de historial siempre tienen
 * `content: string` (nunca bloques de tool) — ver `getRecentHistoryTurns`.
 */
function historialComoTexto(historial: GuardrailTurn[]): string {
  return historial
    .map((t) => (typeof t.content === "string" ? t.content : ""))
    .join("\n");
}

/**
 * Corre el pipeline completo. Nunca tira: cualquier error se traduce en
 * "no se envió nada" + log.
 */
export async function runGuardrail(
  params: GuardrailParams,
): Promise<GuardrailResult> {
  const {
    client,
    conversation,
    contact,
    agent,
    tipoMensaje,
    mensajePaciente,
    historialTurnos,
    incomingMessageId,
    headers,
  } = params;

  const datosGuardados = leerDatosContacto(contact);
  const etapaGuardada = leerEtapa(contact);
  const subEstadoGuardado = leerSubEstado(contact);
  const historial = historialTurnos ?? [];

  // ── Portón 0: falta la config que se edita a mano ──
  // Sin lista curada de servicios habilitados (o sin link de Calendly) el
  // redactor no tiene contra qué matchear y mandaría saludo genérico a todo
  // el mundo. Abortamos antes de gastar un llamado a Claude.
  if (!guardrailListo()) {
    log.warn(
      "Guardrail activo pero SERVICIOS_HABILITADOS está vacío. No se responde nada. Editar guardrail/catalogo.ts.",
    );

    return {
      enviado: false,
      motivo: "configuración del catálogo pendiente",
    };
  }

  // ── Mensaje no textual: respuesta fija, sin LLM ──
  if (tipoMensaje !== "text") {
    log.info(
      `Guardrail — mensaje no textual (${tipoMensaje}): redirección fija a mail`,
    );

    try {
      await enviarMensaje(client, conversation, agent, MENSAJE_NO_TEXTUAL);
    } catch (error) {
      log.error("Falló el envío de la redirección a mail", error as Error);

      return { enviado: false, motivo: "error al enviar" };
    }

    return {
      enviado: true,
      motivo: `redirección a mail por mensaje no textual (${tipoMensaje})`,
    };
  }

  // ── Portón 1: precios vigentes desde Supabase ──
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

  // Base del log de costo (`guardrail/costos.ts`). Cada paso agrega su
  // `step`; los inserts son fire-and-forget y nunca bloquean la respuesta.
  const costoBase = {
    client,
    organizationId: conversation.organization_id,
    conversationId: conversation.id,
  };

  // ══════════════ PASO 0 — ETAPA DE LA CONVERSACIÓN ══════════════
  //
  // Fail-soft: si el clasificador falla, `clasificarEtapa` devuelve la etapa
  // guardada y el pipeline sigue igual (ver el comentario en `etapa.ts`).

  const etapa = await clasificarEtapa({
    apiKey,
    model,
    headers,
    mensajePaciente,
    historial,
    etapaGuardada,
    onLlamado: hookCosto({ ...costoBase, step: "etapa" }),
  });

  if (etapa !== etapaGuardada) {
    await guardarEtapa(client, contact, etapa);
  }

  // El sub-estado del agendamiento solo vive DENTRO del flujo de turnos: si
  // la conversación no está agendando (o volvió a arrancar de cero tras un
  // turno ya cerrado), se reinicia al primer escalón. Sin esto, una paciente
  // que ya agendó una vez arrancaría su próximo turno en
  // `lista_para_agendar`, con la tool de escritura habilitada de entrada.
  const subEstado: SubEstadoAgendamiento =
    etapa === "agendando" || etapa === "agendado"
      ? subEstadoGuardado
      : SUB_ESTADO_INICIAL;

  if (subEstado !== subEstadoGuardado) {
    await guardarSubEstado(client, contact, subEstado);

    if (
      subEstado === SUB_ESTADO_INICIAL && datosGuardados.turnoAdicionalAvisado
    ) {
      await resetearTurnoAdicionalAvisado(client, contact);
    }
  }

  log.info("Guardrail — etapa", { etapa, sub_estado: subEstado });

  // ══════════════ PASO 1 — REDACTOR ══════════════

  const turnoActual: GuardrailTurn = {
    role: "user",
    content: userRedactor(mensajePaciente),
  };
  const messagesRedactor = agregarTurnoFinal(historial, turnoActual);

  let redactor: SalidaRedactor;

  try {
    redactor = await callStructured<SalidaRedactor>({
      ...llamado,
      system: [
        ...systemRedactorBloques(catalogo),
        systemRedactorContexto(datosGuardados, etapa),
      ],
      messages: messagesRedactor,
      schema: SCHEMA_REDACTOR,
      onLlamado: hookCosto({ ...costoBase, step: "redactor" }),
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
    });

    return { enviado: false, motivo: "error en el redactor" };
  }

  log.info("Guardrail — redactor", { tipo: redactor.tipo, etapa });

  // ── Override: la ETAPA pisa al "tipo" del redactor cuando ya estamos
  // agendando (Incidente 13, 2026-08-08) — ver `aplicarOverrideEtapaSobreTipo`
  // en turnos.ts para el porqué y por qué está factorizada ahí (el golden
  // set la llama también).
  const tipoConOverride = aplicarOverrideEtapaSobreTipo(redactor.tipo, etapa);

  if (tipoConOverride !== redactor.tipo) {
    log.info("Guardrail — override: la etapa fuerza gestion_turno", {
      tipo_original: redactor.tipo,
      etapa,
    });
    redactor.tipo = tipoConOverride;
    redactor.mensaje = "";
  }

  // Memoria de largo plazo: si la paciente escribió su mail o su nombre en
  // este mensaje, guardarlo — independiente de si el juez termina aprobando
  // la respuesta o no.
  await guardarDatosContacto(client, contact, redactor.datos_detectados);

  // ── Camino SILENCIO: no hay juez, no hay nada que aprobar ──
  //
  // v16: ya no hay contador, así que este camino se reduce a lo que siempre
  // debió ser — el mensaje entrante no tiene contenido interpretable. Todo
  // lo demás, incluido cualquier fuera de tema por enésima vez, se contesta
  // con `saludo_generico`.
  if (redactor.tipo === "silencio") {
    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: "silencio",
      mensajeBorrador: "",
      motivo: "silencio - mensaje sin contenido interpretable",
    });

    return {
      enviado: false,
      tipo: "silencio",
      motivo: "silencio - mensaje sin contenido interpretable",
    };
  }

  // ── Camino GESTION_TURNO: paso ejecutor con tools (guardrail/turnos.ts) ──
  //
  // El redactor no redacta nada acá (mensaje vacío a propósito, ver
  // prompts.ts) — este paso consulta Calendly de verdad y, si corresponde,
  // ejecuta agendar_turno. Su salida reemplaza el mensaje del redactor antes
  // de pasar al juez, junto con una evidencia que el juez puede verificar.
  let evidenciaTurnos = "";

  if (redactor.tipo === "gestion_turno") {
    const calendlyApiKey = Deno.env.get("CALENDLY_API_KEY");

    if (!calendlyApiKey) {
      log.error(
        "Guardrail — gestion_turno pero falta el secret CALENDLY_API_KEY. No se responde nada.",
      );

      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: "gestion_turno",
        mensajeBorrador: "",
        motivo: "falta CALENDLY_API_KEY",
      });

      return {
        enviado: false,
        tipo: "gestion_turno",
        motivo: "falta CALENDLY_API_KEY",
      };
    }

    const telefono = conversation.contact_address;

    if (!telefono) {
      log.error(
        "Guardrail — gestion_turno pero la conversación no tiene contact_address. No se responde nada.",
      );

      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: "gestion_turno",
        mensajeBorrador: "",
        motivo: "conversación sin contact_address",
      });

      return {
        enviado: false,
        tipo: "gestion_turno",
        motivo: "conversación sin contact_address",
      };
    }

    const calendlyTools = crearCalendlyTools(calendlyApiKey);

    let turnosExistentes;

    try {
      // `datosGuardados.email` como fallback (2026-08-09): si no aparece
      // nada por teléfono y ya conocemos el mail de esta paciente de una
      // conversación anterior, probar también por mail antes de decir que
      // no tiene turnos — cubre agendar con un número distinto al que usa
      // para escribirle al bot. Si el mail es de ESTE mensaje puntual
      // (recién lo escribió), todavía no está acá — llega recién en el
      // próximo mensaje, una vez que `guardarDatosContacto` lo persista.
      turnosExistentes =
        (await calendlyTools.consultarTurno(telefono, 90, datosGuardados.email))
          .turnos;
    } catch (error) {
      log.error(
        "Guardrail — falló consultarTurno. No se responde nada.",
        error as Error,
      );

      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: "gestion_turno",
        mensajeBorrador: "",
        motivo: `error consultando Calendly: ${error}`,
      });

      return {
        enviado: false,
        tipo: "gestion_turno",
        motivo: "error consultando Calendly",
      };
    }

    // ── Incidente 13b (2026-08-08): el mail/nombre de ESTE mensaje tienen
    // que poder abrir el gate de `agendar_turno` en el MISMO turno, no en el
    // siguiente — ver `calcularSubEstadoParaLlamado` en turnos.ts (el golden
    // set la llama también, mismo motivo que el override de arriba). ──
    const subEstadoParaLlamado = calcularSubEstadoParaLlamado(
      subEstado,
      datosGuardados,
      redactor.datos_detectados,
    );

    if (subEstadoParaLlamado !== subEstado) {
      log.info(
        "Guardrail — sub-estado adelantado antes de llamar a turnos (datos ya completos en este mensaje)",
        { de: subEstado, a: subEstadoParaLlamado },
      );
    }

    const datosEfectivosDeEsteMensaje = {
      email: redactor.datos_detectados.email?.trim() || datosGuardados.email,
      nombreCompleto: redactor.datos_detectados.nombre_completo?.trim() ||
        datosGuardados.nombreCompleto,
    };

    const pasoTurnos = await ejecutarPasoTurnos({
      llamado,
      catalogo,
      mensajePaciente,
      historial,
      historialTexto: historialComoTexto(historial),
      turnosExistentes,
      subEstado: subEstadoParaLlamado,
      datosGuardados: {
        email: datosEfectivosDeEsteMensaje.email,
        nombreCompleto: datosEfectivosDeEsteMensaje.nombreCompleto,
        turnoAdicionalAvisado: datosGuardados.turnoAdicionalAvisado,
      },
      onLlamado: hookCosto({ ...costoBase, step: "turnos" }),
      tools: calendlyTools,
      client,
      conversation,
      contact,
      incomingMessageId,
    });

    if (!pasoTurnos.ok) {
      log.error(
        "Guardrail — falló el paso de turnos. No se responde nada.",
        pasoTurnos.motivo,
      );

      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: "gestion_turno",
        mensajeBorrador: "",
        motivo: pasoTurnos.motivo,
      });

      return {
        enviado: false,
        tipo: "gestion_turno",
        motivo: pasoTurnos.motivo,
      };
    }

    await guardarDatosContacto(client, contact, pasoTurnos.datosDetectados);

    if (pasoTurnos.turnoAdicionalAvisado) {
      await guardarTurnoAdicionalAvisado(client, contact);
    }

    // El sub-estado nuevo ya viene validado por `proximoSubEstado()` (no se
    // salta escalones, no llega a `lista_para_agendar` sin mail y nombre, y
    // solo el código puede ponerlo en `agendado`).
    if (pasoTurnos.subEstadoNuevo !== subEstado) {
      await guardarSubEstado(client, contact, pasoTurnos.subEstadoNuevo);
      log.info("Guardrail — sub-estado de agendamiento", {
        de: subEstado,
        a: pasoTurnos.subEstadoNuevo,
      });
    }

    redactor = {
      tipo: "gestion_turno",
      mensaje: pasoTurnos.mensaje,
      datos_detectados: pasoTurnos.datosDetectados,
    };
    evidenciaTurnos = pasoTurnos.evidencia;
  }

  // Defensa por las dudas: tipo que sí debería llevar texto, pero vino vacío.
  if (!redactor.mensaje?.trim()) {
    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: redactor.tipo,
      mensajeBorrador: "",
      motivo:
        `el paso de redacción devolvió tipo '${redactor.tipo}' con mensaje vacío`,
    });

    return { enviado: false, tipo: redactor.tipo, motivo: "borrador vacío" };
  }

  // ══════════════ PASO 2 — JUEZ (+ 1 REESCRITURA) ══════════════
  //
  // El juez NO recibe el historial de la conversación (decisión de Santi
  // 2026-08-06, anotada para revisar por optimización más adelante — ver
  // proyectos/P05_plan_tools_turnos.md sección 7 punto 9): evalúa solo el
  // mensaje puntual + la evidencia de turnos, si la hay.
  //
  // v16 — LOOP DE REESCRITURA: si el juez rechaza, se hace UN llamado corto
  // que corrige específicamente el motivo señalado y el juez revisa esa
  // segunda versión. Si vuelve a rechazar, recién ahí es silencio real
  // (fail-closed, igual que siempre), logueado con un motivo distinguible
  // (`rechazado 2 veces`) para poder medir la frecuencia: si aparece seguido,
  // la señal es que hay que seguir acotando al juez, no agregar otra capa
  // (ver el plan, sección 2).

  let mensajeFinal = redactor.mensaje;
  let juez: SalidaJuez;
  let yaSeReescribio = false;

  while (true) {
    try {
      juez = await callStructured<SalidaJuez>({
        ...llamado,
        system: [
          systemJuezEstatico(catalogo),
          systemJuezContexto(evidenciaTurnos),
        ],
        messages: [
          {
            role: "user",
            content: userJuez(mensajePaciente, redactor.tipo, mensajeFinal),
          },
        ],
        schema: SCHEMA_JUEZ,
        onLlamado: hookCosto({ ...costoBase, step: "juez" }),
      });
    } catch (error) {
      const detalle = error instanceof GuardrailLLMError
        ? error.message
        : String(error);

      log.error("Falló el juez. No se responde nada.", detalle);

      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: redactor.tipo,
        mensajeBorrador: mensajeFinal,
        motivo: `error técnico en el juez: ${detalle}`,
      });

      return {
        enviado: false,
        tipo: redactor.tipo,
        motivo: "error en el juez",
      };
    }

    log.info("Guardrail — juez", {
      aprobado: juez.aprobado,
      reescrito: yaSeReescribio,
      motivo: juez.motivo,
    });

    if (juez.aprobado) break;

    // ── Segundo rechazo: silencio real (fail-closed) ──
    if (yaSeReescribio) {
      const motivo = `rechazado 2 veces por el juez: ${juez.motivo}`;

      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: redactor.tipo,
        mensajeBorrador: mensajeFinal,
        motivo,
      });

      return { enviado: false, tipo: redactor.tipo, motivo };
    }

    // ── Primer rechazo: una sola reescritura acotada ──
    let reescritura: SalidaReescritura;

    try {
      reescritura = await callStructured<SalidaReescritura>({
        ...llamado,
        system: [
          systemReescrituraEstatico(catalogo),
          systemReescrituraContexto(evidenciaTurnos),
        ],
        messages: [
          {
            role: "user",
            content: userReescritura(
              mensajePaciente,
              mensajeFinal,
              juez.motivo,
            ),
          },
        ],
        schema: SCHEMA_REESCRITURA,
        onLlamado: hookCosto({ ...costoBase, step: "reescritura" }),
      });
    } catch (error) {
      const detalle = error instanceof GuardrailLLMError
        ? error.message
        : String(error);

      log.error("Falló la reescritura. No se responde nada.", detalle);

      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: redactor.tipo,
        mensajeBorrador: mensajeFinal,
        motivo:
          `rechazado por el juez (${juez.motivo}) y falló la reescritura: ${detalle}`,
      });

      return {
        enviado: false,
        tipo: redactor.tipo,
        motivo: "error en la reescritura",
      };
    }

    if (!reescritura.mensaje?.trim()) {
      await registrarNoEnviada(client, conversation, contact, {
        mensajePaciente,
        tipo: redactor.tipo,
        mensajeBorrador: mensajeFinal,
        motivo:
          `rechazado por el juez (${juez.motivo}) y la reescritura vino vacía`,
      });

      return {
        enviado: false,
        tipo: redactor.tipo,
        motivo: "reescritura vacía",
      };
    }

    log.info("Guardrail — reescritura aplicada", { motivo: juez.motivo });

    mensajeFinal = reescritura.mensaje;
    yaSeReescribio = true;
  }

  // ── Aprobado: se manda de verdad ──
  //
  // `mensajeFinal` es el borrador original o su reescritura, según qué versión
  // haya aprobado el juez. Nunca se envía nada que no haya pasado por él.
  try {
    await enviarMensaje(client, conversation, agent, mensajeFinal);
  } catch (error) {
    log.error("Falló el envío del mensaje aprobado", error as Error);

    return { enviado: false, tipo: redactor.tipo, motivo: "error al enviar" };
  }

  return {
    enviado: true,
    tipo: redactor.tipo,
    motivo: yaSeReescribio
      ? `aprobado tras reescritura: ${juez.motivo}`
      : juez.motivo,
  };
}
