/**
 * Verificador DETERMINISTA de datos puntuales del borrador (precios, links,
 * mails, fechas, horas, días de semana, lista de precios).
 *
 * Por qué existe: hasta v27 el juez (LLM) verificaba "dígito por dígito" que
 * cada dato tuviera respaldo literal en el catálogo, la FAQ o la evidencia de
 * Calendly. En los 30 días al 2026-09-29, 17 de las 22 respuestas silenciadas
 * por el juez fueron de turnos, varias por falsos rechazos (ej. "las 15:30 sí
 * están en la evidencia, pero no dice que es consulta médica"). Comparar
 * números y strings es trabajo de código: exacto, gratis y sin opinión. El
 * juez queda para lo que sí requiere criterio (consejo médico, derivación).
 *
 * Funciones puras, sin red: se testean con casos adversariales en
 * `verificador_test.ts`. Hora de Argentina fija (-03:00, sin horario de
 * verano desde 2009), igual que `_shared/calendly.ts`.
 */

export type TipoHallazgo =
  | "precio"
  | "lista_precios"
  | "link"
  | "mail"
  | "fecha"
  | "hora"
  | "dia_sin_lugar"
  | "dia_semana"
  | "dato_de_pago";

export interface Hallazgo {
  tipo: TipoHallazgo;
  /** El dato del borrador, tal como aparece. */
  valor: string;
  /** Explicación accionable: la lee el paso de reescritura. */
  motivo: string;
}

export interface FuentesVerificacion {
  /** Texto de `cargarCatalogo` (líneas "- Servicio: $X ..." bajo "### Familia"). */
  catalogo: string;
  faq: string;
  /** Evidencia de turnos + jornadas de IPL (lo mismo que recibe el juez). */
  evidencia: string;
  /** Mensajes de la paciente (actual + historial): fuente de mails y fechas mencionadas. */
  textoPaciente: string;
  /** Mensajes previos del consultorio en esta conversación (ya verificados al enviarse). */
  textoBotPrevio: string;
  linksPermitidos: string[];
  mailsPermitidos: string[];
  ahora: Date;
}

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** Mismo orden que `Date.getUTCDay()`. */
const DIAS_SEMANA = [
  "domingo",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
];

const OFFSET_AR_MS = -3 * 60 * 60 * 1000;

/** NFKD: dígitos de ancho completo ("１７０") → ASCII. Sin tildes ni caracteres invisibles. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFKD")
    .replace(/[̀-ͯ​-‍⁠﻿]/g, "")
    .toLowerCase();
}

/** Segmentos ~oración: la unidad en la que se asocia fecha ↔ hora ↔ tratamiento. */
function segmentos(texto: string): string[] {
  return texto
    .split(/(?<=[.!?;])\s+|\n+|(?<=[—–])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────── montos ───────────────────────────────

function aEntero(numero: string): number {
  // "150.000" / "150,000" → miles; "150" → 150.
  return /^\d{1,3}([.,]\d{3})+$/.test(numero)
    ? Number(numero.replace(/[.,]/g, ""))
    : Number(numero.replace(",", "."));
}

interface Monto {
  valor: number;
  texto: string;
  inicio: number;
  fin: number;
}

export function extraerMontos(texto: string): Monto[] {
  const t = normalizar(texto);
  const montos: Monto[] = [];
  const patrones: [RegExp, (m: RegExpExecArray) => number][] = [
    [/\$\s*(\d{1,3}(?:[.,]\d{3})+|\d+)(?:,\d{1,2})?/g, (m) => aEntero(m[1])],
    [
      /\b(\d+(?:[.,]\d+)?)\s*(?:mil|lucas|k)\b/g,
      (m) => Math.round(Number(m[1].replace(",", ".")) * 1000),
    ],
    [
      /\b(\d{1,3}(?:\.\d{3})+|\d{4,})\s*(?:pesos|ars)\b/g,
      (m) => aEntero(m[1]),
    ],
  ];

  for (const [patron, valor] of patrones) {
    for (const m of t.matchAll(patron)) {
      const inicio = m.index ?? 0;
      const fin = inicio + m[0].length;

      if (montos.some((x) => inicio < x.fin && fin > x.inicio)) continue;

      montos.push({
        valor: valor(m as RegExpExecArray),
        texto: m[0],
        inicio,
        fin,
      });
    }
  }

  return montos;
}

// ─────────────────────────────── catálogo ───────────────────────────────

interface Servicio {
  nombre: string;
  familia: string;
  precios: Set<number>;
}

interface CatalogoParseado {
  servicios: Servicio[];
  /** Palabra que identifica UNA sola familia ("botox", "ipl", "maceteros"). */
  tokenAFamilia: Map<string, string>;
  preciosPorFamilia: Map<string, Set<number>>;
}

const PALABRAS_VACIAS = new Set([
  "del",
  "con",
  "los",
  "las",
  "por",
  "para",
  "sin",
  "sesion",
  "precio",
  "precios",
  "promo",
]);

function tokens(texto: string): string[] {
  return normalizar(texto)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !PALABRAS_VACIAS.has(w));
}

export function parsearCatalogo(catalogo: string): CatalogoParseado {
  const servicios: Servicio[] = [];
  let familia = "";
  let enOtros = false;

  for (const linea of catalogo.split("\n")) {
    if (linea.startsWith("### ")) {
      familia = linea.slice(4).trim();
      enOtros = /otros servicios/i.test(familia);
      continue;
    }

    const m = /^- (.+?): (.*)$/.exec(linea);

    if (!m) continue;

    const nombre = m[1].replace(/\s*\([^)]*\)\s*$/, "").trim();

    servicios.push({
      nombre,
      // Cada servicio "sin descripción" es un tratamiento distinto.
      familia: enOtros ? `otros:${nombre}` : familia,
      precios: new Set(extraerMontos(m[2]).map((x) => x.valor)),
    });
  }

  const familiasPorToken = new Map<string, Set<string>>();
  const preciosPorFamilia = new Map<string, Set<number>>();

  for (const s of servicios) {
    const fuente = s.familia.startsWith("otros:")
      ? s.nombre
      : `${s.familia} ${s.nombre}`;

    for (const tk of tokens(fuente)) {
      if (!familiasPorToken.has(tk)) familiasPorToken.set(tk, new Set());
      familiasPorToken.get(tk)!.add(s.familia);
    }

    if (!preciosPorFamilia.has(s.familia)) {
      preciosPorFamilia.set(s.familia, new Set());
    }

    s.precios.forEach((p) => preciosPorFamilia.get(s.familia)!.add(p));
  }

  const tokenAFamilia = new Map<string, string>();

  for (const [tk, familias] of familiasPorToken) {
    if (familias.size === 1) tokenAFamilia.set(tk, [...familias][0]);
  }

  return { servicios, tokenAFamilia, preciosPorFamilia };
}

function familiasMencionadas(
  segmento: string,
  catalogo: CatalogoParseado,
): Set<string> {
  const seg = normalizar(segmento);
  const familias = new Set<string>();

  for (const s of catalogo.servicios) {
    if (seg.includes(normalizar(s.nombre))) familias.add(s.familia);
  }

  for (const tk of tokens(segmento)) {
    const familia = catalogo.tokenAFamilia.get(tk);
    if (familia) familias.add(familia);
  }

  return familias;
}

// ─────────────────────────────── fechas ───────────────────────────────

interface FechaEnTexto {
  dia: number;
  mes: number;
  anio?: number;
  /** "DD/MM" — la clave de comparación (el año se usa solo para el día de semana). */
  clave: string;
  diaSemana?: string;
  texto: string;
  /** "hoy" / "mañana" / "pasado mañana": solo cuenta si va con una hora. */
  relativa: boolean;
}

function clave(dia: number, mes: number): string {
  return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}`;
}

function hoyAR(ahora: Date): { anio: number; mes: number; dia: number } {
  const d = new Date(ahora.getTime() + OFFSET_AR_MS);
  return {
    anio: d.getUTCFullYear(),
    mes: d.getUTCMonth() + 1,
    dia: d.getUTCDate(),
  };
}

function diaSemanaDe(anio: number, mes: number, dia: number): string {
  return DIAS_SEMANA[new Date(Date.UTC(anio, mes - 1, dia, 15)).getUTCDay()];
}

/** Año más probable de un "DD/MM" sin año: este año, salvo que ya pasó hace más de 60 días. */
function inferirAnio(dia: number, mes: number, ahora: Date): number {
  const hoy = hoyAR(ahora);
  const candidata = Date.UTC(hoy.anio, mes - 1, dia);
  const hoyMs = Date.UTC(hoy.anio, hoy.mes - 1, hoy.dia);
  return candidata < hoyMs - 60 * 24 * 60 * 60 * 1000 ? hoy.anio + 1 : hoy.anio;
}

function sumarDias(ahora: Date, dias: number): { dia: number; mes: number } {
  const hoy = hoyAR(ahora);
  const d = new Date(Date.UTC(hoy.anio, hoy.mes - 1, hoy.dia + dias, 15));
  return { dia: d.getUTCDate(), mes: d.getUTCMonth() + 1 };
}

const RE_DIA_SEMANA = "(lunes|martes|miercoles|jueves|viernes|sabado|domingo)";
const RE_MES = `(${MESES.join("|")})`;

export function extraerFechas(texto: string, ahora: Date): FechaEnTexto[] {
  const t = normalizar(texto);
  const fechas: FechaEnTexto[] = [];
  const ocupado: [number, number][] = [];

  const agregar = (
    m: RegExpMatchArray,
    dia: number,
    mes: number,
    anio: number | undefined,
    diaSemana: string | undefined,
    relativa = false,
  ) => {
    const inicio = m.index ?? 0;
    const fin = inicio + m[0].length;

    if (ocupado.some(([a, b]) => inicio < b && fin > a)) return;
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return;

    ocupado.push([inicio, fin]);
    fechas.push({
      dia,
      mes,
      anio,
      clave: clave(dia, mes),
      diaSemana,
      texto: m[0],
      relativa,
    });
  };

  const anioDe = (s?: string) =>
    s ? (s.length === 2 ? 2000 + Number(s) : Number(s)) : undefined;

  for (
    const m of t.matchAll(
      new RegExp(
        `(?:\\b${RE_DIA_SEMANA}\\s*,?\\s*(?:el\\s+)?)?\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?\\b`,
        "g",
      ),
    )
  ) {
    agregar(m, Number(m[2]), Number(m[3]), anioDe(m[4]), m[1]);
  }

  for (
    const m of t.matchAll(
      new RegExp(
        `(?:\\b${RE_DIA_SEMANA}\\s*,?\\s*)?\\b(\\d{1,2})\\s+de\\s+${RE_MES}(?:\\s+de\\s+(\\d{4}))?`,
        "g",
      ),
    )
  ) {
    agregar(m, Number(m[2]), MESES.indexOf(m[3]) + 1, anioDe(m[4]), m[1]);
  }

  // "mañana" como día (no "a la mañana" / "por la mañana"), "hoy", "pasado mañana".
  for (
    const m of t.matchAll(
      /(?<!\bla\s)(?<!\bde\s)(?<!\bpasado\s)\b(hoy|pasado manana|manana)\b/g,
    )
  ) {
    const dias = m[1] === "hoy" ? 0 : m[1] === "manana" ? 1 : 2;
    const f = sumarDias(ahora, dias);
    agregar(m, f.dia, f.mes, undefined, undefined, true);
  }

  return fechas;
}

function diasSemanaSueltos(texto: string): string[] {
  const t = normalizar(texto)
    .replace(
      new RegExp(
        `\\b${RE_DIA_SEMANA}\\s*,?\\s*(?:el\\s+)?\\d{1,2}(/|\\s+de\\s)`,
        "g",
      ),
      " ",
    );
  return [...t.matchAll(new RegExp(`\\b${RE_DIA_SEMANA}\\b`, "g"))].map((m) =>
    m[1]
  );
}

// ─────────────────────────────── horas ───────────────────────────────

function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Contexto que marca una DURACIÓN, no una hora ("cada 4 hs", "24 hs antes"). */
const ANTES_DURACION = /(cada|primeras|durante|unas|por|dentro de|\d\s*-)\s*$/;
const DESPUES_DURACION =
  /^\s*(antes|despues|previas|posteriores|de reposo|de anticipacion|de ayuno)/;

export function extraerHoras(texto: string): string[] {
  // Montos y fechas afuera antes de buscar horas ("$20.000", "21/10").
  let t = normalizar(texto)
    .replace(/\$\s*[\d.,]+/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ");
  const horas: string[] = [];

  const tarde = (h: number, sufijo?: string) =>
    sufijo && /tarde|noche/.test(sufijo) && h < 12 ? h + 12 : h;

  // "de 10 a 15 hs" (rango de la FAQ).
  t = t.replace(
    /\bde\s+([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*(?:hs?)?\s+a\s+([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*(?:hs|h|horas)\b/g,
    (_, h1, m1, h2, m2) => {
      horas.push(hhmm(Number(h1), Number(m1 ?? 0)));
      horas.push(hhmm(Number(h2), Number(m2 ?? 0)));
      return " ";
    },
  );

  // "10:30", "10.30", "10:30 hs".
  t = t.replace(
    /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?:\s*(?:hs|h|horas)\b)?(\s+de la (?:manana|tarde|noche))?/g,
    (_, h, m, sufijo) => {
      horas.push(hhmm(tarde(Number(h), sufijo), Number(m)));
      return " ";
    },
  );

  const alHora = (_: string, h: string, media?: string, sufijo?: string) => {
    horas.push(hhmm(tarde(Number(h), sufijo), media ? 30 : 0));
    return " ";
  };

  // "a las 11 tenés lugar", "a las 11 y media", "desde las 4 de la tarde":
  // con preposición es siempre una hora, salvo que siga una unidad.
  t = t.replace(
    /\b(?:a|desde|hasta|para|tipo)\s+las\s+([01]?\d|2[0-3])(?!\s*(?:sesiones|semanas|dias|meses|veces|aplicaciones)\b)(?:\s*(?:hs|h|horas)\b)?(\s+y media)?(\s+de la (?:manana|tarde|noche))?/g,
    alHora,
  );

  // "las 10 hs", "las 4 de la tarde": sin preposición exige contexto de hora
  // ("las 3 sesiones iniciales" no es una hora).
  t = t.replace(
    /\blas\s+([01]?\d|2[0-3])(?=\s*(?:hs?\b|horas\b|y media|de la (?:manana|tarde|noche)|[,.;?!)]|\s+o\s|\s+y\s|$))(?:\s*(?:hs|h|horas)\b)?(\s+y media)?(\s+de la (?:manana|tarde|noche))?/g,
    alHora,
  );

  // "16hs", "16 hs" sueltos, salvo que sea una duración.
  for (const m of t.matchAll(/\b([01]?\d|2[0-3])\s*(?:hs|horas)\b/g)) {
    const inicio = m.index ?? 0;
    const antes = t.slice(Math.max(0, inicio - 15), inicio);
    const despues = t.slice(inicio + m[0].length, inicio + m[0].length + 20);

    if (ANTES_DURACION.test(antes) || DESPUES_DURACION.test(despues)) continue;

    horas.push(hhmm(Number(m[1]), 0));
  }

  return horas;
}

// ─────────────────────────────── links y mails ───────────────────────────────

function limpiarUrl(url: string): string {
  return url.replace(/[.,;:!?)\]>'"]+$/, "");
}

export function extraerLinks(texto: string): string[] {
  const links = new Set<string>();

  for (const m of texto.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    links.add(limpiarUrl(m[0]));
  }

  // Dominios sin esquema ("calendly.com/...", "www.algo.com.ar"). Los mails
  // se sacan antes: "dra.melisa@..." no es el dominio "dra.me".
  const sinEsquema = texto
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ");

  for (
    const m of sinEsquema.matchAll(
      /(?<![@\w.])(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ar|net|org|io|ly|me|app|link)(?:\.ar)?(?![a-z0-9-])(?:\/[^\s<>"')\]]*)?/gi,
    )
  ) {
    links.add(limpiarUrl(m[0]));
  }

  return [...links];
}

export function extraerMails(texto: string): string[] {
  return [
    ...texto.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi),
  ].map((m) => m[0].toLowerCase().replace(/\.+$/, ""));
}

const CONECTORES_ALIAS = new Set([
  "es",
  "el",
  "la",
  "de",
  "del",
  "para",
  "transferir",
  "transferencia",
  "sena",
  "pago",
  "nuestro",
  "mi",
  "a",
  "al",
]);

/**
 * "alias MELIDERMATO", "el alias es meli.dermato", "Alias para transferir la
 * seña: MELIDERMATO" → el primer token después de "alias" que no sea un
 * conector, en minúscula.
 */
export function extraerAlias(texto: string): string[] {
  const alias: string[] = [];

  for (const m of normalizar(texto).matchAll(/\balias\b([^\n]{0,60})/g)) {
    const token = m[1]
      .split(/[\s:,()]+/)
      .map((t) => t.replace(/[.!?;]+$/, ""))
      .find((t) => t && !CONECTORES_ALIAS.has(t));

    if (token && /^[a-z0-9][a-z0-9.-]{2,19}$/.test(token)) alias.push(token);
  }

  return alias;
}

/** CBU/CVU: 22 dígitos, con o sin espacios/guiones entre bloques. */
function extraerCuentas(texto: string): string[] {
  return [...normalizar(texto).matchAll(/\b(?:\d[\s-]?){21}\d\b/g)].map((m) =>
    m[0].replace(/\D/g, "")
  );
}

// ─────────────────────────────── verificación ───────────────────────────────

/**
 * Desde cuántos tratamientos distintos con precio un mensaje cuenta como "la
 * lista de precios" (prohibida). Decisión de Santi 2026-09-29: dar el precio
 * de 2, 3 o 4 tratamientos en un mismo mensaje está bien (ej. "la consulta
 * sale $X y el PRP $Y" al agendar); lo que no se manda es la lista completa.
 */
const MIN_TRATAMIENTOS_LISTA_PRECIOS = 5;

const NEGACION = /\b(no|sin|ningun|ninguna|nada|lleno|completo|agotad[oa])\b/;

interface Clausula {
  texto: string;
  /** Fechas nombradas en la cláusula. */
  fechasPropias: FechaEnTexto[];
  /** Las propias o, si no nombra ninguna, las de la cláusula anterior del mismo segmento. */
  fechas: FechaEnTexto[];
  horas: string[];
}

/**
 * Parte un segmento en cláusulas y asocia cada hora a la fecha más cercana
 * hacia atrás: "el 22/10 tengo 10:00, 11:30" → las dos horas son del 22/10;
 * "el 21/10 no tengo lugar, pero el 22/10 tengo 10:00" → el 21/10 no queda
 * pegado a las 10:00.
 */
function clausulas(segmento: string, ahora: Date): Clausula[] {
  const resultado: Clausula[] = [];
  let arrastre: FechaEnTexto[] = [];

  for (const texto of segmento.split(/,\s*|\s+pero\s+|;\s*/)) {
    const fechasPropias = extraerFechas(texto, ahora);

    if (fechasPropias.length) arrastre = fechasPropias;

    resultado.push({
      texto,
      fechasPropias,
      fechas: arrastre,
      horas: extraerHoras(texto),
    });
  }

  return resultado;
}

interface IndiceTurnos {
  /** "DD/MM" → horas respaldadas para ese día. */
  horasPorFecha: Map<string, Set<string>>;
  fechasConocidas: Set<string>;
  fechasSinLugar: Set<string>;
  horasGlobales: Set<string>;
  horasFaq: Set<string>;
}

function indexarTurnos(f: FuentesVerificacion): IndiceTurnos {
  const horasPorFecha = new Map<string, Set<string>>();
  const fechasConocidas = new Set<string>();
  const fechasSinLugar = new Set<string>();
  const horasFaq = new Set<string>(extraerHoras(f.faq));
  const horasGlobales = new Set<string>(horasFaq);

  for (const texto of [f.evidencia, f.textoBotPrevio]) {
    for (const seg of segmentos(texto)) {
      for (const c of clausulas(seg, f.ahora)) {
        c.horas.forEach((h) => horasGlobales.add(h));

        for (const fecha of c.fechas) {
          fechasConocidas.add(fecha.clave);
          if (!horasPorFecha.has(fecha.clave)) {
            horasPorFecha.set(fecha.clave, new Set());
          }
          c.horas.forEach((h) => horasPorFecha.get(fecha.clave)!.add(h));
        }
      }
    }
  }

  for (const seg of segmentos(f.evidencia)) {
    if (/sin lugar|no hay ningun horario/.test(normalizar(seg))) {
      extraerFechas(seg, f.ahora).forEach((x) => fechasSinLugar.add(x.clave));
    }
  }

  extraerFechas(f.textoPaciente, f.ahora).forEach((x) =>
    fechasConocidas.add(x.clave)
  );

  return {
    horasPorFecha,
    fechasConocidas,
    fechasSinLugar,
    horasGlobales,
    horasFaq,
  };
}

/**
 * Devuelve los datos del borrador SIN respaldo en las fuentes. Vacío = ok.
 *
 * Límites conocidos (van al juez o quedan como riesgo aceptado): montos
 * escritos en letras ("ciento cincuenta mil"), horas en letras ("a las
 * once"), y afirmar lugar en un día sin nombrar ninguna hora ni fecha.
 */
export function verificarBorrador(
  borrador: string,
  fuentes: FuentesVerificacion,
): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  const catalogo = parsearCatalogo(fuentes.catalogo);
  const montosFaq = new Set(extraerMontos(fuentes.faq).map((m) => m.valor));
  const montosGlobales = new Set<number>([
    ...montosFaq,
    ...extraerMontos(fuentes.catalogo).map((m) => m.valor),
    ...extraerMontos(fuentes.evidencia).map((m) => m.valor),
  ]);
  const turnos = indexarTurnos(fuentes);
  const familiasConPrecio = new Set<string>();

  for (const seg of segmentos(borrador)) {
    // ── Precios ──
    const familias = familiasMencionadas(seg, catalogo);

    for (const monto of extraerMontos(seg)) {
      if (montosFaq.has(monto.valor)) continue;

      if (familias.size) {
        const validas = [...familias].filter((fam) =>
          catalogo.preciosPorFamilia.get(fam)?.has(monto.valor)
        );

        if (!validas.length) {
          hallazgos.push({
            tipo: "precio",
            valor: monto.texto,
            motivo:
              `El precio ${monto.texto} no corresponde a ningún precio del catálogo para ${
                [...familias].join(" / ")
              }.`,
          });
        } else {
          validas.forEach((fam) => familiasConPrecio.add(fam));
        }
      } else if (!montosGlobales.has(monto.valor)) {
        hallazgos.push({
          tipo: "precio",
          valor: monto.texto,
          motivo:
            `El monto ${monto.texto} no figura en el catálogo ni en la FAQ.`,
        });
      }
    }

    // ── Fechas y horas ──
    for (const c of clausulas(seg, fuentes.ahora)) {
      for (const fecha of c.fechasPropias) {
        if (fecha.diaSemana) {
          const anio = fecha.anio ??
            inferirAnio(fecha.dia, fecha.mes, fuentes.ahora);
          const real = diaSemanaDe(anio, fecha.mes, fecha.dia);

          if (real !== fecha.diaSemana) {
            hallazgos.push({
              tipo: "dia_semana",
              valor: fecha.texto,
              motivo:
                `El ${fecha.clave}/${anio} es ${real}, no ${fecha.diaSemana}.`,
            });
          }
        }

        // "¿En qué te puedo ayudar hoy?" no afirma nada: un "hoy"/"mañana"
        // suelto solo importa si va con una hora (se chequea más abajo).
        if (!fecha.relativa && !turnos.fechasConocidas.has(fecha.clave)) {
          hallazgos.push({
            tipo: "fecha",
            valor: fecha.texto,
            motivo:
              `La fecha ${fecha.clave} no figura en la evidencia de Calendly ni en la conversación.`,
          });
        }

        if (
          turnos.fechasSinLugar.has(fecha.clave) &&
          (c.horas.length || !NEGACION.test(normalizar(c.texto)))
        ) {
          hallazgos.push({
            tipo: "dia_sin_lugar",
            valor: fecha.texto,
            motivo:
              `Calendly indica que el ${fecha.clave} está SIN LUGAR; el borrador ofrece o afirma lugar ese día.`,
          });
        }
      }

      if (!c.horas.length) continue;

      let permitidas: Set<string>;
      let donde: string;

      if (c.fechas.length) {
        permitidas = new Set(
          c.fechas.flatMap((f) => [
            ...(turnos.horasPorFecha.get(f.clave) ?? []),
          ]),
        );
        donde = `para el ${
          c.fechas.map((f) => f.clave).join(" / ")
        } en la evidencia de Calendly`;
      } else {
        // Sin fecha: día de semana suelto ("el jueves a las 10") o nada.
        const dias = diasSemanaSueltos(seg);
        const candidatas = [...turnos.horasPorFecha.keys()].filter((k) => {
          const [d, m] = k.split("/").map(Number);
          return dias.includes(
            diaSemanaDe(inferirAnio(d, m, fuentes.ahora), m, d),
          );
        });

        permitidas = candidatas.length
          ? new Set([
            ...turnos.horasFaq,
            ...candidatas.flatMap((k) => [...turnos.horasPorFecha.get(k)!]),
          ])
          : turnos.horasGlobales;
        donde = candidatas.length
          ? `para el ${dias.join("/")} en la evidencia de Calendly`
          : "en la evidencia de Calendly ni en la FAQ";
      }

      for (const hora of c.horas) {
        if (!permitidas.has(hora)) {
          hallazgos.push({
            tipo: "hora",
            valor: hora,
            motivo: `La hora ${hora} no figura ${donde}.`,
          });
        }
      }
    }
  }

  if (familiasConPrecio.size >= MIN_TRATAMIENTOS_LISTA_PRECIOS) {
    hallazgos.push({
      tipo: "lista_precios",
      valor: [...familiasConPrecio].join(", "),
      motivo:
        `El borrador da precios de ${familiasConPrecio.size} tratamientos distintos: eso ya es la lista de precios, que no se manda.`,
    });
  }

  // ── Links ──
  const linksOk = new Set([
    ...fuentes.linksPermitidos,
    ...extraerLinks(fuentes.evidencia),
  ]);

  for (const link of extraerLinks(borrador)) {
    if (!linksOk.has(link)) {
      hallazgos.push({
        tipo: "link",
        valor: link,
        motivo:
          `El link ${link} no es ninguno de los autorizados (tiene que ser idéntico, carácter por carácter).`,
      });
    }
  }

  // ── Datos para transferir: un alias o CBU inventado es plata que se va a
  // otra cuenta. Solo vale el de la FAQ, idéntico. ──
  const aliasOk = new Set(extraerAlias(fuentes.faq));
  const cuentasOk = new Set(extraerCuentas(fuentes.faq));

  for (const alias of extraerAlias(borrador)) {
    if (!aliasOk.has(alias)) {
      hallazgos.push({
        tipo: "dato_de_pago",
        valor: alias,
        motivo: `El alias ${alias} no es el alias autorizado para transferir.`,
      });
    }
  }

  for (const cuenta of extraerCuentas(borrador)) {
    if (!cuentasOk.has(cuenta)) {
      hallazgos.push({
        tipo: "dato_de_pago",
        valor: cuenta,
        motivo: "El borrador incluye un CBU/CVU que no está autorizado.",
      });
    }
  }

  // ── Mails ──
  const mailsOk = new Set(
    [
      ...fuentes.mailsPermitidos,
      ...extraerMails(fuentes.evidencia),
      ...extraerMails(fuentes.textoPaciente),
    ].map((m) => m.toLowerCase()),
  );

  for (const mail of extraerMails(borrador)) {
    if (!mailsOk.has(mail)) {
      hallazgos.push({
        tipo: "mail",
        valor: mail,
        motivo:
          `El mail ${mail} no es el de la doctora ni uno que haya dado la paciente.`,
      });
    }
  }

  return hallazgos;
}

/** Texto para el paso de reescritura (mismo rol que el `motivo` del juez). */
export function motivoDeHallazgos(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => h.motivo).join(" ");
}
