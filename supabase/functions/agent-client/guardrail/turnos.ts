/**
 * Paso ejecutor de gestión de turnos — corre SOLO cuando el redactor
 * clasifica el mensaje como `gestion_turno` (ver `guardrail/prompts.ts` y
 * `proyectos/P05_plan_tools_turnos.md`, repo `consultorio_dermatologico`,
 * para el diseño completo).
 *
 * Es la primera vez que el guardrail ejecuta una ACCIÓN real (agendar un
 * turno), no solo redacta texto — por eso los gates de este archivo son de
 * código, no de prompt: el modelo decide QUÉ decir y SI corresponde agendar,
 * el código decide si esa acción se EJECUTA de verdad (ver
 * `validarGateAgendar`) y ejecuta las lecturas (`consultarTurno`) por su
 * cuenta, nunca a pedido del modelo — el teléfono de la paciente nunca sale
 * de los argumentos que arma el modelo, siempre del código
 * (`conversation.contact_address`).
 *
 * Loop de tools con tope duro: como mucho `MAX_TOOL_CALLS` (1) ejecuciones
 * reales de una tool, y como mucho `MAX_TOOL_CALLS + 1` llamados a Claude en
 * total. Si el segundo llamado (después de ejecutar la tool) pide OTRA tool,
 * se aborta fail-closed — nunca hay un tercer llamado a Claude.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../../_shared/logger.ts";
import type { ContactRow, ConversationRow } from "../../_shared/supabase.ts";
import type {
  AgendarArgs,
  CalendlyTools,
  ResultadoAgendar,
  ResultadoDisponibilidad,
  TurnoEncontrado,
} from "../../_shared/calendly.ts";
import {
  fechaActualLegible,
  fechaConDiaSemana,
} from "../../_shared/calendly.ts";
import {
  type ExpresionFecha,
  normalizarTexto,
  resolverFechaExpresion,
  validarHoraHHMM,
} from "../../_shared/fechas.ts";
import {
  agregarTurnoFinal,
  type AnthropicTool,
  callStructured,
  GuardrailLLMError,
  type GuardrailTurn,
  type InfoLlamado,
} from "./anthropic.ts";
import {
  contextoAgenteTurnos,
  type DatosContactoGuardados,
  type SalidaAgenteTurnos,
  SCHEMA_AGENTE_TURNOS,
  SUB_ESTADO_INICIAL,
  SUB_ESTADOS_AGENDAMIENTO,
  type SubEstadoAgendamiento,
  systemAgenteTurnosEstatico,
  TOOL_AGENDAR_TURNO,
  TOOL_CONSULTAR_DISPONIBILIDAD,
  toolResultAgenteTurnos,
  userAgenteTurnos,
} from "./prompts.ts";

/**
 * ══════════════════════════════════════════════════════════════════════
 * GATING DE TOOLS POR SUB-ESTADO (v16)
 * ══════════════════════════════════════════════════════════════════════
 *
 * El gate es de CÓDIGO, no de prompt: `agendar_turno` sencillamente no viaja
 * en el request cuando el sub-estado no es `lista_para_agendar`, así que el
 * modelo no puede llamarla aunque el prompt lo confundiera, aunque la
 * paciente insistiera, o aunque un intento de prompt injection se lo pidiera.
 * Es la misma filosofía que `validarGateAgendar` (ver más abajo): el modelo
 * decide QUÉ decir, el código decide qué se PUEDE ejecutar.
 *
 * `consultar_disponibilidad` está siempre: es de solo lectura, no cambia nada
 * en Calendly, y hace falta en todos los escalones (incluso después de
 * agendado, si la paciente pregunta por otro día).
 */
export function toolsParaSubEstado(
  subEstado: SubEstadoAgendamiento,
): AnthropicTool[] {
  return subEstado === "lista_para_agendar"
    ? [TOOL_CONSULTAR_DISPONIBILIDAD, TOOL_AGENDAR_TURNO]
    : [TOOL_CONSULTAR_DISPONIBILIDAD];
}

/** Lee el sub-estado guardado en `contacts.extra.agendamiento_estado`. */
export function leerSubEstado(
  contact?: ContactRow,
): SubEstadoAgendamiento {
  const extra = contact?.extra as Record<string, unknown> | null | undefined;
  const raw = extra?.agendamiento_estado;

  return typeof raw === "string" &&
      (SUB_ESTADOS_AGENDAMIENTO as readonly string[]).includes(raw)
    ? raw as SubEstadoAgendamiento
    : SUB_ESTADO_INICIAL;
}

/**
 * Persiste el sub-estado en `contacts.extra`, con el mismo RPC de merge que
 * `email`/`nombre_completo`/`etapa`. Best effort: si falla se loguea y se
 * sigue (el peor caso es repetir un escalón, nunca saltearse uno — el gate
 * de tools se recalcula desde el valor guardado en el próximo mensaje).
 */
export async function guardarSubEstado(
  client: SupabaseClient,
  contact: ContactRow | undefined,
  subEstado: SubEstadoAgendamiento,
): Promise<void> {
  if (!contact?.id) return;

  const { error } = await client.rpc("merge_contact_datos_contacto", {
    _contact_id: contact.id,
    _datos: { agendamiento_estado: subEstado },
  });

  if (error) {
    log.error(
      "Paso de turnos — no se pudo guardar el sub-estado (se ignora)",
      error,
    );
  }
}

const ORDEN_SUB_ESTADOS: readonly SubEstadoAgendamiento[] =
  SUB_ESTADOS_AGENDAMIENTO;

/**
 * Valida la PROPUESTA de avance del modelo (`avanzar_a`) contra tres reglas
 * de código. El modelo sugiere; el código decide.
 *
 *  1. No se puede retroceder por sugerencia del modelo (solo el código
 *     reinicia el flujo, ver `reiniciarAgendamiento` en `index.ts`).
 *  2. No se puede saltar más de un escalón por mensaje: pasar de
 *     `recolectando_horario` a `lista_para_agendar` de una salteando la
 *     confirmación de datos es exactamente el atajo que este rediseño
 *     existe para evitar.
 *  3. `lista_para_agendar` exige mail Y nombre conocidos — es el escalón que
 *     habilita la tool de escritura, así que se chequea contra los datos
 *     reales, no contra lo que el modelo crea.
 *  4. `agendado` NUNCA lo pone el modelo: solo el código, y solo cuando
 *     Calendly confirmó (`agendoDeVerdad`).
 */
export function proximoSubEstado(
  actual: SubEstadoAgendamiento,
  propuesto: SubEstadoAgendamiento | null | undefined,
  datos: { email: string | null; nombreCompleto: string | null },
  agendoDeVerdad: boolean,
): SubEstadoAgendamiento {
  if (agendoDeVerdad) return "agendado";

  if (!propuesto || propuesto === actual) return actual;

  const iActual = ORDEN_SUB_ESTADOS.indexOf(actual);
  const iPropuesto = ORDEN_SUB_ESTADOS.indexOf(propuesto);

  if (iPropuesto <= iActual) return actual;

  // Como mucho un escalón por mensaje.
  const destino = ORDEN_SUB_ESTADOS[Math.min(iPropuesto, iActual + 1)];

  if (destino === "agendado") {
    // Solo el código llega acá, y solo vía `agendoDeVerdad`.
    return actual;
  }

  if (
    destino === "lista_para_agendar" &&
    !(datos.email?.trim() && datos.nombreCompleto?.trim())
  ) {
    log.warn(
      "Paso de turnos — el modelo pidió lista_para_agendar sin mail o nombre; se queda en confirmando_datos",
    );

    return "confirmando_datos";
  }

  return destino;
}

const MAX_TOOL_CALLS = 1;
/**
 * Deadline GLOBAL del paso completo (hasta 2 llamados a Claude comparten
 * este mismo AbortSignal, ver más abajo). Subido de 25s a 55s el
 * 2026-08-06 tras encontrar en la primera corrida real contra Anthropic
 * que 25s no alcanzaba — el combo `tools` + `cache_control` +
 * `output_config.format` en un request "frío" (sin cache hit todavía, el
 * primer llamado siempre escribe caché en vez de leerla) tardó más de eso.
 * No confirmado con precisión cuánto tarda en régimen (con cache hit) —
 * medir en producción una vez que haya tráfico real.
 */
const DEADLINE_MS = 55_000;

export interface LlamadoBase {
  apiKey: string;
  model?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
}

export interface PasoTurnosParams {
  llamado: LlamadoBase;
  catalogo: string;
  mensajePaciente: string;
  /** Turnos reales previos de ESTA conversación (mismo array que ya arma
   * `agent-client/index.ts::getRecentHistoryTurns()` para el redactor) —
   * el agente de turnos los necesita para no perder un dato que la paciente
   * dio en un mensaje anterior (ej. tratamiento y día en el mensaje 1, hora
   * y mail en el mensaje 2). Bug real encontrado 2026-08-08: antes de esto,
   * este paso arrancaba `messages` desde cero con SOLO el mensaje actual —
   * el redactor sí veía el historial completo (por eso clasificaba bien
   * `gestion_turno`), pero el paso que arma los argumentos de la tool
   * quedaba ciego a todo lo dicho antes en la misma conversación. */
  historial: GuardrailTurn[];
  historialTexto: string;
  turnosExistentes: TurnoEncontrado[];
  /** Escalón actual del agendamiento (v16) — decide qué tools se exponen. */
  subEstado: SubEstadoAgendamiento;
  datosGuardados: DatosContactoGuardados;
  /** Hook de observabilidad de costo (`guardrail/costos.ts`). */
  onLlamado?: (info: InfoLlamado) => void;
  tools: CalendlyTools;
  client: SupabaseClient;
  conversation: ConversationRow;
  contact?: ContactRow;
  incomingMessageId: string;
  /** Ancla de "ahora" para resolver fechas — opcional, para poder fijarla
   * en tests (golden set) y que la resolución sea determinística. Por
   * defecto, el instante real (`ejecutarPasoTurnos` la calcula una sola
   * vez y la reusa para todo el paso). */
  ahora?: Date;
}

export type ResultadoPasoTurnos =
  | {
    ok: true;
    mensaje: string;
    datosDetectados: SalidaAgenteTurnos["datos_detectados"];
    /** Fuente autorizada que se le pasa al juez (fuente (c) de su pregunta). */
    evidencia: string;
    /** Sub-estado ya validado al que hay que mover el flujo (v16). */
    subEstadoNuevo: SubEstadoAgendamiento;
  }
  | { ok: false; motivo: string };

/** Texto de turnos reales, reusado en el prompt del paso Y como evidencia
 * inicial para el juez — nunca inventado, siempre viene de Calendly. */
export function formatearTurnosTexto(turnos: TurnoEncontrado[]): string {
  if (!turnos.length) return "";

  return turnos
    .map((t) =>
      `- ${t.tipoTurno}, ${
        fechaConDiaSemana(t.fecha)
      } ${t.hora} (event_uuid=${t.eventUuid}). ` +
      `Cancelar: ${t.cancelUrl ?? "no disponible"}. Reprogramar: ${
        t.rescheduleUrl ?? "no disponible"
      }.`
    )
    .join("\n");
}

/** El par "pedido → turno real" citado explícitamente en la evidencia — así
 * la correspondencia entre lo que pidió la paciente y `tipoEvento` (nombre
 * interno de Calendly, casi siempre genérico) es un hecho literal que el
 * juez lee, no algo que tenga que inferir. Ver Incidente 9 (continuación)
 * en `P05_lecciones_guardrail.md`: sin esto, el juez rechazaba de forma
 * inconsistente cualquier tratamiento cuyo nombre no calzara palabra por
 * palabra con `tipoEvento`. */
function citaTratamiento(
  tratamientoSolicitado: string,
  tipoEvento: string,
): string {
  return `turno resuelto para '${tratamientoSolicitado}' (pedido por la paciente) → turno real en Calendly: '${tipoEvento}'`;
}

function formatearEvidenciaAgendado(
  resultado: ResultadoAgendar,
  emailUsado: string | null,
): string {
  if (resultado.agendado) {
    const mail = emailUsado ? ` Mail de confirmación: ${emailUsado}.` : "";
    const cita = citaTratamiento(
      resultado.tratamientoSolicitado,
      resultado.tipoEvento,
    );
    return `Turno recién agendado (${cita}): ${
      fechaConDiaSemana(resultado.fecha)
    } ${resultado.hora} (event_uuid=${resultado.eventUuid}).${mail}`;
  }

  if (resultado.motivo === "horario_no_disponible") {
    return `agendar_turno NO agendó (horario no disponible para '${resultado.tratamientoSolicitado}'). Horarios alternativos reales: ${
      resultado.horariosAlternativos.join(", ") || "ninguno"
    }.`;
  }

  if (resultado.motivo === "tipo_turno_ambiguo") {
    return `agendar_turno NO agendó (tipo de turno ambiguo): ${resultado.detalle}`;
  }

  return "agendar_turno NO agendó (falta el mail de la paciente).";
}

function formatearEvidenciaDisponibilidad(
  resultado: ResultadoDisponibilidad,
): string {
  if (resultado.disponible) {
    const cita = citaTratamiento(
      resultado.tratamientoSolicitado,
      resultado.tipoEvento,
    );
    return `Horarios libres reales (${cita}) el ${
      fechaConDiaSemana(resultado.fecha)
    }: ${resultado.horarios.join(", ")}.`;
  }

  if (resultado.motivo === "sin_horarios_ese_dia") {
    // ⚠️ Acá NO se cita el par "pedido → turno real" a propósito (v18).
    //
    // Esa cita la agregó v14 para que el juez no rechazara por diferencia de
    // NOMBRE entre el tratamiento que pidió la paciente y el `tipoEvento`
    // genérico de Calendly. Pero pegada a un "sin horarios libres" se leía al
    // revés: el juez veía "turno real en Calendly: 'botox'" y entendía que SÍ
    // había un turno ese día, así que rechazaba el borrador correcto ("no
    // tengo disponibilidad") por contradecir la evidencia — y el reescritor,
    // obedeciendo ese motivo, daba vuelta el mensaje e inventaba una seña.
    // Encontrado en la primera corrida del golden set contra v16.
    //
    // Es el mismo tipo de bug que los Incidentes 12 y 14: no era el modelo
    // razonando mal, era la evidencia diciendo algo distinto de lo que pasó.
    // En la rama SIN disponibilidad no hay ninguna correspondencia de nombre
    // que defender (no se va a nombrar ningún turno), así que la cita no
    // aporta nada y solo confunde.
    const base =
      `consultar_disponibilidad: NO hay NINGÚN horario libre para '${resultado.tratamientoSolicitado}' el ${
        fechaConDiaSemana(resultado.fecha)
      }. Ese día está SIN LUGAR: decir que hay disponibilidad ese día sería inventarlo.`;

    if (!resultado.alternativa) {
      return `${base} No hay disponibilidad tampoco en los próximos días — no menciones ningún día ni fecha como alternativa; si querés, podés preguntarle a la paciente si quiere que consultes otro día, sin nombrar cuál.`;
    }

    return `${base} Alternativa real más cercana: ${
      fechaConDiaSemana(resultado.alternativa.fecha)
    }, horarios ${resultado.alternativa.horarios.join(", ")}.`;
  }

  return `consultar_disponibilidad: tipo de turno ambiguo — ${resultado.detalle}`;
}

/** Evidencia mínima de que el DÍA que el modelo clasificó no es una
 * alucinación — busca la palabra que lo respalda (el nombre del día de
 * semana, "hoy"/"mañana"/"pasado mañana", o simplemente confía en
 * `fecha_explicita` porque esa SÍ es literalmente lo que escribió la
 * paciente, no algo que el modelo haya calculado). Heurística barata, NO
 * una verificación semántica real — el freno de fondo sigue siendo que el
 * prompt le exige al modelo confirmar antes de llamar a la tool. */
function evidenciaDiaEncontrada(
  expr: ExpresionFecha,
  textoConversacionNormalizado: string,
): boolean {
  switch (expr.tipo) {
    case "hoy":
      return textoConversacionNormalizado.includes("hoy");
    case "manana":
      return textoConversacionNormalizado.includes("manana");
    case "pasado_manana":
      return textoConversacionNormalizado.includes("pasado manana");
    case "dia_semana":
      return textoConversacionNormalizado.includes(expr.dia_semana);
    case "fecha_explicita":
      // Es literalmente lo que la paciente escribió (ver el input_schema),
      // no un cálculo del modelo — no hace falta re-buscarla en el texto.
      return true;
  }
}

/**
 * Gates de código antes de ejecutar `agendar_turno` de verdad — defensa en
 * profundidad, no reemplaza el criterio del modelo (ya instruido en el
 * prompt a confirmar el día/hora antes de llamar a la tool). Cualquier gate
 * que falle → NO se ejecuta, se registra como `bloqueado` en
 * `turno_acciones`, fail-closed.
 */
function validarGateAgendar(
  args: Record<string, unknown>,
  textoConversacion: string,
  ahora: Date,
): { ok: true; fechaHoraDeseada: string } | { ok: false; motivo: string } {
  const expr = args.fecha as ExpresionFecha | undefined;

  if (!expr || typeof expr.tipo !== "string") {
    return { ok: false, motivo: "falta 'fecha' en los argumentos de la tool" };
  }

  const resuelta = resolverFechaExpresion(expr, ahora);

  if (!resuelta.ok) {
    return { ok: false, motivo: `fecha no resuelta: ${resuelta.motivo}` };
  }

  const hora = typeof args.hora === "string" ? args.hora : "";

  if (!validarHoraHHMM(hora)) {
    return {
      ok: false,
      motivo: `'hora' no tiene formato HH:MM reconocible: ${
        JSON.stringify(hora)
      }`,
    };
  }

  const fechaHoraDeseada = `${resuelta.fechaISO}T${hora}:00-03:00`;
  const fecha = new Date(fechaHoraDeseada);

  if (fecha.getTime() <= ahora.getTime()) {
    return { ok: false, motivo: "la fecha resuelta no está en el futuro" };
  }

  const email = typeof args.email === "string" ? args.email.trim() : "";

  if (!email || !email.includes("@")) {
    return {
      ok: false,
      motivo: "falta un email válido en los argumentos de la tool",
    };
  }

  const nombre = typeof args.nombre === "string" ? args.nombre.trim() : "";

  if (!nombre) {
    return {
      ok: false,
      motivo: "falta el nombre en los argumentos de la tool",
    };
  }

  const tratamiento = typeof args.tratamiento_o_tipo_turno === "string"
    ? args.tratamiento_o_tipo_turno.trim()
    : "";

  if (!tratamiento) {
    return {
      ok: false,
      motivo: "falta tratamiento_o_tipo_turno en los argumentos de la tool",
    };
  }

  // Evidencia de día Y hora (antes solo exigía UNO de los dos — endurecido
  // 2026-08-08: con el día ahora siendo un nombre de día de semana en vez
  // de un número, exigir solo la hora dejaba pasar cualquier día siempre
  // que la hora coincidiera).
  const textoNormalizado = normalizarTexto(textoConversacion);
  const horaNum = String(Number(hora.slice(0, 2)));

  if (!evidenciaDiaEncontrada(expr, textoNormalizado)) {
    return {
      ok: false,
      motivo: `no se encontró evidencia del día (${
        JSON.stringify(expr)
      }) en la conversación — posible fecha inventada`,
    };
  }

  if (
    !textoNormalizado.includes(hora.slice(0, 2)) &&
    !textoNormalizado.includes(horaNum)
  ) {
    return {
      ok: false,
      motivo:
        `no se encontró evidencia de la hora ('${hora}') en la conversación — posible hora inventada`,
    };
  }

  return { ok: true, fechaHoraDeseada };
}

async function registrarIntento(
  client: SupabaseClient,
  conversation: ConversationRow,
  incomingMessageId: string,
  args: unknown,
): Promise<{ insertado: true; id: number } | { insertado: false }> {
  const { data, error } = await client
    .from("turno_acciones")
    .insert({
      organization_id: conversation.organization_id,
      conversation_id: conversation.id,
      contact_address: conversation.contact_address,
      incoming_message_id: incomingMessageId,
      tool: "agendar_turno",
      args,
      estado: "intentado",
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      log.warn(
        "Paso de turnos — agendar_turno ya intentado para este mensaje entrante (idempotencia)",
        { incomingMessageId },
      );
    } else {
      log.error(
        "Paso de turnos — no se pudo registrar el intento en turno_acciones",
        error,
      );
    }

    return { insertado: false };
  }

  return { insertado: true, id: data.id };
}

async function actualizarAccionTurno(
  client: SupabaseClient,
  id: number,
  estado: "ok" | "error",
  resultado: unknown,
): Promise<void> {
  const { error } = await client
    .from("turno_acciones")
    .update({ estado, resultado })
    .eq("id", id);

  if (error) {
    log.error("Paso de turnos — no se pudo actualizar turno_acciones", error);
  }
}

async function registrarBloqueado(
  client: SupabaseClient,
  conversation: ConversationRow,
  incomingMessageId: string,
  args: unknown,
  motivo: string,
): Promise<void> {
  const { error } = await client.from("turno_acciones").insert({
    organization_id: conversation.organization_id,
    conversation_id: conversation.id,
    contact_address: conversation.contact_address,
    incoming_message_id: incomingMessageId,
    tool: "agendar_turno",
    args,
    estado: "bloqueado",
    resultado: { motivo },
  });

  if (error && error.code !== "23505") {
    log.error(
      "Paso de turnos — no se pudo registrar la acción bloqueada",
      error,
    );
  }
}

/** Ejecuta `agendar_turno` de verdad (con sus gates + idempotencia) y
 * actualiza `messages` con el ida-y-vuelta real de tool_use/tool_result. */
async function ejecutarToolAgendar(
  params: PasoTurnosParams,
  toolUseId: string,
  toolInput: unknown,
  historialTexto: string,
  messages: GuardrailTurn[],
  ahora: Date,
): Promise<
  { ok: true; evidencia: string; agendado: boolean } | {
    ok: false;
    motivo: string;
  }
> {
  const { client, conversation, incomingMessageId, mensajePaciente, tools } =
    params;

  const args = (toolInput ?? {}) as Record<string, unknown>;
  const textoConversacion = `${historialTexto}\n${mensajePaciente}`;

  const gate = validarGateAgendar(args, textoConversacion, ahora);

  if (!gate.ok) {
    log.warn("Paso de turnos — agendar_turno bloqueado por gate de seguridad", {
      motivo: gate.motivo,
    });

    await registrarBloqueado(
      client,
      conversation,
      incomingMessageId,
      args,
      gate.motivo,
    );

    return {
      ok: false,
      motivo: `agendar bloqueado por gate de seguridad: ${gate.motivo}`,
    };
  }

  const agendarArgs: AgendarArgs = {
    tratamientoOTipoTurno: String(args.tratamiento_o_tipo_turno ?? ""),
    fechaHoraDeseada: gate.fechaHoraDeseada,
    nombre: String(args.nombre ?? ""),
    // NUNCA del modelo — el teléfono real de la conversación, siempre.
    telefono: conversation.contact_address ?? "",
    email: typeof args.email === "string" ? args.email : null,
  };

  const intento = await registrarIntento(
    client,
    conversation,
    incomingMessageId,
    agendarArgs,
  );

  if (!intento.insertado) {
    return {
      ok: false,
      motivo:
        "acción ya intentada para este mensaje (idempotencia) o error al registrar",
    };
  }

  let resultado: ResultadoAgendar;

  try {
    resultado = await tools.agendarTurno(agendarArgs);
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);

    log.error("Paso de turnos — error ejecutando agendar_turno", detalle);

    await actualizarAccionTurno(client, intento.id, "error", {
      error: detalle,
    });

    return { ok: false, motivo: `error ejecutando agendar_turno: ${detalle}` };
  }

  await actualizarAccionTurno(
    client,
    intento.id,
    resultado.agendado ? "ok" : "error",
    resultado,
  );

  messages.push({
    role: "assistant",
    content: [{
      type: "tool_use",
      id: toolUseId,
      name: "agendar_turno",
      input: toolInput,
    }],
  });
  messages.push({
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolUseId,
      content: toolResultAgenteTurnos(resultado),
    }],
  });

  return {
    ok: true,
    evidencia: formatearEvidenciaAgendado(resultado, agendarArgs.email),
    // La ÚNICA fuente de verdad para pasar al sub-estado `agendado`.
    agendado: resultado.agendado === true,
  };
}

/** `consultar_disponibilidad` es de solo lectura — sin gate de seguridad ni
 * logueo en `turno_acciones` (esa tabla es de ACCIONES, no de lecturas;
 * mismo criterio que `consultarTurno`, que tampoco se loguea ahí). */
async function ejecutarToolConsultarDisponibilidad(
  params: PasoTurnosParams,
  toolUseId: string,
  toolInput: unknown,
  messages: GuardrailTurn[],
  ahora: Date,
): Promise<
  { ok: true; evidencia: string; agendado: boolean } | {
    ok: false;
    motivo: string;
  }
> {
  const { tools } = params;
  const args = (toolInput ?? {}) as Record<string, unknown>;

  const tratamiento = typeof args.tratamiento_o_tipo_turno === "string"
    ? args.tratamiento_o_tipo_turno
    : "";
  const expr = args.fecha as ExpresionFecha | undefined;

  if (!tratamiento || !expr || typeof expr.tipo !== "string") {
    return {
      ok: false,
      motivo:
        "consultar_disponibilidad: faltan argumentos (tratamiento_o_tipo_turno o fecha)",
    };
  }

  const resuelta = resolverFechaExpresion(expr, ahora);

  if (!resuelta.ok) {
    return {
      ok: false,
      motivo: `consultar_disponibilidad: fecha no resuelta: ${resuelta.motivo}`,
    };
  }

  let resultado: ResultadoDisponibilidad;

  try {
    resultado = await tools.consultarDisponibilidad(
      tratamiento,
      resuelta.fechaISO,
    );
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);

    log.error(
      "Paso de turnos — error ejecutando consultar_disponibilidad",
      detalle,
    );

    return {
      ok: false,
      motivo: `error ejecutando consultar_disponibilidad: ${detalle}`,
    };
  }

  messages.push({
    role: "assistant",
    content: [{
      type: "tool_use",
      id: toolUseId,
      name: "consultar_disponibilidad",
      input: toolInput,
    }],
  });
  messages.push({
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolUseId,
      content: toolResultAgenteTurnos(resultado),
    }],
  });

  return {
    ok: true,
    evidencia: formatearEvidenciaDisponibilidad(resultado),
    agendado: false,
  };
}

export async function ejecutarPasoTurnos(
  params: PasoTurnosParams,
): Promise<ResultadoPasoTurnos> {
  const {
    llamado,
    catalogo,
    mensajePaciente,
    historial,
    historialTexto,
    turnosExistentes,
    subEstado,
    datosGuardados,
  } = params;

  // Calculada UNA sola vez y reusada para todo el paso (texto que ve el
  // modelo + resolución real de `fecha`) — evita una carrera de reloj entre
  // lo que el modelo lee y lo que el código resuelve. `params.ahora`
  // permite fijarla en tests (golden set).
  const ahora = params.ahora ?? new Date();

  const turnosRealesTexto = formatearTurnosTexto(turnosExistentes);
  const deadline = AbortSignal.timeout(DEADLINE_MS);

  const system = [
    systemAgenteTurnosEstatico(catalogo),
    contextoAgenteTurnos(
      turnosRealesTexto,
      subEstado,
      datosGuardados,
      fechaActualLegible(ahora),
    ),
  ];

  const messages: GuardrailTurn[] = agregarTurnoFinal(historial, {
    role: "user",
    content: userAgenteTurnos(mensajePaciente),
  });

  let evidencia = turnosRealesTexto;
  let llamadosATool = 0;
  // Solo se pone en true cuando Calendly confirmó un turno nuevo de verdad —
  // es la ÚNICA forma de llegar al sub-estado `agendado`.
  let agendoDeVerdad = false;

  // Como mucho MAX_TOOL_CALLS + 1 llamados a Claude: el primero, y uno más
  // por cada ejecución real de tool (acá, como mucho una).
  for (let vuelta = 0; vuelta <= MAX_TOOL_CALLS; vuelta++) {
    let respuesta;

    try {
      respuesta = await callStructured<SalidaAgenteTurnos>({
        apiKey: llamado.apiKey,
        model: llamado.model,
        headers: llamado.headers,
        maxTokens: llamado.maxTokens ?? 1024,
        signal: deadline,
        system,
        messages,
        schema: SCHEMA_AGENTE_TURNOS,
        // GATE DE CÓDIGO: `agendar_turno` ni siquiera viaja en el request si
        // el sub-estado no es `lista_para_agendar`.
        tools: toolsParaSubEstado(subEstado),
        onLlamado: params.onLlamado,
      });
    } catch (error) {
      const detalle = error instanceof GuardrailLLMError
        ? error.message
        : String(error);

      log.error("Paso de turnos — falló el llamado a Claude", detalle);

      return {
        ok: false,
        motivo: `error técnico en el paso de turnos: ${detalle}`,
      };
    }

    if (respuesta.kind === "texto") {
      // Los datos que valen para el gate son los ya guardados MÁS los que la
      // paciente acaba de dar en este mensaje — si no, un turno nunca podría
      // avanzar a `lista_para_agendar` en el mismo mensaje en que da el mail.
      const datosEfectivos = {
        email: respuesta.data.datos_detectados?.email?.trim() ||
          datosGuardados.email,
        nombreCompleto: respuesta.data.datos_detectados?.nombre_completo
          ?.trim() || datosGuardados.nombreCompleto,
      };

      return {
        ok: true,
        mensaje: respuesta.data.mensaje,
        datosDetectados: respuesta.data.datos_detectados,
        evidencia,
        subEstadoNuevo: proximoSubEstado(
          subEstado,
          respuesta.data.avanzar_a,
          datosEfectivos,
          agendoDeVerdad,
        ),
      };
    }

    // respuesta.kind === "tool_use"
    llamadosATool++;

    if (llamadosATool > MAX_TOOL_CALLS) {
      log.error(
        "Paso de turnos — el modelo pidió otra tool después de ya haber ejecutado una, ABORT fail-closed",
        { name: respuesta.name },
      );

      return {
        ok: false,
        motivo: "más de un llamado a tool en el mismo mensaje — fail-closed",
      };
    }

    let ejecucion: { ok: true; evidencia: string; agendado: boolean } | {
      ok: false;
      motivo: string;
    };

    if (respuesta.name === "agendar_turno") {
      // No debería pasar nunca (la tool no se expone fuera de
      // `lista_para_agendar`), pero si pasa es fail-closed, no un warning.
      if (subEstado !== "lista_para_agendar") {
        log.error(
          "Paso de turnos — el modelo pidió agendar_turno con la tool NO expuesta, ABORT fail-closed",
          { subEstado },
        );

        return {
          ok: false,
          motivo:
            `agendar_turno pedida en sub-estado '${subEstado}' (la tool no estaba expuesta) — fail-closed`,
        };
      }

      ejecucion = await ejecutarToolAgendar(
        params,
        respuesta.id,
        respuesta.input,
        historialTexto,
        messages,
        ahora,
      );
    } else if (respuesta.name === "consultar_disponibilidad") {
      ejecucion = await ejecutarToolConsultarDisponibilidad(
        params,
        respuesta.id,
        respuesta.input,
        messages,
        ahora,
      );
    } else {
      return {
        ok: false,
        motivo: `tool desconocida pedida por el modelo: ${respuesta.name}`,
      };
    }

    if (!ejecucion.ok) {
      return { ok: false, motivo: ejecucion.motivo };
    }

    if (ejecucion.agendado) agendoDeVerdad = true;

    evidencia = [turnosRealesTexto, ejecucion.evidencia].filter(Boolean).join(
      "\n\n",
    );
    // Sigue el loop: la próxima vuelta hace el llamado post-tool, que tiene
    // que devolver texto (si pide otra tool, se aborta arriba).
  }

  // Inalcanzable en la práctica (MAX_TOOL_CALLS + 1 vueltas siempre
  // retornan o abortan adentro del for) — fail-closed explícito por las
  // dudas, nunca "mandar algo" por default.
  return {
    ok: false,
    motivo: "el paso de turnos no terminó en una respuesta de texto",
  };
}
