/**
 * Catálogo autorizado del bot.
 *
 * Los PRECIOS no viven acá: viven en `public.precios_vigentes` (mismo proyecto
 * Supabase, `velvet-agent`), que se sincroniza sola cada vez que Meli edita el
 * Google Sheets vía el trigger `onEditPrecios` de apps_script/Precios.gs. Este
 * módulo los lee en cada mensaje, así un cambio de precio impacta al toque sin
 * necesidad de redeployar la Edge Function.
 *
 * Las DESCRIPCIONES de tratamiento sí viven acá, en `FAMILIAS_TRATAMIENTO` —
 * son texto literal reorganizado del documento de Meli (ver
 * `proyectos/P05_catalogo_agente_meli.md` en el repo `consultorio_dermatologico`,
 * que es la base para la próxima actualización cuando Meli edite el original).
 *
 * ══════════════════════════════════════════════════════════════════
 * Filosofía de habilitación (decisión de Santi, 2026-08-02)
 * ══════════════════════════════════════════════════════════════════
 * "Lo que tenés precio, tenés precio": TODOS los servicios de
 * `precios_vigentes` están habilitados para decir su precio. Los que además
 * tienen una familia documentada en `FAMILIAS_TRATAMIENTO` también pueden
 * explicar de qué se trata; los que no, el bot dice SOLO el precio, nunca
 * inventa una descripción.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../../_shared/logger.ts";

/**
 * Todos los servicios que el consultorio cobra hoy (32, confirmado contra
 * `precios_vigentes` el 2026-08-02). Es la lista de PRECIOS habilitados, no de
 * descripciones — ver `FAMILIAS_TRATAMIENTO` para qué subconjunto además tiene
 * descripción autorizada.
 *
 * Si Meli agrega un servicio nuevo en el Sheets, hay que sumarlo acá a mano
 * (fail-closed a propósito: un servicio nuevo no habilitado simplemente no
 * aparece, no se inventa nada).
 */
export const SERVICIOS_HABILITADOS: string[] = [
  // Alma - IPL / NIR
  "IPL escote",
  "IPL facial",
  "NIR corporal",
  "NIR facial",
  // PRP
  "PRP facial",
  "PRP capilar",
  "Promo PRP capilar + cara",
  // Botox
  "Botox maceteros",
  "Botox tercio superior",
  // Bioestimuladores
  "Radiesse",
  "HarmonyCa",
  // Skinbooster
  "Skinvive",
  "SBL (Futerman)",
  "SBL Ac. hialurónico 64 mg",
  "SBL PDRN-M",
  "SBL Relax",
  // Rellenos
  "Rellenos labios",
  "Rellenos mentón",
  "Rellenos pómulos",
  "Armonización facial",
  "Rinomodelación",
  // Peeling
  "Peeling superficial",
  "Peeling profundo",
  // Mesoterapia
  "Mesoterapia capilar",
  "Mesoterapia corporal",
  // Mesopeeling
  "Mesopeeling - Ácido hialurónico",
  "Mesopeeling - Mesobotox",
  "Mesopeeling - Peptonas",
  "Mesopeeling - Plasma rico",
  // Otros (sin familia documentada todavía)
  "Meso francesa NCTH",
  "Celutrix (sesión)",
  "Consulta médica",
];

/** Una familia de tratamiento con descripción autorizada. */
export interface FamiliaTratamiento {
  /** Título para agrupar en el prompt. */
  nombre: string;
  /**
   * Nombres de servicio (columna `servicio` de `precios_vigentes`) que
   * pertenecen a esta familia. Se matchea normalizado (sin tildes/mayúsculas).
   */
  servicios: string[];
  /**
   * Texto autorizado: qué es, para qué sirve, cuidados previos y
   * posteriores. Literal — el redactor solo puede citar esto, no agregar
   * nada. Condensado del documento original de Meli.
   */
  descripcion: string;
}

/**
 * ⚠️ PENDIENTE PARA MELI (no resuelto a propósito, ver
 * `PENDIENTES.md` → `[CATALOGO-AGENTE-SKU]`):
 *
 * - "Peeling" y "Rellenos" tienen varias variantes con precio propio (zonas,
 *   profundidad) pero el documento de Meli las explica de forma genérica, sin
 *   decir qué variante corresponde a qué caso — eso se define en la consulta
 *   médica. Por eso acá se les pone la MISMA descripción general a todas las
 *   variantes de la familia: es seguro (no inventa nada específico por zona),
 *   pero no es preciso. Cuando Meli aclare el detalle por variante, hay que
 *   separar la familia en descripciones más finas.
 * - "Meso francesa NCTH" en `precios_vigentes` probablemente es un typo de
 *   "NCTF®" (New Cellular Treatment Factor, documentado por Meli), pero no se
 *   asumió el match — queda sin familia (solo precio) hasta confirmar.
 * - "SBL Ac. hialurónico 64 mg", "SBL PDRN-M" y "SBL Relax" son variantes de
 *   Skinbooster distintas de "SBL (Futerman)" (la única que Meli documentó
 *   como "SkinBuilder® Filler") — quedan sin familia (solo precio) hasta que
 *   Meli las documente.
 */
export const FAMILIAS_TRATAMIENTO: FamiliaTratamiento[] = [
  {
    // Nombre deliberadamente genérico: "Alma"/"Alma Rejuve" es la marca del
    // equipo alquilado, un detalle logístico interno (de eso depende qué
    // días se puede agendar, ver `resolverTipoTurno`) que no le sirve de
    // nada a la paciente y generaba confusión — el bot llegó a inventar
    // "se realiza en días de jornada Alma" (2026-08-08, ver
    // `PLAN_FIX_BIENVENIDA_CONTEXTO.md`). El nombre de la familia es
    // contenido literal que el redactor puede citar tal cual, así que no
    // alcanza con instruir "no lo menciones" — hay que sacarle la marca de
    // acá directamente.
    nombre: "IPL/NIR (Luz Pulsada Intensa)",
    servicios: ["IPL escote", "IPL facial", "NIR corporal", "NIR facial"],
    descripcion:
      `Tecnología de luz pulsada intensa (IPL) de Alma para mejorar la calidad de la piel: manchas solares, léntigos, pecas, rosácea, enrojecimiento facial, telangiectasias, poros dilatados, fotoenvejecimiento y acné inflamatorio leve a moderado. El NIR (infrarrojo cercano) trata flacidez leve y mejora la firmeza de la piel en rostro, cuello y escote.
Sesión: 20-40 minutos, con anestesia tópica previa. IPL: 3-5 sesiones cada 3-4 semanas. NIR: 6-12 sesiones, frecuencia semanal o mensual.
Cuidados previos: evitar sol intenso y no concurrir con la piel bronceada, usar protector solar a diario, informar medicación y tratamientos estéticos recientes.
Cuidados posteriores: se puede retomar la actividad normal el mismo día; hidratar la piel; usar protector solar FPS 50+ renovándolo cada 4 hs; evitar ácidos (glicólico, retinoico, salicílico) y exfoliación mecánica durante 5-7 días. Es esperable enrojecimiento leve, sensación de calor, oscurecimiento transitorio de manchas con pequeñas costras (resuelven en 7-14 días) e hinchazón de párpados 1-3 días si se usa el cabezal vascular.`,
  },
  {
    nombre: "Plasma Rico en Plaquetas (PRP) — Facial y Capilar",
    servicios: ["PRP facial", "PRP capilar", "Promo PRP capilar + cara"],
    descripcion:
      `Se extrae sangre propia de la paciente, se centrifuga para obtener el plasma rico en plaquetas y se aplica mediante microinyecciones para estimular la regeneración de los tejidos. Es biocompatible, con bajo riesgo de alergia o rechazo (material autólogo).
PRP facial: mejora la luminosidad, firmeza e hidratación de la piel; no reemplaza un relleno con ácido hialurónico ni la toxina botulínica.
PRP capilar: estimula folículos que aún tienen actividad (no genera folículos nuevos); indicado para alopecia androgenética, efluvio telógeno y cabello fino/debilitado.
Sesión: 30-60 minutos. Facial: 3 sesiones iniciales cada 30 días, mantenimiento cada 6-12 meses. Capilar: 3-4 sesiones iniciales cada ~1 mes, mantenimiento cada 4-6 meses.
Cuidados previos: llegar hidratada y no en ayunas, evitar alcohol las 24 hs previas, avisar si toma anticoagulantes o tiene infecciones activas o fiebre.
Cuidados posteriores (primeras 24 hs): no maquillarse (facial) o no lavar el cabello (capilar), no tocar ni masajear la zona, evitar sol, ejercicio intenso, sauna y calor. Es esperable enrojecimiento, hematomas puntuales y pequeñas pápulas que resuelven entre 24 y 72 hs.`,
  },
  {
    nombre: "Toxina Botulínica (Botox)",
    servicios: ["Botox maceteros", "Botox tercio superior"],
    descripcion:
      `Suaviza arrugas dinámicas (entrecejo, frente, patas de gallo, código de barras alrededor de los labios, bandas del cuello) relajando temporalmente los músculos tratados, sin perder la movilidad facial. También se usa para bruxismo/aumento del masetero y para sudoración excesiva (hiperhidrosis) en axilas, manos o pies.
Sesión: 15-30 minutos, ambulatoria, sin reposo.
Resultados: los primeros cambios se ven a los 3-5 días, el máximo a los 10-14 días; dura entre 3 y 5 meses según metabolismo, zona y dosis.
Cuidados previos: informar uso de anticoagulantes o antiagregantes, evitar alcohol en las horas previas, no aplicar si hay infección activa en la zona.
Cuidados posteriores: no masajear ni presionar la zona tratada, evitar recostarse por completo las primeras 4 hs, evitar ejercicio intenso ese día y calor intenso (sauna, vapor, sol) las primeras 24 hs. Es esperable enrojecimiento leve, hematomas y sensación de tensión transitoria.`,
  },
  {
    nombre: "Radiesse® (Hidroxiapatita de Calcio)",
    servicios: ["Radiesse"],
    descripcion:
      `Bioestimulador de colágeno (microesferas de hidroxiapatita de calcio) que mejora firmeza y estructura de la piel — a diferencia de un relleno tradicional, su objetivo principal no es aportar volumen. Se aplica en mejillas, línea mandibular, mentón, cuello, escote y dorso de manos; también puede usarse hiperdiluido para mejorar calidad de piel sin buscar volumen.
Sesión: 30-60 minutos, con anestesia local o crema anestésica.
Resultados: mejoría progresiva desde las primeras semanas, evolucionando 3-6 meses; el efecto dura entre 12 y 24 meses. Habitualmente 1 sesión inicial, eventuales sesiones complementarias y mantenimiento periódico.
Cuidados previos: informar antecedentes médicos y anticoagulantes/antiagregantes, evitar alcohol 24 hs antes, no aplicar si hay infección activa en la zona.
Cuidados posteriores (24-48 hs): no tocar, presionar ni masajear la zona, evitar ejercicio intenso, sauna/vapor/calor intenso y alcohol; luego, protector solar diario y buena hidratación.`,
  },
  {
    nombre: "HarmonyCa™ (Ácido Hialurónico + Hidroxiapatita de Calcio)",
    servicios: ["HarmonyCa"],
    descripcion:
      `Inyectable híbrido que combina ácido hialurónico (soporte y volumen inmediato) con hidroxiapatita de calcio (bioestimulación de colágeno a largo plazo). Se aplica en mejillas, zona malar, línea mandibular y mentón para recuperar soporte facial y mejorar la flacidez leve a moderada.
Sesión: 30-60 minutos, con anestesia local o crema anestésica.
Resultados: efecto inicial inmediato por el ácido hialurónico, más una mejora progresiva en las semanas/meses siguientes por la estimulación de colágeno; dura aproximadamente 12-18 meses.
Cuidados previos: informar antecedentes médicos y anticoagulantes, evitar alcohol 24 hs antes, no aplicar si hay infección activa.
Cuidados posteriores (24-48 hs): no tocar, presionar ni masajear la zona, evitar ejercicio intenso, sol y calor intenso; luego, protector solar diario.`,
  },
  {
    nombre: "Skinvive™ by Juvéderm® (Ácido Hialurónico Intradérmico)",
    servicios: ["Skinvive"],
    descripcion:
      `Ácido hialurónico de baja concentración aplicado en la dermis superficial de las mejillas para mejorar hidratación, suavidad y luminosidad — no aporta volumen ni cambia la forma del rostro.
Sesión: 20-40 minutos, con anestesia tópica.
Resultados: progresivos, se aprecian entre 1 y 3 meses; el efecto dura entre 4 y 6 meses.
Cuidados previos: informar antecedentes médicos y anticoagulantes, evitar alcohol 24 hs antes, no aplicar si hay infección o lesión activa en la zona.
Cuidados posteriores (24-48 hs): no tocar ni masajear la zona, evitar ejercicio intenso, sol y calor excesivo; luego, protector solar diario.`,
  },
  {
    nombre: "SkinBuilder® Filler (Futerman) — Bioestimulación Cutánea",
    servicios: ["SBL (Futerman)"],
    descripcion:
      `Inyectable de bioestimulación para piel deshidratada, con pérdida de luminosidad o primeros signos de envejecimiento — mejora hidratación, elasticidad y textura sin agregar volumen ni modificar los rasgos faciales. Se aplica en rostro, cuello, escote y dorso de manos.
Sesión: 30-45 minutos, con anestesia tópica.
Resultados: progresivos, mejora gradual de hidratación y textura desde las primeras semanas.
Cuidados previos: informar antecedentes médicos y anticoagulantes, evitar alcohol 24 hs antes, no aplicar si hay infección activa.
Cuidados posteriores (24-48 hs): no tocar ni masajear la zona, evitar ejercicio intenso, sol y calor excesivo; luego, protector solar FPS 50+ diario.`,
  },
  {
    nombre: "Rellenos Faciales con Ácido Hialurónico Allergan™ (Juvéderm®)",
    servicios: [
      "Rellenos labios",
      "Rellenos mentón",
      "Rellenos pómulos",
      "Armonización facial",
      "Rinomodelación",
    ],
    descripcion:
      `Rellenos de ácido hialurónico de la línea Juvéderm® para restaurar volumen y armonizar contornos faciales — labios, pómulos, mentón, línea mandibular, surcos nasogenianos, ojeras y líneas periorales, según la zona y el producto indicado en la evaluación médica. Resultado inmediato; muchos productos incluyen lidocaína para mejorar el confort.
Sesión: 30-60 minutos.
Resultados: visibles de inmediato (con inflamación inicial que puede modificarlo temporalmente); el resultado definitivo se aprecia entre 1 y 2 semanas. Dura entre 9 y 18 meses según producto y zona. El ácido hialurónico puede revertirse con una enzima específica (hialuronidasa) si hiciera falta.
Cuidados previos: informar antecedentes médicos y anticoagulantes, evitar alcohol 24 hs antes, no aplicar si hay infección, herpes activo o lesiones en la zona.
Cuidados posteriores (24-48 hs): no tocar, presionar ni masajear la zona, evitar ejercicio intenso, sol y calor intenso; luego, protector solar diario.
⚠️ Cada zona (labios, mentón, pómulos, armonización facial, rinomodelación) tiene su propio precio — el detalle exacto de qué producto/técnica corresponde a cada caso se define en la consulta médica.`,
  },
  {
    nombre: "Peeling Químico Facial",
    servicios: ["Peeling superficial", "Peeling profundo"],
    descripcion:
      `Aplicación controlada de ácidos sobre la piel para producir una renovación celular — mejora manchas, textura, acné, líneas finas y signos de fotoenvejecimiento. Existen distintas profundidades y tipos de ácido; cuál corresponde a cada caso se define en la consulta médica según el diagnóstico y tipo de piel.
Sesión: 20-45 minutos.
Resultados: progresivos, la piel se ve más luminosa y suave desde los primeros días; la cantidad de sesiones se define según el objetivo (luminosidad, manchas, acné, fotoenvejecimiento).
Cuidados previos: informar antecedentes médicos, evitar exposición solar intensa previa, no realizar si hay infección, heridas o irritación activa en la zona.
Cuidados posteriores: protector solar FPS 50+ todos los días, no despegar ni acelerar la descamación, evitar exfoliantes/retinoides/ácidos los primeros días. Es esperable enrojecimiento leve, tirantez y descamación superficial transitoria (varía según la profundidad del peeling).
⚠️ "Superficial" y "profundo" tienen precio propio — cuál corresponde a cada caso se define en la consulta médica, no por lo que pida la paciente.`,
  },
  {
    nombre: "Mesoterapia — Facial y Capilar",
    servicios: ["Mesoterapia capilar", "Mesoterapia corporal"],
    descripcion:
      `Microinyecciones de vitaminas, minerales, aminoácidos, ácido hialurónico no reticulado y antioxidantes para hidratar y regenerar la piel (facial/corporal) o el cuero cabelludo (capilar). La mesoterapia capilar no genera folículos nuevos: estimula los que todavía tienen actividad.
Sesión: 30-45 minutos.
Resultados: en piel, mejora de hidratación y luminosidad desde las primeras semanas; en cuero cabelludo, los cambios se notan recién luego de varios meses.
Cuidados previos: informar antecedentes médicos y anticoagulantes, evitar alcohol 24 hs antes; para la variante capilar, asistir con el cuero cabelludo limpio.
Cuidados posteriores (primeras 24 hs): no tocar ni masajear la zona, evitar ejercicio intenso, sauna y sol; en piel, sin maquillaje el tiempo indicado; en cuero cabelludo, sin lavar el pelo las primeras horas.`,
  },
];

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
 *
 * Confirmado por Santi 2026-08-02: es `.com`, SIN `.ar` — el documento de
 * Meli (Google Doc origen del catálogo) tiene un typo con `.com.ar` en dos
 * lugares, pendiente de que ella lo corrija ahí.
 */
export const MAIL_CONSULTAS = "dra.melisa.altavista@gmail.com";

/**
 * Preguntas frecuentes OPERATIVAS del consultorio (no son tratamientos).
 * Texto literal, reorganizado del documento de Meli — ver
 * `proyectos/P05_catalogo_agente_meli.md` §1.4 en el repo `consultorio_dermatologico`.
 *
 * Agregado 2026-08-02 a pedido explícito de Santi ("agregarla ahora"). Fuente
 * autorizada para el nuevo tipo de respuesta `faq` en `prompts.ts`.
 *
 * OJO: preguntas sobre el ESTADO de un turno puntual de una paciente ("¿quedó
 * bien agendado mi turno?", "no recuerdo el día/horario") NO están acá a
 * propósito — necesitarían consultar Calendly en vivo con los datos de la
 * paciente, y el guardrail hoy no llama herramientas. Queda pendiente (ver
 * PENDIENTES.md → `[AGENTE-IA-WSP-IG]`).
 */
export const FAQ_OPERATIVA = `
- Días y horarios de atención: miércoles de 10 a 15 hs y jueves de 14 a 19 hs.
- Días y horarios de jornadas especiales (IPL, Botox Party, etc.): se actualizan mes a mes — si preguntan por una jornada especial y no tenés la fecha, no inventes, decí que no disponés de esa información todavía.
- Modalidad de atención: presencial y virtual.
- Dirección del consultorio: Uruguay 1061, 4to piso, depto 57, Recoleta, CABA.
- Estacionamiento: valet parking en la entrada del edificio, es pago.
- Medios de pago: efectivo, transferencia y tarjetas (con recargo).
- Duración aproximada de la consulta: 30 minutos.
- Contacto de la Dra. Melisa para consultas médicas: ${MAIL_CONSULTAS}.
- Política de cancelación: cancelar con 24 hs de anticipación; si no se cancela a tiempo, se cobra el equivalente a un turno de consulta médica. El consultorio se reserva el derecho de admisión.
- Seña para reservar turno de IPL/NIR: $50.000.
- Seña para reservar turno de consulta médica: $20.000.
- Alias para transferir la seña: MELIDERMATO (Brubank).
`.trim();

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

/** Precio + promo + notas de una fila, sin el nombre del servicio adelante. */
function formatearDetallePrecio(row: PrecioRow): string {
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

  return partes.join(". ");
}

/** Una línea de texto por servicio (con categoría), para el bloque "otros". */
function formatearFila(row: PrecioRow): string {
  const encabezado = row.categoria
    ? `${row.servicio} (${row.categoria})`
    : row.servicio;

  return `- ${encabezado}: ${formatearDetallePrecio(row)}`;
}

export interface CatalogoCargado {
  /** Texto listo para inyectar en los prompts. Vacío si no hay nada habilitado. */
  texto: string;
  /** Cuántos servicios quedaron efectivamente habilitados. */
  cantidad: number;
}

/**
 * Trae de `public.precios_vigentes` los servicios habilitados y arma el texto
 * del catálogo, agrupado por familia documentada (con descripción + todas sus
 * variantes de precio) y con un bloque final "otros servicios" para los que
 * solo tienen precio, sin descripción autorizada.
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

  const usados = new Set<string>();
  const bloques: string[] = [];

  for (const familia of FAMILIAS_TRATAMIENTO) {
    const serviciosFamilia = new Set(familia.servicios.map(normalizar));

    const filasFamilia = seleccionadas
      .filter((row) => serviciosFamilia.has(normalizar(row.servicio)))
      .sort((a, b) => a.servicio.localeCompare(b.servicio, "es"));

    if (!filasFamilia.length) continue;

    filasFamilia.forEach((row) => usados.add(normalizar(row.servicio)));

    const precios = filasFamilia
      .map((row) => `- ${row.servicio}: ${formatearDetallePrecio(row)}`)
      .join("\n");

    bloques.push(
      `### ${familia.nombre}\n${familia.descripcion}\n\nPrecios:\n${precios}`,
    );
  }

  const resto = seleccionadas
    .filter((row) => !usados.has(normalizar(row.servicio)))
    .sort((a, b) =>
      (a.categoria ?? "").localeCompare(b.categoria ?? "", "es") ||
      a.servicio.localeCompare(b.servicio, "es")
    );

  if (resto.length) {
    bloques.push(
      `### Otros servicios (SIN descripción autorizada — decí SOLO el precio, nunca expliques de qué se trata ni para qué sirve)\n${
        resto.map(formatearFila).join("\n")
      }`,
    );
  }

  return { texto: bloques.join("\n\n"), cantidad: seleccionadas.length };
}
