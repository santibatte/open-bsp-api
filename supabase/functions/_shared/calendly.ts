/**
 * Tools de turnos (Calendly) — port TypeScript/Deno del contrato validado en
 * `consultorio_dermatologico/recordatorios-cron/api/lib/calendly_tools.py`
 * (probado en vivo 2026-08-05: turno real creado y cancelado con éxito).
 *
 * Por qué este runtime y no el Python original: ver
 * `proyectos/P05_plan_tools_turnos.md` (repo `consultorio_dermatologico`),
 * sección 2.4 — el agente que decide llamar a estas tools corre en Supabase
 * Edge Functions (Deno), no en Vercel. Ejecutarlas en el mismo runtime evita
 * un salto de red extra en el camino crítico de una respuesta de WhatsApp, y
 * ya hay precedente de pegarle directo a la API de Calendly desde acá
 * (`agent-client/recordatorio-buttons.ts::manejarCancelar`).
 *
 * `calendly_tools.py` queda como implementación de referencia — documenta el
 * contrato real de la API de Calendly (ganado a pulso, ver su docstring) pero
 * ya no es el código que se ejecuta en producción para este flujo.
 *
 * **Excluida explícitamente la Dra. Ana Cardozo** (decisión de Santi,
 * 2026-08-06): el bot no le agenda turnos a ella. `listarTiposTurnoActivos`
 * filtra cualquier event type que la mencione, antes de que
 * `resolverTipoTurno` pueda matchear contra él.
 */
import { normalizarTelefono } from "./telefonos.ts";

const CALENDLY_API_BASE = "https://api.calendly.com";
const TZ = "America/Argentina/Buenos_Aires";

/** Nombres de event type a excluir siempre — nunca se le ofrecen al modelo. */
const DOCTORAS_EXCLUIDAS = ["ana cardozo"];

export class CalendlyError extends Error {}

// ─────────────────────────────────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────────────────────────────────

export interface TurnoEncontrado {
  eventUuid: string;
  inviteeUuid: string;
  nombreInvitado: string;
  tipoTurno: string;
  /** dd/mm/aaaa, hora local de Buenos Aires. */
  fecha: string;
  /** HH:MM, hora local de Buenos Aires. */
  hora: string;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
}

export interface ConsultaTurnos {
  telefonoBuscado: string;
  cantidad: number;
  turnos: TurnoEncontrado[];
  /** true si el resultado incluye turnos que solo se encontraron buscando
   * por mail (no por teléfono) — Fix agregado 2026-08-09, ver
   * `PLAN_FIX_BIENVENIDA_CONTEXTO.md`. Útil para que el prompt sepa que
   * encontró algo por una vía secundaria, no la principal. */
  encontradoPorMail?: boolean;
}

export interface AgendarArgs {
  tratamientoOTipoTurno: string;
  /** ISO 8601 con offset, ej. "2026-08-13T11:00:00-03:00". */
  fechaHoraDeseada: string;
  nombre: string;
  telefono: string;
  email: string | null;
}

export type ResultadoAgendar =
  | {
    agendado: true;
    eventUuid: string;
    fecha: string;
    hora: string;
    tipoEvento: string;
    /** El texto CRUDO que pidió la paciente (`tratamiento_o_tipo_turno`,
     * antes de resolver), para que el juez vea la correspondencia entre lo
     * pedido y `tipoEvento` como un hecho literal en la evidencia — nunca
     * algo que tenga que inferir. Ver Incidente 9 (continuación) en
     * `P05_lecciones_guardrail.md`: sin esto, cualquier tratamiento cuyo
     * nombre no coincida palabra por palabra con `tipoEvento` (la mayoría —
     * comparten el turno genérico de consulta) generaba rechazos
     * inconsistentes del juez. */
    tratamientoSolicitado: string;
  }
  | { agendado: false; motivo: "falta_email" }
  | { agendado: false; motivo: "tipo_turno_ambiguo"; detalle: string }
  | {
    agendado: false;
    motivo: "horario_no_disponible";
    horariosAlternativos: string[];
    tratamientoSolicitado: string;
  };

export type ResultadoDisponibilidad =
  | {
    disponible: true;
    tipoEvento: string;
    fecha: string;
    horarios: string[];
    tratamientoSolicitado: string;
  }
  | { disponible: false; motivo: "tipo_turno_ambiguo"; detalle: string }
  | {
    disponible: false;
    motivo: "sin_horarios_ese_dia";
    tipoEvento: string;
    fecha: string;
    tratamientoSolicitado: string;
    /** Día más cercano con disponibilidad REAL, buscando hacia DELANTE
     * desde el día pedido (segunda consulta real a Calendly, nunca
     * inventado) — `null` si tampoco hay nada en los próximos días.
     * Agregada 2026-08-07, pedido explícito de Santi: antes de esto, si no
     * había lugar el día pedido, el prompt le prohibía al modelo ofrecer
     * cualquier alternativa porque no había datos reales para respaldarla. */
    alternativaDespues: { fecha: string; horarios: string[] } | null;
    /** Día más cercano con disponibilidad REAL, buscando hacia ATRÁS desde
     * el día pedido, nunca antes de hoy (tercera consulta real a Calendly)
     * — `null` si no hay nada entre hoy y el día pedido. Agregada
     * 2026-08-08 (Incidente real: Santi pidió el 21/08, no había lugar, se
     * le ofreció el 2/09, y al preguntar "¿y antes no tenés?" el bot no
     * tenía forma de buscar hacia atrás — la búsqueda de alternativa era
     * siempre unidireccional). `consultar_disponibilidad` es código
     * nuestro, no una limitación de Calendly — no hay motivo para no
     * buscar en las dos direcciones desde el vamos. */
    alternativaAntes: { fecha: string; horarios: string[] } | null;
  };

export interface OpcionDisponible {
  fecha: string;
  horarios: string[];
}

export type ResultadoDisponibilidadRango =
  | {
    disponible: true;
    tipoEvento: string;
    tratamientoSolicitado: string;
    /** Hasta `MAX_OPCIONES_RANGO` días distintos del rango con al menos un
     * horario libre (filtrado por franja horaria, si se pidió), ordenados
     * cronológicamente — nunca todos los días del rango, para no saturar el
     * mensaje. */
    opciones: OpcionDisponible[];
  }
  | { disponible: false; motivo: "tipo_turno_ambiguo"; detalle: string }
  | {
    disponible: false;
    motivo: "sin_horarios_en_rango";
    tipoEvento: string;
    tratamientoSolicitado: string;
    fechaInicio: string;
    fechaFin: string;
    /** Mismo criterio que `ResultadoDisponibilidad`: alternativa real más
     * cercana en cada dirección, buscando desde los bordes del rango
     * consultado — `null` si no hay nada en esa dirección. */
    alternativaAntes: OpcionDisponible | null;
    alternativaDespues: OpcionDisponible | null;
  };

export interface CalendlyTools {
  /**
   * `emailFallback` (2026-08-09): si la búsqueda por teléfono no encuentra
   * nada Y se pasa un mail, también busca por mail antes de concluir que no
   * hay turnos — cubre el caso real de una paciente que agendó con un
   * número distinto al que usa ahora para escribir. Nunca al revés (nunca
   * se ignora un match real de teléfono).
   */
  consultarTurno(
    telefono: string,
    diasAdelante?: number,
    emailFallback?: string | null,
  ): Promise<ConsultaTurnos>;
  /**
   * Solo lectura — horarios libres de UN día para un tratamiento, sin
   * intentar agendar nada. Pensada para "¿hay lugar el miércoles?" (día
   * dado, sin hora puntual todavía) — ver
   * `proyectos/P05_plan_tools_turnos.md` sección "consultar_disponibilidad"
   * (agregada 2026-08-06, pedido explícito de Santi).
   */
  consultarDisponibilidad(
    tratamientoOTipoTurno: string,
    fechaDeseada: string,
    /** Día calendario de HOY en Buenos Aires ("YYYY-MM-DD") — nunca se
     * busca una alternativa "antes" anterior a este día, no tiene sentido
     * ofrecer un turno en el pasado. */
    hoyISO: string,
  ): Promise<ResultadoDisponibilidad>;
  /**
   * Solo lectura — como `consultarDisponibilidad` pero para un RANGO de
   * días (ej. "la semana que viene") en vez de uno solo, con filtro
   * opcional por franja horaria. Agregada 2026-08-08: un pedido vago pero
   * ACOTADO ("la semana que viene, cualquier tarde") tiene señal real
   * suficiente para buscar disponibilidad de verdad — no hace falta
   * degradar al link genérico solo porque no hay un día puntual.
   */
  consultarDisponibilidadRango(
    tratamientoOTipoTurno: string,
    fechaInicioISO: string,
    fechaFinISO: string,
    franja: "manana" | "tarde" | null,
    hoyISO: string,
  ): Promise<ResultadoDisponibilidadRango>;
  agendarTurno(args: AgendarArgs): Promise<ResultadoAgendar>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers de fecha/hora — Argentina no tiene horario de verano desde 2009
// (offset fijo -03:00), así que no hace falta una librería de timezone: con
// Intl.DateTimeFormat (Deno trae la base ICU completa) alcanza.
// ─────────────────────────────────────────────────────────────────────────

function formatearFechaHoraLocal(iso: string): { fecha: string; hora: string } {
  const d = new Date(iso);
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("es-AR", {
      timeZone: TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );

  return {
    fecha: `${partes.day}/${partes.month}/${partes.year}`,
    hora: `${partes.hour}:${partes.minute}`,
  };
}

/** YYYY-MM-DD del día calendario en Buenos Aires que contiene el instante `d`. */
export function fechaLocalISO(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * "YYYY-MM-DD" → "DD/MM/YYYY", por manipulación de string pura — nunca pasar
 * por `new Date()` para esto. `new Date("2026-08-12")` lo interpreta como
 * medianoche UTC, y convertir eso a hora de Buenos Aires (-03:00) para
 * "saber qué día es" corre el día para atrás (medianoche UTC del 12 son las
 * 21:00 del 11 en Buenos Aires) — bug real encontrado 2026-08-07: 5 turnos
 * reales rechazados por el juez porque la "evidencia" decía siempre un día
 * antes de lo que el texto (correcto) del modelo afirmaba. `fechaDeseada`
 * YA es un día calendario de Buenos Aires (el que pidió la paciente) — no
 * hace falta (ni es seguro) reinterpretarlo como instante UTC.
 */
export function formatearFechaCalendarioDMY(diaLocalISO: string): string {
  const [anio, mes, dia] = diaLocalISO.split("-");
  return `${dia}/${mes}/${anio}`;
}

/**
 * Día de la semana (en español) de una fecha YA resuelta en formato
 * "DD/MM/YYYY" — para que la evidencia de turnos SIEMPRE incluya el día de
 * semana ya calculado por código, nunca algo que el modelo tenga que
 * nombrar por su cuenta. Un LLM no tiene forma confiable de calcular qué
 * día de la semana es una fecha (es predicción de texto, no aritmética —
 * cada día de semana le "pesa" ~1/7 sin importar la fecha real) — bug real
 * encontrado 2026-08-08: el modelo describió el 19/08/2026 (miércoles)
 * como "lunes". Mediodía (`T12:00:00`) evita cualquier ambigüedad de borde
 * de día, aunque con offset fijo -03:00 no debería hacer falta.
 */
export function diaSemanaDeFechaDMY(fechaDMY: string): string {
  const [dia, mes, anio] = fechaDMY.split("/");
  const d = new Date(`${anio}-${mes}-${dia}T12:00:00-03:00`);
  return new Intl.DateTimeFormat("es-AR", { timeZone: TZ, weekday: "long" })
    .format(d);
}

/** "DD/MM/YYYY" → "miércoles 19/08/2026" — para citar en la evidencia de
 * turnos, ver `diaSemanaDeFechaDMY`. */
export function fechaConDiaSemana(fechaDMY: string): string {
  return `${diaSemanaDeFechaDMY(fechaDMY)} ${fechaDMY}`;
}

/**
 * Fecha y hora actual, en texto, hora de Buenos Aires — contexto general
 * para el modelo (para que sepa qué día es hoy si la paciente pregunta, o
 * para desambiguar semánticamente "el miércoles" vs "la semana que viene").
 * Ya NO es la única defensa contra el cálculo de fechas — desde 2026-08-08
 * el modelo no calcula ninguna fecha ISO ni día de semana por su cuenta
 * (ver `_shared/fechas.ts`: `resolverFechaExpresion` lo hace en código,
 * siempre). `ahora` opcional para poder fijar un ancla determinística en
 * tests (golden set) — por defecto, el instante real.
 */
export function fechaActualLegible(ahora: Date = new Date()): string {
  const texto = new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ahora);

  return `${texto} (hora de Buenos Aires)`;
}

// ─────────────────────────────────────────────────────────────────────────
// Cliente HTTP — timeout por request + señal externa opcional (deadline del
// paso de turnos completo, ver guardrail/turnos.ts).
// ─────────────────────────────────────────────────────────────────────────

interface ClienteOpts {
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function calendlyFetch(
  path: string,
  opts: ClienteOpts,
  init: RequestInit = {},
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const url = path.startsWith("http") ? path : `${CALENDLY_API_BASE}${path}`;

  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      signal,
      headers: {
        "Authorization": `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new CalendlyError(
      `Fallo de red llamando a Calendly (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return response;
}

async function calendlyGetJson<T>(path: string, opts: ClienteOpts): Promise<T> {
  const r = await calendlyFetch(path, opts);

  if (!r.ok) {
    throw new CalendlyError(
      `Calendly devolvió ${r.status} en GET ${path}: ${await r.text()}`,
    );
  }

  return r.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────
// user_uri — cacheado en memoria del módulo, igual que `_user_uri_cache` en
// el Python.
// ─────────────────────────────────────────────────────────────────────────

let userUriCache: string | null = null;

async function userUri(opts: ClienteOpts): Promise<string> {
  if (userUriCache) return userUriCache;

  const data = await calendlyGetJson<{ resource: { uri: string } }>(
    "/users/me",
    opts,
  );

  userUriCache = data.resource.uri;

  return userUriCache;
}

// ─────────────────────────────────────────────────────────────────────────
// Event types activos — resuelto en vivo en cada llamada, nunca contra una
// lista fija (ver el docstring de `calendly_tools.py`: la real cambia mes a
// mes, sobre todo Luz Pulsada y las campañas tipo Botox Party).
// ─────────────────────────────────────────────────────────────────────────

interface EventTypeActivo {
  nombre: string;
  uri: string;
  duracionMin: number;
}

interface EventTypeApiRow {
  name: string;
  uri: string;
  duration: number;
}

async function listarTiposTurnoActivos(
  opts: ClienteOpts,
): Promise<EventTypeActivo[]> {
  const uri = await userUri(opts);
  const params = new URLSearchParams({
    user: uri,
    active: "true",
    count: "100",
  });

  const data = await calendlyGetJson<{ collection: EventTypeApiRow[] }>(
    `/event_types?${params}`,
    opts,
  );

  return data.collection
    .filter((et) => {
      const n = et.name.toLowerCase();
      return !DOCTORAS_EXCLUIDAS.some((excluida) => n.includes(excluida));
    })
    .map((et) => ({ nombre: et.name, uri: et.uri, duracionMin: et.duration }));
}

/** Etiqueta legible — no se usa para matchear, solo para mostrar. */
function categorizarTurno(nombreEvento: string): string {
  const n = nombreEvento.toLowerCase();

  if (n.includes("luz pulsada") || n.includes("ipl") || n.includes("nir")) {
    return "Luz Pulsada Intensa (IPL/NIR)";
  }
  if (n.includes("bioestimul")) return "Bioestimulación";
  if (n.includes("botox party")) return "Botox Party";

  return nombreEvento;
}

/**
 * Matchea texto libre contra los event types REALES y activos (ya sin la
 * Dra. Ana Cardozo). Nunca elige por su cuenta entre varios candidatos —
 * devuelve el único match, o el detalle del problema para que el caller lo
 * traduzca a `motivo: "tipo_turno_ambiguo"` (mismo string que usa el Python
 * para ambos casos: cero candidatos y más de uno).
 */
async function resolverTipoTurno(
  tratamientoOTipo: string,
  opts: ClienteOpts,
): Promise<
  { ok: true; tipo: EventTypeActivo } | { ok: false; detalle: string }
> {
  const t = tratamientoOTipo.toLowerCase();
  const activos = await listarTiposTurnoActivos(opts);

  let candidatos: EventTypeActivo[];

  if (t.includes("ipl") || t.includes("nir") || t.includes("luz pulsada")) {
    candidatos = activos.filter((e) =>
      e.nombre.toLowerCase().includes("luz pulsada")
    );
  } else if (
    t.includes("bioestimul") || t.includes("harmonyca") ||
    t.includes("radiesse") || t.includes("skinvive")
  ) {
    candidatos = activos.filter((e) =>
      e.nombre.toLowerCase().includes("bioestimul")
    );
  } else if (t.includes("botox party")) {
    candidatos = activos.filter((e) =>
      e.nombre.toLowerCase().includes("botox party")
    );
  } else {
    candidatos = activos.filter((e) =>
      e.nombre.toLowerCase().includes("dermatolog")
    );
  }

  if (candidatos.length === 0) {
    return {
      ok: false,
      detalle:
        `No hay ningún turno activo en Calendly que matchee '${tratamientoOTipo}'. ` +
        `Turnos activos ahora: ${activos.map((e) => e.nombre).join(", ")}`,
    };
  }

  if (candidatos.length > 1) {
    return {
      ok: false,
      detalle:
        `Más de un turno activo matchea '${tratamientoOTipo}' — hay que aclarar cuál ` +
        `(ej. qué mes, o con qué doctora): ${
          candidatos.map((e) => e.nombre).join(", ")
        }`,
    };
  }

  return { ok: true, tipo: candidatos[0] };
}

// ─────────────────────────────────────────────────────────────────────────
// TOOL — consultar_turno (corre en código, nunca como tool del modelo — ver
// P05_plan_tools_turnos.md sección 2.2: el teléfono ya lo tiene el código con
// certeza, no hace falta que el modelo lo pida ni lo tipee).
// ─────────────────────────────────────────────────────────────────────────

interface ScheduledEventApiRow {
  uri: string;
  name: string;
  start_time: string;
}

interface InviteeApiRow {
  uri: string;
  name?: string;
  /** Campo nativo del invitee de Calendly (siempre lo pide para agendar) —
   * no confundir con una `questions_and_answers` custom de mail. */
  email?: string;
  cancel_url?: string;
  reschedule_url?: string;
  questions_and_answers?: { question?: string; answer?: string }[];
}

function extraerTelefonoDeRespuestas(
  qas: InviteeApiRow["questions_and_answers"],
): string | null {
  const claves = ["whatsapp", "teléfono", "telefono", "celular", "phone"];

  for (const qa of qas ?? []) {
    const pregunta = (qa.question ?? "").toLowerCase();

    if (claves.some((k) => pregunta.includes(k))) {
      return qa.answer ?? null;
    }
  }

  return null;
}

async function listarScheduledEvents(
  minStartIso: string,
  maxStartIso: string,
  opts: ClienteOpts,
): Promise<ScheduledEventApiRow[]> {
  const uri = await userUri(opts);
  const eventos: ScheduledEventApiRow[] = [];

  let url: string | null = `/scheduled_events?${new URLSearchParams({
    user: uri,
    min_start_time: minStartIso,
    max_start_time: maxStartIso,
    status: "active",
    count: "100",
  })}`;

  while (url) {
    const data: {
      collection: ScheduledEventApiRow[];
      pagination: { next_page?: string };
    } = await calendlyGetJson(url, opts);

    eventos.push(...data.collection);
    url = data.pagination.next_page ?? null;
  }

  return eventos;
}

/** Recorre `eventos` (ya traídos) y arma los `TurnoEncontrado` cuyos
 * invitees matchean `coincide`. Factorizado para no pedirle a Calendly la
 * misma lista de eventos dos veces cuando `consultarTurno` cae al fallback
 * de mail (ver más abajo). */
async function buscarTurnosEnEventos(
  eventos: ScheduledEventApiRow[],
  opts: ClienteOpts,
  coincide: (inv: InviteeApiRow) => boolean,
): Promise<TurnoEncontrado[]> {
  const resultado: TurnoEncontrado[] = [];

  for (const evento of eventos) {
    const eventUuid = evento.uri.split("/").pop()!;
    const data = await calendlyGetJson<{ collection: InviteeApiRow[] }>(
      `/scheduled_events/${eventUuid}/invitees`,
      opts,
    );

    for (const inv of data.collection) {
      if (!coincide(inv)) continue;

      const { fecha, hora } = formatearFechaHoraLocal(evento.start_time);

      resultado.push({
        eventUuid,
        inviteeUuid: inv.uri.split("/").pop()!,
        nombreInvitado: inv.name ?? "",
        tipoTurno: categorizarTurno(evento.name),
        fecha,
        hora,
        cancelUrl: inv.cancel_url ?? null,
        rescheduleUrl: inv.reschedule_url ?? null,
      });
    }
  }

  resultado.sort((a, b) => {
    const da = a.fecha.split("/").reverse().join("-") + "T" + a.hora;
    const db = b.fecha.split("/").reverse().join("-") + "T" + b.hora;
    return da.localeCompare(db);
  });

  return resultado;
}

async function consultarTurno(
  telefono: string,
  diasAdelante: number,
  opts: ClienteOpts,
  emailFallback?: string | null,
): Promise<ConsultaTurnos> {
  const telBuscado = normalizarTelefono(telefono);

  if (!telBuscado) {
    throw new CalendlyError(`Teléfono no válido para buscar: ${telefono}`);
  }

  const ahora = new Date();
  const min = ahora.toISOString();
  const max = new Date(ahora.getTime() + diasAdelante * 86_400_000)
    .toISOString();

  const eventos = await listarScheduledEvents(min, max, opts);

  const turnos = await buscarTurnosEnEventos(
    eventos,
    opts,
    (inv) =>
      normalizarTelefono(
        extraerTelefonoDeRespuestas(inv.questions_and_answers),
      ) ===
        telBuscado,
  );

  // Fallback por mail (2026-08-09): la paciente puede haber agendado con un
  // número distinto al que usa para escribirle al bot (ej. otro celular,
  // WhatsApp de una tercera persona) — antes de decir "no tenés turnos",
  // probar también por mail si se conoce uno. Nunca al revés: un match real
  // de teléfono nunca se descarta ni se mezcla con ruido de mail.
  const emailNormalizado = emailFallback?.trim().toLowerCase() || null;

  if (turnos.length === 0 && emailNormalizado) {
    const porMail = await buscarTurnosEnEventos(
      eventos,
      opts,
      (inv) => (inv.email ?? "").trim().toLowerCase() === emailNormalizado,
    );

    if (porMail.length > 0) {
      return {
        telefonoBuscado: telBuscado,
        cantidad: porMail.length,
        turnos: porMail,
        encontradoPorMail: true,
      };
    }
  }

  return {
    telefonoBuscado: telBuscado,
    cantidad: turnos.length,
    turnos,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// TOOL — agendar_turno (única tool expuesta al modelo — ver
// P05_plan_tools_turnos.md sección 2.3: cancelar_turno NO se expone, se usa
// el cancel_url/reschedule_url literal que ya trae consultar_turno).
// ─────────────────────────────────────────────────────────────────────────

interface EventTypeDetalle {
  name: string;
  locations?: { kind: string; location?: string }[];
  custom_questions?: {
    name: string;
    type: string;
    position: number;
  }[];
}

async function detalleEventType(
  eventTypeUri: string,
  opts: ClienteOpts,
): Promise<EventTypeDetalle> {
  const uuid = eventTypeUri.split("/").pop()!;
  const data = await calendlyGetJson<{ resource: EventTypeDetalle }>(
    `/event_types/${uuid}`,
    opts,
  );

  return data.resource;
}

function locationDeEventType(
  detalle: EventTypeDetalle,
): { kind: string; location: string } {
  const loc = detalle.locations?.[0];

  if (!loc) {
    throw new CalendlyError(
      `El event type '${detalle.name}' no tiene ninguna location configurada en Calendly — no se puede agendar sin eso.`,
    );
  }

  return { kind: loc.kind, location: loc.location ?? "" };
}

function preguntaTelefonoDeEventType(
  detalle: EventTypeDetalle,
): { question: string; position: number } | null {
  const claves = ["telefono", "teléfono", "whatsapp", "celular", "phone"];

  for (const q of detalle.custom_questions ?? []) {
    const nombre = (q.name ?? "").toLowerCase();

    if (q.type === "phone_number" || claves.some((k) => nombre.includes(k))) {
      return { question: q.name, position: q.position };
    }
  }

  return null;
}

/**
 * `diaLocalISO`/`diaLocalDesdeISO` son SIEMPRE "YYYY-MM-DD", el día
 * calendario de Buenos Aires ya resuelto por el caller — nunca un `Date` acá
 * (ver el comentario de `formatearFechaCalendarioDMY` sobre el bug real que
 * causaba esto). `dias` es el ancho de la ventana a consultar (1 = solo ese
 * día, N = ese día + N-1 siguientes) — Calendly permite hasta 31 días de
 * rango en `/event_type_available_times` (confirmado en la doc oficial,
 * `developer.calendly.com/view-event-type-and-user-calendar-availability-data`).
 */
async function horariosDisponibles(
  eventTypeUri: string,
  diaLocalISO: string,
  opts: ClienteOpts,
  dias = 1,
): Promise<{ start_time: string }[]> {
  const medianocheLocal = new Date(`${diaLocalISO}T00:00:00-03:00`);
  const ahora = new Date();

  // Bug real de producción (2026-08-08): si `diaLocalISO` es hoy, la
  // medianoche local ya quedó en el pasado apenas pasan las 00:00 —
  // Calendly responde 400 "start_time must be in the future" y, como el
  // paso de turnos es fail-closed, el paciente se queda sin respuesta
  // (silencio, no un error visible). Arrancar la ventana en `ahora` cuando
  // la medianoche ya pasó, nunca antes.
  const inicio = medianocheLocal.getTime() > ahora.getTime()
    ? medianocheLocal
    : ahora;
  const fin = new Date(medianocheLocal.getTime() + dias * 86_400_000);

  const params = new URLSearchParams({
    event_type: eventTypeUri,
    start_time: inicio.toISOString(),
    end_time: fin.toISOString(),
  });

  const data = await calendlyGetJson<{ collection: { start_time: string }[] }>(
    `/event_type_available_times?${params}`,
    opts,
  );

  return data.collection;
}

/** Agrupa horarios (ya devueltos por Calendly, con offset real) por día
 * calendario de Buenos Aires y devuelve el más cercano al día descartado
 * (`diaExcluidoISO`) que tenga al menos un horario libre — la "alternativa
 * más cercana" real, nunca inventada. `orden = "asc"` devuelve el primero
 * cronológicamente (para buscar hacia DELANTE); `orden = "desc"` devuelve el
 * último (para buscar hacia ATRÁS, el más cercano al día pedido veniendo
 * desde antes). `null` si ningún horario de la ventana cae en un día
 * distinto al ya descartado. */
function diaConHorariosMasCercano(
  horarios: { start_time: string }[],
  diaExcluidoISO: string,
  orden: "asc" | "desc",
): { fecha: string; horarios: string[] } | null {
  const porDia = new Map<string, string[]>();

  for (const h of horarios) {
    const dia = fechaLocalISO(new Date(h.start_time));

    if (dia === diaExcluidoISO) continue;

    const hora = formatearFechaHoraLocal(h.start_time).hora;
    const lista = porDia.get(dia) ?? [];
    lista.push(hora);
    porDia.set(dia, lista);
  }

  const diasOrdenados = [...porDia.keys()].sort();

  if (!diasOrdenados.length) return null;

  const elegido = orden === "asc"
    ? diasOrdenados[0]
    : diasOrdenados[diasOrdenados.length - 1];

  return {
    fecha: formatearFechaCalendarioDMY(elegido),
    horarios: porDia.get(elegido)!,
  };
}

async function agendarTurno(
  args: AgendarArgs,
  opts: ClienteOpts,
): Promise<ResultadoAgendar> {
  if (!args.email) {
    return { agendado: false, motivo: "falta_email" };
  }

  const resuelto = await resolverTipoTurno(args.tratamientoOTipoTurno, opts);

  if (!resuelto.ok) {
    return {
      agendado: false,
      motivo: "tipo_turno_ambiguo",
      detalle: resuelto.detalle,
    };
  }

  const tipo = resuelto.tipo;
  const detalle = await detalleEventType(tipo.uri, opts);
  const deseado = new Date(args.fechaHoraDeseada);

  // `deseado` trae hora + offset explícitos (viene de `fecha_hora_deseada`
  // ISO con offset de Buenos Aires) — no hay ambigüedad de día acá, a
  // diferencia de `consultarDisponibilidad` (ver su comentario).
  const disponibles = await horariosDisponibles(
    tipo.uri,
    fechaLocalISO(deseado),
    opts,
  );
  const slotLibre = disponibles.find(
    (d) => new Date(d.start_time).getTime() === deseado.getTime(),
  );

  if (!slotLibre) {
    return {
      agendado: false,
      motivo: "horario_no_disponible",
      horariosAlternativos: disponibles.map((d) => {
        const { fecha, hora } = formatearFechaHoraLocal(d.start_time);
        return `${fecha} ${hora}`;
      }),
      tratamientoSolicitado: args.tratamientoOTipoTurno,
    };
  }

  const telNorm = normalizarTelefono(args.telefono);

  if (!telNorm) {
    throw new CalendlyError(`Teléfono no válido: ${args.telefono}`);
  }

  // deno-lint-ignore no-explicit-any
  const payload: Record<string, any> = {
    event_type: tipo.uri,
    start_time: slotLibre.start_time,
    invitee: {
      name: args.nombre,
      email: args.email,
      timezone: TZ,
    },
    location: locationDeEventType(detalle),
  };

  const preguntaTel = preguntaTelefonoDeEventType(detalle);

  if (preguntaTel) {
    payload.questions_and_answers = [{
      question: preguntaTel.question,
      answer: telNorm.replace(/^\+/, ""),
      position: preguntaTel.position,
    }];
  }

  const r = await calendlyFetch("/invitees", opts, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    throw new CalendlyError(
      `Calendly devolvió ${r.status} al agendar: ${await r.text()}`,
    );
  }

  const data = await r.json();
  const eventUuid = String(data.resource?.event ?? "").split("/").pop() ?? "";
  const { fecha, hora } = formatearFechaHoraLocal(args.fechaHoraDeseada);

  return {
    agendado: true,
    eventUuid,
    fecha,
    hora,
    tipoEvento: tipo.nombre,
    tratamientoSolicitado: args.tratamientoOTipoTurno,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// TOOL — consultar_disponibilidad (agregada 2026-08-06, ver
// P05_plan_tools_turnos.md — pedido explícito de Santi: cuando la paciente
// da un día sin hora puntual ej. "¿hay lugar el miércoles?", el bot tiene
// que poder listar los horarios reales libres de ese día, no solo pasar el
// link genérico. Solo lectura — nunca agenda nada.
// ─────────────────────────────────────────────────────────────────────────

/** Ventana que se consulta (para cada lado) buscando la alternativa más
 * cercana cuando el día pedido no tiene nada — bien por debajo del máximo
 * real de 31 días que permite `/event_type_available_times` (confirmado
 * contra la doc oficial de Calendly), da ~2 semanas de margen. */
const VENTANA_ALTERNATIVAS_DIAS = 14;

/** Suma (o resta, con `dias` negativo) días de calendario a una fecha
 * "YYYY-MM-DD", devolviendo otra fecha "YYYY-MM-DD" — string puro entrando y
 * saliendo, el único `Date` intermedio tiene hora+offset explícitos así que
 * no hay ambigüedad de día (mismo criterio que el resto del archivo, ver
 * `formatearFechaCalendarioDMY`). */
function sumarDias(fechaISO: string, dias: number): string {
  const d = new Date(`${fechaISO}T00:00:00-03:00`);
  d.setTime(d.getTime() + dias * 86_400_000);
  return fechaLocalISO(d);
}

/** Cantidad de días de calendario entre dos fechas "YYYY-MM-DD" (`b - a`,
 * ambas a medianoche de Buenos Aires) — para dimensionar la ventana hacia
 * atrás sin pasarse del día pedido. */
function diasEntre(aISO: string, bISO: string): number {
  const a = new Date(`${aISO}T00:00:00-03:00`);
  const b = new Date(`${bISO}T00:00:00-03:00`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

async function consultarDisponibilidad(
  tratamientoOTipoTurno: string,
  fechaDeseada: string,
  hoyISO: string,
  opts: ClienteOpts,
): Promise<ResultadoDisponibilidad> {
  const resuelto = await resolverTipoTurno(tratamientoOTipoTurno, opts);

  if (!resuelto.ok) {
    return {
      disponible: false,
      motivo: "tipo_turno_ambiguo",
      detalle: resuelto.detalle,
    };
  }

  const tipo = resuelto.tipo;

  // `fechaDeseada` YA es el día calendario de Buenos Aires que la paciente
  // pidió (resuelto río arriba, en `turnos.ts`) — se pasa tal cual, nunca a
  // través de `new Date()` (ver el comentario de `formatearFechaCalendarioDMY`
  // sobre el bug real que esto reemplaza).
  const disponibles = await horariosDisponibles(tipo.uri, fechaDeseada, opts);
  const fechaFmt = formatearFechaCalendarioDMY(fechaDeseada);

  if (!disponibles.length) {
    // Hacia DELANTE: sin cambios de fondo respecto de la versión anterior.
    const horariosVentanaDespues = await horariosDisponibles(
      tipo.uri,
      sumarDias(fechaDeseada, 1),
      opts,
      VENTANA_ALTERNATIVAS_DIAS,
    );

    // Hacia ATRÁS: agregado 2026-08-08 — `consultar_disponibilidad` es
    // código nuestro, no una limitación de Calendly, así que no hay motivo
    // para que la búsqueda de alternativa sea unidireccional (ver Incidente
    // real: Santi preguntó "¿y antes no tenés?" y el bot no tenía forma de
    // buscarlo). Nunca se busca antes de hoy — no tiene sentido ofrecer un
    // turno en el pasado.
    const inicioAntesISO = (() => {
      const candidato = sumarDias(fechaDeseada, -VENTANA_ALTERNATIVAS_DIAS);
      return candidato < hoyISO ? hoyISO : candidato;
    })();
    const diasVentanaAntes = diasEntre(inicioAntesISO, fechaDeseada);

    const horariosVentanaAntes = diasVentanaAntes > 0
      ? await horariosDisponibles(
        tipo.uri,
        inicioAntesISO,
        opts,
        diasVentanaAntes,
      )
      : [];

    return {
      disponible: false,
      motivo: "sin_horarios_ese_dia",
      tipoEvento: tipo.nombre,
      fecha: fechaFmt,
      alternativaDespues: diaConHorariosMasCercano(
        horariosVentanaDespues,
        fechaDeseada,
        "asc",
      ),
      alternativaAntes: diaConHorariosMasCercano(
        horariosVentanaAntes,
        fechaDeseada,
        "desc",
      ),
      tratamientoSolicitado: tratamientoOTipoTurno,
    };
  }

  return {
    disponible: true,
    tipoEvento: tipo.nombre,
    fecha: fechaFmt,
    horarios: disponibles.map((d) =>
      formatearFechaHoraLocal(d.start_time).hora
    ),
    tratamientoSolicitado: tratamientoOTipoTurno,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// TOOL — consultar_disponibilidad_rango (agregada 2026-08-08, ver el
// comentario largo en `CalendlyTools.consultarDisponibilidadRango`). Reusa
// `horariosDisponibles` (ya soporta un ancho de ventana en días) y
// `diaConHorariosMasCercano`/`sumarDias`/`diasEntre` para la búsqueda de
// alternativa cuando el rango pedido no tiene nada — mismo patrón que
// `consultarDisponibilidad`, extendido a un rango en vez de un solo día.
// ─────────────────────────────────────────────────────────────────────────

/** Días distintos que se ofrecen como máximo cuando SÍ hay lugar en el
 * rango — nunca todos, para no saturar el mensaje de WhatsApp. */
const MAX_OPCIONES_RANGO = 3;

/** Agrupa horarios reales (ya con offset, tal como los devuelve Calendly)
 * por día calendario de Buenos Aires, descartando los que no caen en la
 * franja horaria pedida (si se pidió alguna). */
function agruparPorDia(
  horarios: { start_time: string }[],
  franja: "manana" | "tarde" | null,
): Map<string, string[]> {
  const porDia = new Map<string, string[]>();

  for (const h of horarios) {
    const hora = formatearFechaHoraLocal(h.start_time).hora;

    if (franja) {
      const hh = Number(hora.slice(0, 2));
      const enFranja = franja === "manana" ? hh < 13 : hh >= 13;
      if (!enFranja) continue;
    }

    const dia = fechaLocalISO(new Date(h.start_time));
    const lista = porDia.get(dia) ?? [];
    lista.push(hora);
    porDia.set(dia, lista);
  }

  return porDia;
}

async function consultarDisponibilidadRango(
  tratamientoOTipoTurno: string,
  fechaInicioISO: string,
  fechaFinISO: string,
  franja: "manana" | "tarde" | null,
  hoyISO: string,
  opts: ClienteOpts,
): Promise<ResultadoDisponibilidadRango> {
  const resuelto = await resolverTipoTurno(tratamientoOTipoTurno, opts);

  if (!resuelto.ok) {
    return {
      disponible: false,
      motivo: "tipo_turno_ambiguo",
      detalle: resuelto.detalle,
    };
  }

  const tipo = resuelto.tipo;
  const diasRango = diasEntre(fechaInicioISO, fechaFinISO) + 1;
  const horarios = await horariosDisponibles(
    tipo.uri,
    fechaInicioISO,
    opts,
    diasRango,
  );

  const porDia = agruparPorDia(horarios, franja);
  const diasConLugar = [...porDia.keys()].sort();

  if (diasConLugar.length > 0) {
    return {
      disponible: true,
      tipoEvento: tipo.nombre,
      tratamientoSolicitado: tratamientoOTipoTurno,
      opciones: diasConLugar.slice(0, MAX_OPCIONES_RANGO).map((dia) => ({
        fecha: formatearFechaCalendarioDMY(dia),
        horarios: porDia.get(dia)!,
      })),
    };
  }

  // Sin nada en el rango (con el filtro de franja aplicado, si había) —
  // misma búsqueda bidireccional que ya existe para el caso de un día
  // puntual, ANCLADA a los bordes del rango en vez de a un solo día.
  const horariosVentanaDespues = await horariosDisponibles(
    tipo.uri,
    sumarDias(fechaFinISO, 1),
    opts,
    VENTANA_ALTERNATIVAS_DIAS,
  );

  const inicioAntesISO = (() => {
    const candidato = sumarDias(fechaInicioISO, -VENTANA_ALTERNATIVAS_DIAS);
    return candidato < hoyISO ? hoyISO : candidato;
  })();
  const diasVentanaAntes = diasEntre(inicioAntesISO, fechaInicioISO);

  const horariosVentanaAntes = diasVentanaAntes > 0
    ? await horariosDisponibles(
      tipo.uri,
      inicioAntesISO,
      opts,
      diasVentanaAntes,
    )
    : [];

  const porDiaDespues = agruparPorDia(horariosVentanaDespues, franja);
  const porDiaAntes = agruparPorDia(horariosVentanaAntes, franja);
  const diaDespues = [...porDiaDespues.keys()].sort()[0];
  const diaAntes = [...porDiaAntes.keys()].sort().pop();

  return {
    disponible: false,
    motivo: "sin_horarios_en_rango",
    tipoEvento: tipo.nombre,
    tratamientoSolicitado: tratamientoOTipoTurno,
    fechaInicio: formatearFechaCalendarioDMY(fechaInicioISO),
    fechaFin: formatearFechaCalendarioDMY(fechaFinISO),
    alternativaDespues: diaDespues
      ? {
        fecha: formatearFechaCalendarioDMY(diaDespues),
        horarios: porDiaDespues.get(diaDespues)!,
      }
      : null,
    alternativaAntes: diaAntes
      ? {
        fecha: formatearFechaCalendarioDMY(diaAntes),
        horarios: porDiaAntes.get(diaAntes)!,
      }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Factory — inyectable, para poder mockear en `guardrail-golden-set` sin
// tocar Calendly real (ver P05_plan_tools_turnos.md sección 6).
// ─────────────────────────────────────────────────────────────────────────

export function crearCalendlyTools(
  apiKey: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): CalendlyTools {
  const clienteOpts: ClienteOpts = { apiKey, ...opts };

  return {
    consultarTurno: (telefono, diasAdelante = 90, emailFallback = null) =>
      consultarTurno(telefono, diasAdelante, clienteOpts, emailFallback),
    consultarDisponibilidad: (tratamientoOTipoTurno, fechaDeseada, hoyISO) =>
      consultarDisponibilidad(
        tratamientoOTipoTurno,
        fechaDeseada,
        hoyISO,
        clienteOpts,
      ),
    consultarDisponibilidadRango: (
      tratamientoOTipoTurno,
      fechaInicioISO,
      fechaFinISO,
      franja,
      hoyISO,
    ) =>
      consultarDisponibilidadRango(
        tratamientoOTipoTurno,
        fechaInicioISO,
        fechaFinISO,
        franja,
        hoyISO,
        clienteOpts,
      ),
    agendarTurno: (args) => agendarTurno(args, clienteOpts),
  };
}
