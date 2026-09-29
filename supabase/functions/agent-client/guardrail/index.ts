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
  ContactAddressRow,
  ContactRow,
  ConversationRow,
  MessageInsert,
} from "../../_shared/supabase.ts";
import type { AgentRowWithExtra } from "../protocols/base.ts";
import {
  consultarJornadasIpl,
  crearCalendlyTools,
  resolverLinkAgendamiento,
  type ResultadoLinkAgendamiento,
} from "../../_shared/calendly.ts";
import {
  agregarTurnoFinal,
  callStructured,
  GuardrailLLMError,
  type GuardrailTurn,
} from "./anthropic.ts";
import { findCtwaClid } from "../../_shared/referral.ts";

// Re-exportada para no romper `guardrail-golden-set/index.ts`, que la
// importaba de acá antes de que se moviera a `anthropic.ts` (evita un
// import circular con `turnos.ts`, ver el comentario en su definición).
export { agregarTurnoFinal };
import {
  CALENDLY_LINK,
  cargarCatalogo,
  guardrailListo,
  MAIL_CONSULTAS,
  MENSAJE_NO_TEXTUAL,
} from "./catalogo.ts";
import {
  type DatosContactoGuardados,
  type SalidaRedactor,
  SCHEMA_REDACTOR,
  SUB_ESTADO_INICIAL,
  type SubEstadoAgendamiento,
  systemRedactorBloques,
  systemRedactorContexto,
  textoJornadasIpl,
  type TipoRespuesta,
  userRedactor,
} from "./prompts.ts";
import { controlarBorrador } from "./control.ts";
import {
  aplicarOverrideEtapaSobreTipo,
  calcularSubEstadoParaLlamado,
  datosEfectivos,
  ejecutarPasoTurnos,
  guardarSubEstado,
  leerSubEstado,
  leerTurnoConsultado,
} from "./turnos.ts";
import {
  crearMemoriaPaciente,
  guardarEnMemoria,
  type MemoriaPaciente,
} from "./memoria.ts";
import { clasificarEtapa, guardarEtapa, leerEtapa } from "./etapa.ts";
import { hookCosto } from "./costos.ts";

export interface GuardrailParams {
  client: SupabaseClient;
  conversation: ConversationRow;
  contact?: ContactRow;
  /** Fila del teléfono de la conversación — donde vive la memoria de la
   * paciente cuando todavía no tiene contacto (ver `memoria.ts`). */
  contactAddress?: ContactAddressRow | null;
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
 * Lee los datos de contacto ya guardados (memoria de largo plazo, ver
 * `memoria.ts`), claves `email` y `nombre_completo`. Ausentes o vacíos =
 * null (no "" — evita mostrarle al redactor un dato guardado en blanco).
 */
function leerDatosContacto(
  extra: Record<string, unknown> | null | undefined,
): DatosContactoGuardados {
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
 * de agendar otro (Fix 3, 2026-08-09). Best effort, como todo lo de
 * `memoria.ts`.
 */
async function guardarTurnoAdicionalAvisado(
  client: SupabaseClient,
  memoria: MemoriaPaciente,
): Promise<void> {
  await guardarEnMemoria(
    client,
    memoria,
    { turno_adicional_avisado: true },
    "turno_adicional_avisado",
  );
}

/**
 * Reinicia lo que es propio de UN ciclo de agendamiento cada vez que arranca
 * uno nuevo (o se cerró el anterior): el aviso de "turno adicional" — si no,
 * una paciente ya avisada en un ciclo viejo no recibiría el aviso en otra
 * situación de turno duplicado más adelante — y el último turno consultado
 * — si no, un agendar del ciclo nuevo podría tomar el día de uno viejo.
 */
async function resetearCicloAgendamiento(
  client: SupabaseClient,
  memoria: MemoriaPaciente,
): Promise<void> {
  const patch: Record<string, unknown> = {};

  if (memoria.extra.turno_adicional_avisado === true) {
    patch.turno_adicional_avisado = false;
  }

  if (memoria.extra.turno_consultado) patch.turno_consultado = null;

  await guardarEnMemoria(client, memoria, patch, "reset ciclo agendamiento");
}

/**
 * Persiste los datos que el redactor (o el paso de turnos) detectó en el
 * mensaje (memoria de largo plazo). No hace nada si no se detectó ningún
 * dato nuevo en este mensaje puntual.
 */
async function guardarDatosContacto(
  client: SupabaseClient,
  memoria: MemoriaPaciente,
  datos: { email: string | null; nombre_completo: string | null } | undefined,
): Promise<void> {
  if (!datos) return;

  const patch: Record<string, string> = {};

  if (typeof datos.email === "string" && datos.email.trim()) {
    patch.email = datos.email.trim();
  }

  if (
    typeof datos.nombre_completo === "string" && datos.nombre_completo.trim()
  ) {
    patch.nombre_completo = datos.nombre_completo.trim();
  }

  await guardarEnMemoria(client, memoria, patch, "datos de contacto");
}

/**
 * Registra en `public.agent_respuestas_no_enviadas` todo lo que NO se envió.
 * Es para revisión humana en bloque; no dispara ninguna acción automática.
 *
 * Exportada (además de usarse internamente en este archivo) porque
 * `agent-client/index.ts` también la llama directo para el silencio por
 * falla de transcripción de audio — ese camino corta ANTES de entrar a
 * `runGuardrail` (necesita el resultado de Gemini para decidir si hay
 * mensajePaciente real), así que no puede pasar por el gate normal de acá
 * abajo.
 */
export async function registrarNoEnviada(
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
 * Reemplaza, en un mensaje YA aprobado por el juez, el link genérico de
 * agendamiento por el real de la jornada especial que corresponda — ver el
 * comentario en el call site (justo antes de `enviarMensaje`) para el
 * porqué de que esto corra después del juez y no antes.
 */
function aplicarResolucionLink(
  mensaje: string,
  resolucion: ResultadoLinkAgendamiento,
): string {
  switch (resolucion.tipo) {
    case "generico":
      return mensaje;
    case "resuelto":
      return mensaje.replaceAll(CALENDLY_LINK, resolucion.link);
    case "ambiguo":
      return mensaje.replaceAll(
        CALENDLY_LINK,
        resolucion.opciones.map((o) => `${o.nombre}: ${o.link}`).join(" — "),
      );
    case "sin_evento_activo":
      return mensaje.replaceAll(
        CALENDLY_LINK,
        `que por el momento no tiene fecha agendable online — escribinos a ${MAIL_CONSULTAS} y te confirmamos la próxima`,
      );
  }
}

const MENCIONA_IPL = /\b(ipl|nir)\b|luz pulsada/i;

/** Cache por instancia de la Edge Function — evita pegarle a Calendly
 * (~7 requests por jornada activa) en cada mensaje de la misma charla. */
const JORNADAS_CACHE_MS = 10 * 60 * 1000;
let jornadasCache: { texto: string; en: number } | null = null;

/**
 * Texto de las jornadas IPL/NIR con lugar si `textoConversacion` menciona
 * IPL/NIR/luz pulsada; `undefined` si no aplica. Fail-soft: si Calendly
 * falla, el redactor sigue sin el bloque (igual que antes de v26) — el
 * catálogo ya le dice que no invente fechas de jornadas.
 */
async function jornadasIplSiCorresponde(
  textoConversacion: string,
): Promise<string | undefined> {
  if (!MENCIONA_IPL.test(textoConversacion)) return undefined;

  if (jornadasCache && Date.now() - jornadasCache.en < JORNADAS_CACHE_MS) {
    return jornadasCache.texto;
  }

  const apiKey = Deno.env.get("CALENDLY_API_KEY");

  if (!apiKey) return undefined;

  try {
    const texto = textoJornadasIpl(
      await consultarJornadasIpl(apiKey, { timeoutMs: 5000 }),
    );
    jornadasCache = { texto, en: Date.now() };
    return texto;
  } catch (error) {
    log.warn("Guardrail — no se pudieron consultar las jornadas de IPL", {
      detalle: String(error),
    });
    return undefined;
  }
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
    contactAddress,
    agent,
    tipoMensaje,
    mensajePaciente,
    historialTurnos,
    incomingMessageId,
    headers,
  } = params;

  const memoria = crearMemoriaPaciente(contact, contactAddress);
  const datosGuardados = leerDatosContacto(memoria.extra);
  const etapaGuardada = leerEtapa(memoria.extra);
  const subEstadoGuardado = leerSubEstado(memoria.extra);
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

  // Lead nuevo por ads: si el mensaje que abrió ESTA conversación de WhatsApp
  // trae el `ctwa_clid` de un anuncio Click-to-WhatsApp, esa conversación
  // puntual la atiende Sonnet en vez del Haiku default — mismo prompt, más
  // capacidad. Se recalcula por conversación (no queda un flag permanente en
  // el contacto): si la persona vuelve meses después sin pasar de nuevo por
  // el anuncio, esa conversación nueva vuelve a Haiku. NO cubre leads que
  // llegan por Instagram: ahí Meta manda un `referral` con forma distinta
  // (sin `ctwa_clid` — ver InstagramReferral), todavía sin manejar acá.
  const esReferralDeAds = conversation.contact_address
    ? !!(await findCtwaClid(
      client,
      conversation.organization_id,
      conversation.contact_address,
    ))
    : false;

  const model = esReferralDeAds ? "claude-sonnet-4-6" : agent.extra.model;

  if (esReferralDeAds) {
    log.info("Guardrail — referral de Meta detectado, usando Sonnet", {
      conversation_id: conversation.id,
    });
  }

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
    await guardarEtapa(client, memoria, etapa);
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
    await guardarSubEstado(client, memoria, subEstado);

    if (subEstado === SUB_ESTADO_INICIAL) {
      await resetearCicloAgendamiento(client, memoria);
    }
  }

  log.info("Guardrail — etapa", { etapa, sub_estado: subEstado });

  // Jornadas de IPL/NIR en vivo, solo si la conversación toca el tema (ver
  // `consultarJornadasIpl` y v26 en prompts.ts).
  const jornadasIpl = await jornadasIplSiCorresponde(
    `${historialComoTexto(historial)}\n${mensajePaciente}`,
  );

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
        systemRedactorContexto(datosGuardados, etapa, jornadasIpl),
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
  await guardarDatosContacto(client, memoria, redactor.datos_detectados);

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

    // Mail/nombre efectivos de ESTE mensaje — combina lo ya guardado con lo
    // que el redactor acaba de detectar, sin esperar a que se persista en
    // Postgres (ver `datosEfectivos` en turnos.ts). Se calcula ACÁ, antes de
    // `consultarTurno`, a propósito: Fix del Incidente 2026-08-10 (Maria
    // Ines Cerdá, ver P05_lecciones_guardrail.md) — antes este bloque vivía
    // después de la búsqueda en Calendly, así que un mail recién tipeado en
    // este mismo mensaje llegaba tarde para encontrar un turno ya agendado.
    const datosEfectivosDeEsteMensaje = datosEfectivos(
      datosGuardados,
      redactor.datos_detectados,
    );

    let turnosExistentes;

    try {
      // Fallback por mail (2026-08-09): si no aparece nada por teléfono,
      // probar también por mail antes de decir que no tiene turnos — cubre
      // agendar con un número distinto al que usa para escribirle al bot.
      turnosExistentes = (await calendlyTools.consultarTurno(
        telefono,
        90,
        datosEfectivosDeEsteMensaje.email,
      )).turnos;
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
      memoria,
      turnoConsultado: leerTurnoConsultado(memoria.extra, new Date()),
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

    await guardarDatosContacto(client, memoria, pasoTurnos.datosDetectados);

    if (pasoTurnos.turnoAdicionalAvisado) {
      await guardarTurnoAdicionalAvisado(client, memoria);
    }

    // El sub-estado nuevo ya viene validado por `proximoSubEstado()` (no se
    // salta escalones, no llega a `lista_para_agendar` sin mail y nombre, y
    // solo el código puede ponerlo en `agendado`).
    if (pasoTurnos.subEstadoNuevo !== subEstado) {
      await guardarSubEstado(client, memoria, pasoTurnos.subEstadoNuevo);

      // Ya agendado: el turno consultado quedó usado — que no lo tome un
      // agendar posterior sin una consulta nueva.
      if (pasoTurnos.subEstadoNuevo === "agendado") {
        await guardarEnMemoria(
          client,
          memoria,
          { turno_consultado: null },
          "turno_consultado usado",
        );
      }
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

  // ══════════════ PASO 2 — CONTROL (verificador + juez médico) ══════════════
  //
  // `controlarBorrador` (control.ts): el verificador en código revisa los
  // datos (precios, fechas, horas, links, mails, alias) y el juez solo lo
  // médico; si alguno rechaza, UNA reescritura y se revisa de nuevo. Segundo
  // rechazo = silencio (fail-closed), con motivo `rechazado 2 veces por el
  // verificador|juez` para poder medir cuál de los dos frena más.
  //
  // Las jornadas de IPL que vio el redactor también son evidencia: si no, el
  // verificador rechazaría las fechas que el redactor tiene permitido dar.
  const evidencia = [evidenciaTurnos, jornadasIpl]
    .filter(Boolean)
    .join("\n\n");

  const control = await controlarBorrador({
    llamado,
    catalogo,
    evidencia,
    mensajePaciente,
    historial,
    tipo: redactor.tipo,
    borrador: redactor.mensaje,
    onLlamadoJuez: hookCosto({ ...costoBase, step: "juez" }),
    onLlamadoReescritura: hookCosto({ ...costoBase, step: "reescritura" }),
  });

  if (!control.enviar) {
    await registrarNoEnviada(client, conversation, contact, {
      mensajePaciente,
      tipo: redactor.tipo,
      mensajeBorrador: control.mensaje,
      motivo: control.motivoRegistro,
    });

    return { enviado: false, tipo: redactor.tipo, motivo: control.motivo };
  }

  let mensajeFinal = control.mensaje;

  // ── Aprobado: se manda de verdad ──
  //
  // `mensajeFinal` es el borrador original o su reescritura, según qué versión
  // aprobó el control. Nunca se envía nada que no haya pasado por él.
  //
  // Antes de enviar: si el mensaje aprobado incluye el link genérico Y la
  // consulta es sobre una jornada con evento propio (IPL/luz pulsada,
  // bioestimulación, Botox Party — esos cambian de link por campaña, ver
  // `resolverLinkAgendamiento` en `_shared/calendly.ts`), lo reemplazamos acá
  // por el real. A propósito DESPUÉS del juez: el juez nunca se entera de
  // esto, siempre valida el link fijo de siempre — ver Incidente reportado
  // por Santi 2026-09-16 (bot mandaba el link genérico para luz pulsada).
  if (mensajeFinal.includes(CALENDLY_LINK)) {
    const calendlyApiKeyLink = Deno.env.get("CALENDLY_API_KEY");

    if (calendlyApiKeyLink) {
      try {
        const resolucionLink = await resolverLinkAgendamiento(
          calendlyApiKeyLink,
          `${mensajePaciente} ${mensajeFinal}`,
        );

        mensajeFinal = aplicarResolucionLink(mensajeFinal, resolucionLink);
      } catch (error) {
        log.error(
          "No se pudo resolver el link de agendamiento especial — se manda el link genérico",
          error as Error,
        );
      }
    }
  }

  try {
    await enviarMensaje(client, conversation, agent, mensajeFinal);
  } catch (error) {
    log.error("Falló el envío del mensaje aprobado", error as Error);

    return { enviado: false, tipo: redactor.tipo, motivo: "error al enviar" };
  }

  return {
    enviado: true,
    tipo: redactor.tipo,
    motivo: control.reescrito
      ? `aprobado tras reescritura: ${control.motivo}`
      : control.motivo,
  };
}
