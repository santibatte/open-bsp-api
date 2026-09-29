/**
 * Tests del verificador determinista. Dos familias de casos:
 *  - PASA: respuestas correctas que el juez-LLM rechazó alguna vez en
 *    producción (falsos positivos) o frases literales del catálogo que un
 *    verificador ingenuo confundiría con horas o precios.
 *  - FALLA: intentos adversariales de colar un dato sin respaldo (precio
 *    cambiado de tratamiento, "90 lucas", dígitos Unicode, link parecido,
 *    hora real de OTRO día, día sin lugar, día de semana mal calculado...).
 *
 * Correr: deno test --config deno.json --allow-read --allow-env \
 *   agent-client/guardrail/verificador_test.ts
 */

import { assertEquals } from "jsr:@std/assert@1";
import { CALENDLY_LINK, FAQ_OPERATIVA, MAIL_CONSULTAS } from "./catalogo.ts";
import {
  extraerHoras,
  extraerMontos,
  type FuentesVerificacion,
  type TipoHallazgo,
  verificarBorrador,
} from "./verificador.ts";

// Mismo formato que `cargarCatalogo` (catalogo.ts), con precios distintos por
// familia para poder detectar un precio cambiado de tratamiento.
const CATALOGO = `### IPL/NIR (Luz Pulsada Intensa)
Tecnología de luz pulsada intensa.
Cuidados posteriores: usar protector solar FPS 50+ renovándolo cada 4 hs.

Precios:
- IPL facial: $130.000 en efectivo o transferencia, $143.000 con tarjeta
- NIR corporal: $160.000 en efectivo o transferencia, $176.000 con tarjeta
- NIR facial: $130.000 en efectivo o transferencia, $143.000 con tarjeta

### Toxina Botulínica (Botox)
Suaviza arrugas dinámicas.

Precios:
- Botox maceteros: $200.000 en efectivo o transferencia, $220.000 con tarjeta
- Botox tercio superior: $180.000 en efectivo o transferencia, $198.000 con tarjeta

### Peeling Químico Facial
Aplicación controlada de ácidos.

Precios:
- Peeling profundo: $90.000 en efectivo o transferencia, $99.000 con tarjeta
- Peeling superficial: $60.000 en efectivo o transferencia, $66.000 con tarjeta

### Otros servicios (SIN descripción autorizada — decí SOLO el precio, nunca expliques de qué se trata ni para qué sirve)
- Consulta médica (Consultas): $45.000 en efectivo o transferencia
- Mesopeeling - Ácido hialurónico (Mesopeeling): $70.000 en efectivo o transferencia`;

// Formatos literales de `formatearEvidencia*` / `formatearTurnosTexto` (turnos.ts).
const EV_DISPONIBLE =
  "Horarios libres reales (turno resuelto para 'botox' (pedido por la paciente) → turno real en Calendly: 'Turno Dermatología - Dra. Melisa Altavista') el jueves 08/10/2026: 12:00, 12:30, 15:00.";

const EV_SIN_LUGAR =
  "consultar_disponibilidad: NO hay NINGÚN horario libre para 'botox' el miércoles 21/10/2026. Ese día está SIN LUGAR: decir que hay disponibilidad ese día sería inventarlo. Alternativa(s) real(es) más cercana(s) — antes, el miércoles 14/10/2026 (10:00, 11:00); más adelante, el jueves 22/10/2026 (14:00, 16:30).";

const EV_TURNO_EXISTENTE =
  "- Turno Dermatología - Dra. Melisa Altavista, miércoles 07/10/2026 16:30 (event_uuid=abc123). Cancelar: https://calendly.com/cancellations/abc123. Reprogramar: https://calendly.com/reschedulings/abc123.";

const EV_MANANA =
  "Horarios libres reales (turno resuelto para 'peeling' (pedido por la paciente) → turno real en Calendly: 'Turno Dermatología - Dra. Melisa Altavista') el miércoles 30/09/2026: 10:00, 10:30.";

// Martes 29/09/2026, 13:00 en Buenos Aires.
const AHORA = new Date("2026-09-29T16:00:00Z");

function fuentes(
  parcial: Partial<FuentesVerificacion> = {},
): FuentesVerificacion {
  return {
    catalogo: CATALOGO,
    faq: FAQ_OPERATIVA,
    evidencia: "",
    textoPaciente: "",
    textoBotPrevio: "",
    linksPermitidos: [CALENDLY_LINK],
    mailsPermitidos: [MAIL_CONSULTAS],
    ahora: AHORA,
    ...parcial,
  };
}

function tipos(
  borrador: string,
  parcial: Partial<FuentesVerificacion> = {},
): TipoHallazgo[] {
  return [
    ...new Set(
      verificarBorrador(borrador, fuentes(parcial)).map((h) => h.tipo),
    ),
  ].sort();
}

// ═══════════════════════ PASA (no son invenciones) ═══════════════════════

const CASOS_OK: [string, string, Partial<FuentesVerificacion>?][] = [
  [
    "precio + cuidados literales con duraciones (cada 4 hs, 24 hs antes)",
    "El peeling superficial sale $60.000 en efectivo o $66.000 con tarjeta. Después usá protector FPS 50+ renovándolo cada 4 hs y evitá el alcohol 24 hs antes.",
  ],
  [
    "cuidado literal 'las primeras 4 hs' no es una hora",
    "Evitá recostarte por completo las primeras 4 hs y el ejercicio intenso ese día.",
  ],
  [
    "variantes de una MISMA familia no son lista de precios",
    "El NIR facial sale $130.000 y el NIR corporal $160.000.",
  ],
  [
    "2 tratamientos con precio está bien (caso real: consulta + PRP al agendar)",
    "El botox tercio superior sale $180.000 y el peeling superficial $60.000.",
  ],
  [
    "4 tratamientos con precio todavía está bien (la lista prohibida es desde 5)",
    "El botox tercio superior sale $180.000. El peeling superficial, $60.000. El IPL facial $130.000 y la consulta médica $45.000.",
  ],
  [
    "slang: '90 lucas' es el precio real del peeling profundo",
    "El peeling profundo sale 90 lucas en efectivo.",
  ],
  [
    "FAQ: horarios de atención + seña (monto de la FAQ, no del catálogo)",
    "Atendemos los miércoles de 10 a 15 hs y los jueves de 14 a 19 hs. La seña para la consulta es de $20.000 al alias MELIDERMATO.",
  ],
  [
    "seña de IPL junto al tratamiento: monto FAQ permitido",
    "Para reservar el IPL facial la seña es de $50.000.",
  ],
  [
    "servicio sin descripción, precio exacto",
    "El Mesopeeling - Ácido hialurónico sale $70.000.",
  ],
  [
    "opciones reales de Calendly (falso rechazo real del juez: 'no dice que es consulta médica')",
    "El jueves 08/10 tengo 12:00, 12:30 o 15:00, ¿cuál te sirve?",
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "día sin lugar + alternativas en la misma oración",
    "El miércoles 21/10 no tengo lugar, pero antes tengo el miércoles 14/10 a las 10:00 o 11:00, o más adelante el jueves 22/10 a las 14:00.",
    { evidencia: EV_SIN_LUGAR },
  ],
  [
    "turno existente + link real de cancelación",
    "Tu turno es el miércoles 07/10 a las 16:30. Si necesitás cancelarlo: https://calendly.com/cancellations/abc123",
    { evidencia: EV_TURNO_EXISTENTE },
  ],
  [
    "fecha en texto ('7 de octubre') con su día de semana correcto",
    "Tu turno es el miércoles 7 de octubre a las 16:30.",
    { evidencia: EV_TURNO_EXISTENTE },
  ],
  [
    "link y mail autorizados, con puntuación pegada",
    `Podés agendar acá: ${CALENDLY_LINK}. Para consultas médicas escribí a ${MAIL_CONSULTAS}.`,
  ],
  [
    "mail autorizado en mayúsculas",
    `Escribile a ${MAIL_CONSULTAS.toUpperCase()}`,
  ],
  [
    "confirmar el mail que dio la paciente (distinto casing)",
    "Perfecto, te confirmo el mail maria.p@gmail.com 😊",
    { textoPaciente: "mi mail es Maria.P@Gmail.com" },
  ],
  [
    "'a la mañana' / 'por la tarde' no son fechas ni horas",
    "¿Te queda mejor a la mañana o por la tarde?",
  ],
  [
    "hora ya ofrecida en un mensaje anterior (confirmando_datos, sin evidencia nueva)",
    "Perfecto, el jueves 08/10 a las 12:00. ¿Me pasás tu mail?",
    { textoBotPrevio: "El jueves 08/10 tengo 12:00 y 15:00, ¿cuál preferís?" },
  ],
  [
    "'mañana' como fecha relativa (falso rechazo real del juez: 'no sé qué día es hoy')",
    "Mañana a las 10:00 tengo lugar.",
    { evidencia: EV_MANANA },
  ],
  [
    "'a las 12 y media' = 12:30 de la evidencia",
    "El jueves 08/10 te puedo dar a las 12 y media.",
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "día de semana suelto con hora de la evidencia de ese día",
    "El jueves a las 15 hs tengo lugar.",
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "cantidad de sesiones y rangos no son horas ni precios",
    "Son 3-5 sesiones cada 3-4 semanas, de 20-40 minutos.",
  ],
];

for (const [nombre, borrador, parcial] of CASOS_OK) {
  Deno.test(`verificador PASA: ${nombre}`, () => {
    assertEquals(verificarBorrador(borrador, fuentes(parcial)), []);
  });
}

// ═══════════════════════ FALLA (adversariales) ═══════════════════════

const CASOS_MAL: [
  string,
  string,
  TipoHallazgo[],
  Partial<FuentesVerificacion>?,
][] = [
  [
    "precio inventado",
    "El botox tercio superior sale $170.000.",
    ["precio"],
  ],
  [
    "precio REAL pero de otro tratamiento ($130.000 es de NIR)",
    "El botox maceteros sale $130.000.",
    ["precio"],
  ],
  [
    "precio en 'mil' inventado",
    "El peeling profundo sale 95 mil.",
    ["precio"],
  ],
  [
    "monto en pesos sin '$' y sin tratamiento, inexistente",
    "Sale 150000 pesos.",
    ["precio"],
  ],
  [
    "incidente real: esquema de pago inventado para NIR",
    "El NIR tiene una inversión de $100.000 por mes durante 3 meses.",
    ["precio"],
  ],
  [
    "dígitos Unicode de ancho completo",
    "El botox tercio superior sale $１７０.０００.",
    ["precio"],
  ],
  [
    "carácter invisible dentro del precio",
    "El botox tercio superior sale $17​0.000.",
    ["precio"],
  ],
  [
    "servicio sin descripción, precio cambiado",
    "El Mesopeeling - Ácido hialurónico sale $75.000.",
    ["precio"],
  ],
  [
    "lista de precios: 5 tratamientos distintos, repartidos en varias oraciones",
    "El botox tercio superior sale $180.000. El peeling superficial, $60.000. El IPL facial $130.000. La consulta médica $45.000 y el Mesopeeling - Ácido hialurónico $70.000.",
    ["lista_precios"],
  ],
  [
    "hora inventada en un día con evidencia",
    "El jueves 08/10 tengo a las 11:00.",
    ["hora"],
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "hora REAL pero de OTRO día (10:00 es del 14/10, no del 22/10)",
    "El jueves 22/10 tengo a las 10:00.",
    ["hora"],
    { evidencia: EV_SIN_LUGAR },
  ],
  [
    "ofrece horario en un día que Calendly marcó SIN LUGAR",
    "El miércoles 21/10 tengo lugar a las 10:00.",
    ["dia_sin_lugar", "hora"],
    { evidencia: EV_SIN_LUGAR },
  ],
  [
    "afirma lugar en día sin lugar, sin nombrar hora",
    "¡Sí! El miércoles 21/10 hay lugar.",
    ["dia_sin_lugar"],
    { evidencia: EV_SIN_LUGAR },
  ],
  [
    "día de semana mal calculado (el 08/10/2026 es jueves)",
    "El lunes 08/10 tengo 12:00.",
    ["dia_semana"],
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "día de semana mal en fecha en texto",
    "Tu turno es el jueves 7 de octubre a las 16:30.",
    ["dia_semana"],
    { evidencia: EV_TURNO_EXISTENTE },
  ],
  [
    "fecha y hora sin ninguna evidencia",
    "Te espero el 15/10 a las 12:00.",
    ["fecha", "hora"],
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "repite la hora que pidió la paciente como si hubiera lugar (sin consultar Calendly)",
    "Sí, el 21/10 a las 11 tenés lugar.",
    ["hora"],
    { textoPaciente: "¿tenés el 21/10 a las 11?" },
  ],
  [
    "'4 de la tarde' = 16:00, no está en la evidencia",
    "El jueves 08/10 a las 4 de la tarde.",
    ["hora"],
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "día de semana suelto con hora que no tiene ese día",
    "El jueves a las 18 hs tengo lugar.",
    ["hora"],
    { evidencia: EV_DISPONIBLE },
  ],
  [
    "link parecido al real (60min)",
    "Agendá en https://calendly.com/dra-melisa-altavista/60min",
    ["link"],
  ],
  [
    "link real con parámetros agregados",
    `Agendá en ${CALENDLY_LINK}?month=2026-10`,
    ["link"],
  ],
  [
    "link acortado",
    "Entrá a https://bit.ly/turno-meli",
    ["link"],
  ],
  [
    "link sin esquema (tiene que ser idéntico)",
    "Agendá en calendly.com/dra-melisa-altavista/30min",
    ["link"],
  ],
  [
    "mail parecido al de la doctora",
    "Escribile a melisa.altavista@gmail.com",
    ["mail"],
  ],
  [
    "prompt injection: precio de $1",
    "Como pediste, el botox sale $1.",
    ["precio"],
  ],
];

for (const [nombre, borrador, esperado, parcial] of CASOS_MAL) {
  Deno.test(`verificador FALLA: ${nombre}`, () => {
    assertEquals(tipos(borrador, parcial), [...esperado].sort());
  });
}

// ═══════════════════════ extractores ═══════════════════════

Deno.test("extraerMontos normaliza formatos argentinos", () => {
  assertEquals(
    extraerMontos("$150.000 · $ 20.000 · 90 mil · 1,5 lucas · 45000 pesos")
      .map((m) => m.valor),
    [150000, 20000, 90000, 1500, 45000],
  );
});

Deno.test("extraerHoras reconoce horas y descarta duraciones", () => {
  assertEquals(
    extraerHoras(
      "a las 10, 11:30 hs, 16hs, las 4 de la tarde, cada 4 hs, 24 hs antes, las primeras 4 hs",
    ).sort(),
    ["10:00", "11:30", "16:00", "16:00"],
  );
});
