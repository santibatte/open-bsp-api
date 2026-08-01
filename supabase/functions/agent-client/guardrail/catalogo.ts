/**
 * Catálogo autorizado del bot.
 *
 * Los PRECIOS no viven acá: viven en `public.precios_vigentes` (mismo proyecto
 * Supabase, `velvet-agent`), que se sincroniza sola cada vez que Meli edita el
 * Google Sheets vía el trigger `onEditPrecios` de apps_script/Precios.gs. Este
 * módulo los lee en cada mensaje, así un cambio de precio impacta al toque sin
 * necesidad de redeployar la Edge Function.
 *
 * ══════════════════════════════════════════════════════════════════
 * LO ÚNICO QUE FALTA EDITAR A MANO ACÁ: SERVICIOS_HABILITADOS
 * ══════════════════════════════════════════════════════════════════
 *
 * `precios_vigentes` tiene los 32 servicios que el consultorio cobra. Eso NO
 * significa que el bot pueda hablar de los 32. `SERVICIOS_HABILITADOS` es la
 * lista curada de cuáles tiene permitido mencionar — el filtro de "estos sí, el
 * resto no aunque estén en la tabla de precios".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../../_shared/logger.ts";

/**
 * Lista curada de servicios que el bot puede mencionar.
 *
 * Se matchea contra la columna `servicio` de `public.precios_vigentes`,
 * ignorando mayúsculas, tildes y espacios de más — así un retoque de tipeo en
 * el Sheets no rompe el match.
 *
 * ⚠️ PENDIENTE: Santi todavía no pasó la lista curada. Mientras esté vacía, el
 * guardrail no contesta nada (fail-closed) — ver `guardrailListo()`. Es a
 * propósito: la alternativa sería habilitar los 32 por defecto, y "el bot habla
 * de todo salvo que alguien se acuerde de restringirlo" es exactamente el
 * default peligroso que esta feature existe para evitar.
 *
 * Para activar: poné acá los nombres tal como figuran en la columna `servicio`.
 *   export const SERVICIOS_HABILITADOS: string[] = [
 *     "Consulta médica",
 *     "PRP facial",
 *   ];
 */
export const SERVICIOS_HABILITADOS: string[] = [];

/**
 * Link de Calendly para agendar consulta. Se usa en el mensaje de tipo
 * `saludo_generico`.
 *
 * Es el event type genérico de 30 min ("Turno Dermatología - Dra. Melisa
 * Altavista"), NO los links de promo específicos — esos cambian por campaña y
 * el bot no tiene forma de saber cuál corresponde.
 */
export const CALENDLY_LINK = "https://calendly.com/dra-melisa-altavista/30min";

/** Nombre de la doctora tal como el bot debe presentarse. */
export const NOMBRE_DOCTORA = "Dra. Melisa Altavista";

/**
 * Mail al que se redirige TODO lo que sea consulta médica real: diagnósticos,
 * recetas, preguntas sobre el caso particular de la persona.
 *
 * Decisión explícita de Santi: se redirige a mail, NO a un humano por WhatsApp.
 */
export const MAIL_CONSULTAS = "dra.melisa.altavista@gmail.com";

/**
 * Respuesta fija para mensajes que no son texto (foto, audio, documento).
 *
 * No pasa por redactor ni por juez: es una regla por TIPO de mensaje, no por
 * contenido, así que no hace falta un LLM para decidirla — y por lo tanto
 * tampoco puede inventar nada. Tampoco consume el contador de fuera-de-tema:
 * el contador cuenta preguntas que no sabemos contestar, no formatos que no
 * sabemos leer.
 */
export const MENSAJE_NO_TEXTUAL =
  `Para consultas médicas, diagnósticos o recetas, escribinos directamente a ${MAIL_CONSULTAS} — por acá solo puedo darte información sobre tratamientos.`;

/**
 * true cuando ya está todo lo que se edita a mano. Mientras devuelva false, el
 * guardrail no gasta ni un llamado a Claude y no responde nada.
 */
export function guardrailListo(): boolean {
  return SERVICIOS_HABILITADOS.length > 0;
}

interface PrecioRow {
  servicio: string;
  precio_efectivo: number | null;
  precio_tarjeta: number | null;
  categoria: string | null;
  promo: string | null;
  notas: string | null;
  vigencia_desde: string | null;
}

/** Normaliza para comparar: sin tildes, sin mayúsculas, sin espacios de más. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function formatearPrecio(valor: number | null): string | null {
  if (valor === null || !Number.isFinite(valor)) {
    return null;
  }

  // Formato argentino: $60.000
  return "$" + Math.round(valor).toLocaleString("es-AR");
}

/** Una línea de texto por servicio, para inyectar en los prompts. */
function formatearFila(row: PrecioRow): string {
  const partes: string[] = [];

  const efectivo = formatearPrecio(row.precio_efectivo);
  const tarjeta = formatearPrecio(row.precio_tarjeta);

  if (efectivo && tarjeta) {
    partes.push(
      `${efectivo} en efectivo o transferencia, ${tarjeta} con tarjeta`,
    );
  } else if (efectivo) {
    partes.push(`${efectivo} en efectivo o transferencia`);
  } else if (tarjeta) {
    partes.push(`${tarjeta} con tarjeta`);
  } else {
    partes.push("precio a confirmar en la consulta");
  }

  if (row.promo) {
    partes.push(`Promo: ${row.promo}`);
  }

  if (row.notas) {
    partes.push(row.notas);
  }

  const encabezado = row.categoria
    ? `${row.servicio} (${row.categoria})`
    : row.servicio;

  return `- ${encabezado}: ${partes.join(". ")}`;
}

export interface CatalogoCargado {
  /** Texto listo para inyectar en los prompts. Vacío si no hay nada habilitado. */
  texto: string;
  /** Cuántos servicios quedaron efectivamente habilitados. */
  cantidad: number;
}

/**
 * Trae de `public.precios_vigentes` los servicios habilitados y los devuelve
 * formateados como texto.
 *
 * ── Por qué se traen TODAS las filas de una y no se filtra por lo que preguntó
 * la paciente ──
 *
 * Son ~32 filas: el costo de traerlas es despreciable. Prefiltrar por nombre
 * matcheado necesitaría matching difuso o un llamado extra al modelo, y
 * reintroduce justo la falla que este guardrail existe para evitar: si el
 * prefiltro no encuentra la fila correcta, el redactor se queda sin nada contra
 * qué matchear y manda saludo genérico, quemándole el "pase gratis" a una
 * paciente que preguntó algo que SÍ estaba en el catálogo.
 *
 * Además el juez necesita ver el catálogo COMPLETO igual, porque su trabajo es
 * verificar que cada afirmación tenga respaldo textual: con un catálogo
 * recortado no puede distinguir "esto no está autorizado" de "esto no me lo
 * pasaron".
 */
export async function cargarCatalogo(
  client: SupabaseClient,
  organizationId: string,
): Promise<CatalogoCargado> {
  if (SERVICIOS_HABILITADOS.length === 0) {
    return { texto: "", cantidad: 0 };
  }

  const { data, error } = await client
    .from("precios_vigentes")
    .select(
      "servicio, precio_efectivo, precio_tarjeta, categoria, promo, notas, vigencia_desde",
    )
    .eq("organization_id", organizationId);

  if (error) {
    // El caller lo trata como fail-closed: sin catálogo no se responde nada.
    throw new Error(`No se pudo leer precios_vigentes: ${error.message}`);
  }

  const filas = (data ?? []) as PrecioRow[];

  const habilitados = new Set(SERVICIOS_HABILITADOS.map(normalizar));

  const seleccionadas = filas.filter((row) =>
    habilitados.has(normalizar(row.servicio))
  );

  // Alerta operativa: si Meli renombra un servicio en el Sheets, el nombre de
  // la lista curada deja de matchear y ese tratamiento desaparece del catálogo
  // del bot en silencio. Esto lo hace visible en los logs.
  const encontrados = new Set(
    seleccionadas.map((row) => normalizar(row.servicio)),
  );

  const sinMatch = SERVICIOS_HABILITADOS.filter(
    (nombre) => !encontrados.has(normalizar(nombre)),
  );

  if (sinMatch.length) {
    log.warn(
      "Servicios habilitados que no matchean ninguna fila de precios_vigentes (¿los renombraron en el Sheets?)",
      sinMatch,
    );
  }

  // Orden estable por categoría y nombre, para que el prompt no cambie de forma
  // entre mensajes sin motivo.
  seleccionadas.sort((a, b) =>
    (a.categoria ?? "").localeCompare(b.categoria ?? "", "es") ||
    a.servicio.localeCompare(b.servicio, "es")
  );

  return {
    texto: seleccionadas.map(formatearFila).join("\n"),
    cantidad: seleccionadas.length,
  };
}
