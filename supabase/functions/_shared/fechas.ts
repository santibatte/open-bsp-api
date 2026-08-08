/**
 * Resolución determinística de fechas para el agente de turnos — el modelo
 * NUNCA calcula una fecha ISO ni un día de semana, solo indica QUÉ dijo la
 * paciente (día de semana, relativo, o fecha explícita) y este módulo lo
 * convierte a un día calendario real de Buenos Aires. Mismo espíritu que
 * `telefonos.ts` (helper de dominio puro, sin I/O).
 *
 * Por qué existe: un LLM no tiene forma confiable de hacer aritmética de
 * calendario — es un modelo de predicción de texto, no un reloj. Encontrado
 * en vivo dos veces (2026-08-06 a 2026-08-08, ver "Incidente 9" en
 * `proyectos/P05_lecciones_guardrail.md`, repo `consultorio_dermatologico`):
 * primero un bug de código que corría la fecha un día, después el modelo
 * mismo describiendo mal el día de semana de una fecha correcta ("lunes
 * 19/08" siendo en realidad miércoles). La solución documentada para esta
 * clase de problema (ver fuentes citadas en esa misma sección) es sacar
 * el cálculo del modelo por completo, nunca pedirle que lo haga mejor.
 */
import { fechaLocalISO } from "./calendly.ts";

export type DiaSemana =
  | "domingo"
  | "lunes"
  | "martes"
  | "miercoles"
  | "jueves"
  | "viernes"
  | "sabado";

/** Orden que coincide con `Date.getDay()` (0 = domingo ... 6 = sábado). */
const ORDEN_DIAS: DiaSemana[] = [
  "domingo",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
];

/** Shape que llena el modelo — nunca una fecha ISO calculada por él, solo
 * qué dijo la paciente. Espeja el input_schema de las tools en `prompts.ts`
 * (`SCHEMA_EXPRESION_FECHA`). */
export type ExpresionFecha =
  | { tipo: "hoy" }
  | { tipo: "manana" }
  | { tipo: "pasado_manana" }
  | { tipo: "dia_semana"; dia_semana: DiaSemana }
  | { tipo: "fecha_explicita"; fecha_explicita: string };

export type ResultadoResolverFecha =
  | { ok: true; fechaISO: string }
  | { ok: false; motivo: string };

/** Ancla un día calendario de Buenos Aires (YYYY-MM-DD) al mediodía, nunca
 * medianoche — mediodía en Buenos Aires (-03:00) son las 15:00 UTC del
 * MISMO día calendario, así que `.getDay()`/aritmética de milisegundos
 * nunca cruza un límite de día por culpa del huso horario del entorno de
 * ejecución (que puede no ser Buenos Aires). Medianoche SÍ tiene ese riesgo
 * — es exactamente el bug real de `_shared/calendly.ts` documentado en
 * `formatearFechaCalendarioDMY`. */
function anclarAlMediodia(diaISO: string): Date {
  return new Date(`${diaISO}T12:00:00-03:00`);
}

/**
 * Resuelve una expresión de fecha contra una fecha ancla (`ahora`) — la
 * única función de todo el sistema que hace aritmética de calendario. El
 * caller (`guardrail/turnos.ts`) toma `ahora` UNA sola vez por mensaje y la
 * reusa para todo (texto que ve el modelo + resolución real), para que no
 * haya una carrera de reloj entre lo que el modelo lee y lo que el código
 * resuelve.
 */
export function resolverFechaExpresion(
  expr: ExpresionFecha,
  ahora: Date,
): ResultadoResolverFecha {
  const hoyISO = fechaLocalISO(ahora);
  const hoyAncla = anclarAlMediodia(hoyISO);

  switch (expr.tipo) {
    case "hoy":
      return { ok: true, fechaISO: hoyISO };

    case "manana":
      return {
        ok: true,
        fechaISO: fechaLocalISO(new Date(hoyAncla.getTime() + 86_400_000)),
      };

    case "pasado_manana":
      return {
        ok: true,
        fechaISO: fechaLocalISO(new Date(hoyAncla.getTime() + 2 * 86_400_000)),
      };

    case "dia_semana": {
      const objetivo = ORDEN_DIAS.indexOf(expr.dia_semana);

      if (objetivo === -1) {
        return {
          ok: false,
          motivo: `día de semana no reconocido: ${
            JSON.stringify(expr.dia_semana)
          }`,
        };
      }

      // Próxima ocurrencia, contando HOY como válido (delta 0) si hoy ES
      // ese día — nunca una que ya pasó. Mismo criterio ya documentado en
      // el prompt del agente de turnos.
      const delta = (objetivo - hoyAncla.getDay() + 7) % 7;

      return {
        ok: true,
        fechaISO: fechaLocalISO(
          new Date(hoyAncla.getTime() + delta * 86_400_000),
        ),
      };
    }

    case "fecha_explicita":
      return parsearFechaExplicita(expr.fecha_explicita, hoyAncla, hoyISO);
  }
}

/** Parsea "DD/MM" o "DD/MM/YYYY" (formatos que puede escribir/dictar una
 * persona). Sin año explícito, asume el de `hoyISO`; si el resultado ya
 * pasó, prueba el año siguiente (ej. "12/01" pedido en diciembre). Rechaza
 * (ok:false) cualquier combinación inválida — fail-closed, nunca
 * "interpreta con buena onda" una fecha imposible. */
function parsearFechaExplicita(
  texto: string,
  hoyAncla: Date,
  hoyISO: string,
): ResultadoResolverFecha {
  const match = texto.trim().match(
    /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/,
  );

  if (!match) {
    return {
      ok: false,
      motivo: `fecha_explicita no tiene un formato reconocible: ${
        JSON.stringify(texto)
      }`,
    };
  }

  const dia = Number(match[1]);
  const mes = Number(match[2]);
  let anio = match[3] ? Number(match[3]) : Number(hoyISO.slice(0, 4));

  if (anio < 100) anio += 2000;

  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) {
    return {
      ok: false,
      motivo: `fecha_explicita fuera de rango: ${JSON.stringify(texto)}`,
    };
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  let candidatoISO = `${anio}-${pad(mes)}-${pad(dia)}`;
  let candidato = new Date(`${candidatoISO}T12:00:00-03:00`);

  if (Number.isNaN(candidato.getTime())) {
    return {
      ok: false,
      motivo: `fecha_explicita inválida (día/mes no existen): ${
        JSON.stringify(texto)
      }`,
    };
  }

  if (!match[3] && candidato.getTime() < hoyAncla.getTime()) {
    anio += 1;
    candidatoISO = `${anio}-${pad(mes)}-${pad(dia)}`;
    candidato = new Date(`${candidatoISO}T12:00:00-03:00`);
  }

  return { ok: true, fechaISO: candidatoISO };
}

/** "HH:MM", 24hs estricto. La HORA sigue siendo texto literal de la
 * paciente (no hay cálculo posible ahí) — esto solo valida FORMATO. */
export function validarHoraHHMM(hora: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hora);
}

// ═══════════════════════════════════════════════════════════════════════
// RANGO DE FECHA (2026-08-08) — para pedidos vagos pero ACOTADOS a una
// semana ("la semana que viene, cualquier tarde"), que hasta acá caían
// directo al link genérico de Calendly sin buscar disponibilidad real. Ver
// `proyectos/P05_investigacion_bots` (repo `consultorio_dermatologico`) para
// la investigación que motivó este diseño: el patrón real encontrado
// (`inboxbuddy`) es que el modelo solo CLASIFICA la ambigüedad a un schema
// acotado (nunca calcula fechas), y el código resuelve el rango real y
// consulta disponibilidad de verdad — mismo espíritu que
// `resolverFechaExpresion` para un día puntual, extendido a una semana.
//
// Deliberadamente chico: solo dos rangos (semana actual / semana que viene),
// no un parser de rango libre — alcanza para el caso real encontrado y evita
// construir algo más general de lo que hace falta.
// ═══════════════════════════════════════════════════════════════════════

export type FranjaHoraria = "manana" | "tarde";

/** Shape que llena el modelo para `consultar_disponibilidad` — superset de
 * `ExpresionFecha` (un día puntual sigue siendo válido) más dos casos de
 * RANGO. Nunca se usa para `agendar_turno`: reservar siempre necesita un día
 * puntual, así que esa tool sigue con `ExpresionFecha` sin cambios. */
export type ExpresionFechaConsulta =
  | ExpresionFecha
  | { tipo: "semana_actual" }
  | { tipo: "semana_que_viene" };

export type ResultadoResolverRango =
  | { ok: true; inicioISO: string; finISO: string }
  | { ok: false; motivo: string };

/** Suma (o resta, con `dias` negativo) días de calendario a un día
 * "YYYY-MM-DD" — mismo criterio de anclaje al mediodía que el resto del
 * archivo (ver `anclarAlMediodia`), para no repetir el bug de timezone ya
 * documentado en `_shared/calendly.ts`. */
function sumarDiasISO(diaISO: string, dias: number): string {
  return fechaLocalISO(
    new Date(anclarAlMediodia(diaISO).getTime() + dias * 86_400_000),
  );
}

/** Lunes de la semana (Argentina: la semana arranca lunes) que contiene
 * `diaISO`. */
function lunesDeSemana(diaISO: string): string {
  const dow = anclarAlMediodia(diaISO).getDay(); // 0 = domingo ... 6 = sábado
  const deltaHastaLunes = dow === 0 ? -6 : 1 - dow;
  return sumarDiasISO(diaISO, deltaHastaLunes);
}

/**
 * Resuelve un rango de fecha contra una fecha ancla (`ahora`) — mismo
 * principio que `resolverFechaExpresion`: el modelo nunca calcula el rango,
 * solo dice "esta semana" o "la semana que viene" y esto hace la cuenta.
 * Un día puntual (`ExpresionFecha`) se delega a `resolverFechaExpresion` y
 * vuelve como un rango de un solo día (`inicioISO === finISO`).
 *
 * "semana_actual" arranca HOY, nunca antes — no tiene sentido buscar
 * disponibilidad en un día ya pasado de la semana en curso.
 */
export function resolverRangoFecha(
  expr: ExpresionFechaConsulta,
  ahora: Date,
): ResultadoResolverRango {
  const hoyISO = fechaLocalISO(ahora);

  if (expr.tipo === "semana_actual") {
    const domingoDeEstaSemana = sumarDiasISO(lunesDeSemana(hoyISO), 6);
    return { ok: true, inicioISO: hoyISO, finISO: domingoDeEstaSemana };
  }

  if (expr.tipo === "semana_que_viene") {
    const lunesQueViene = sumarDiasISO(lunesDeSemana(hoyISO), 7);
    return {
      ok: true,
      inicioISO: lunesQueViene,
      finISO: sumarDiasISO(lunesQueViene, 6),
    };
  }

  const resuelto = resolverFechaExpresion(expr, ahora);

  return resuelto.ok
    ? { ok: true, inicioISO: resuelto.fechaISO, finISO: resuelto.fechaISO }
    : resuelto;
}

/** ¿Una hora "HH:MM" cae en la franja pedida? Corte simple al mediodía
 * (12:59 es "mañana", 13:00 es "tarde") — no hay ninguna fuente que defina
 * un corte distinto, y es el criterio más intuitivo para una paciente. */
export function horaEnFranja(horaHHMM: string, franja: FranjaHoraria): boolean {
  const hh = Number(horaHHMM.slice(0, 2));
  return franja === "manana" ? hh < 13 : hh >= 13;
}

/** Arma el ISO con offset que espera Calendly — el ÚNICO lugar que
 * combina fecha ya resuelta + hora ya validada, nunca el modelo. */
export function construirFechaHoraISO(
  fechaISO: string,
  horaHHMM: string,
): string {
  return `${fechaISO}T${horaHHMM}:00-03:00`;
}

/** Quita tildes para comparar contra texto libre de una conversación real
 * (la paciente escribe "miércoles", el enum interno es "miercoles"). */
export function normalizarTexto(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
