/**
 * Tests de lógica pura de los prompts del guardrail.
 *
 * No hay red, no hay base, no hay LLM: se verifican invariantes del TEXTO y de
 * los schemas. No prueban que el modelo se comporte bien — eso no es testeable
 * acá — sino que las piezas que tienen que estar sincronizadas entre sí no se
 * separen en silencio.
 *
 * El caso que motivó estos tests: `pedir_precision` estuvo declarado en el
 * CHECK de `agent_guardrails.sql` mientras el TypeScript no lo tenía en ningún
 * lado. Nada falló, nada avisó. El primer test de acá abajo lo agarra.
 *
 * Correr desde `supabase/functions/`:
 *   deno test --allow-read agent-client/guardrail/prompts_test.ts
 */

import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  CALENDLY_LINK,
  FAQ_OPERATIVA,
  MAIL_CONSULTAS,
  NOMBRE_DOCTORA,
} from "./catalogo.ts";
import {
  SCHEMA_JUEZ,
  SCHEMA_REDACTOR,
  systemJuez,
  systemRedactor,
  TIPOS_RESPUESTA,
  userJuez,
  userRedactor,
} from "./prompts.ts";

/** Catálogo de mentira, con la forma real que produce `formatearFila()`. */
const CATALOGO_FALSO = [
  "- Consulta médica (Consultorio): $30.000 en efectivo o transferencia",
  "- PRP facial (Estética): $80.000 en efectivo o transferencia, $95.000 con tarjeta",
].join("\n");

const SQL_GUARDRAILS = new URL(
  "../../../vampiresa_meli/agent_guardrails.sql",
  import.meta.url,
);

// ════════════════════ Sincronización de los tipos ════════════════════

Deno.test("el CHECK de tipo_declarado en el SQL coincide con TIPOS_RESPUESTA", async () => {
  const sql = await Deno.readTextFile(SQL_GUARDRAILS);

  const match = sql.match(/check\s*\(tipo_declarado in \(([^)]*)\)\)/i);

  assert(match, "no se encontró el CHECK de tipo_declarado en el SQL");

  const enSql = match[1]
    .split(",")
    .map((valor) => valor.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    .sort();

  assertEquals(
    enSql,
    [...TIPOS_RESPUESTA].sort(),
    "el CHECK del SQL y TIPOS_RESPUESTA se separaron: un tipo nuevo en un lado sin el otro rompe el log de respuestas no enviadas",
  );
});

Deno.test("el enum del schema del redactor es exactamente TIPOS_RESPUESTA", () => {
  assertEquals(SCHEMA_REDACTOR.properties.tipo.enum, [...TIPOS_RESPUESTA]);
  assertEquals(SCHEMA_REDACTOR.additionalProperties, false);
  assertEquals(SCHEMA_REDACTOR.required, ["tipo", "mensaje"]);
});

Deno.test("el schema del juez sigue siendo booleano + motivo obligatorios", () => {
  assertEquals(SCHEMA_JUEZ.properties.aprobado.type, "boolean");
  assertEquals(SCHEMA_JUEZ.required, ["aprobado", "motivo"]);
  assertEquals(SCHEMA_JUEZ.additionalProperties, false);
});

// ════════════════════ Prompt del REDACTOR ════════════════════

Deno.test("el redactor documenta los cinco tipos en 'CÓMO ELEGIR EL tipo'", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 0);

  const seccion = prompt.slice(prompt.indexOf('CÓMO ELEGIR EL "tipo"'));

  assert(seccion.length > 0, "falta la sección CÓMO ELEGIR EL tipo");

  for (const tipo of TIPOS_RESPUESTA) {
    assert(
      seccion.includes(`tipo = "${tipo}"`),
      `el tipo '${tipo}' existe en el schema pero no está explicado en el prompt del redactor`,
    );
  }
});

Deno.test("el redactor inyecta catálogo, contador y datos autorizados", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 3);

  assert(prompt.includes(CATALOGO_FALSO), "no se inyectó el catálogo");
  assert(
    prompt.includes("FUERA DE TEMA DE ESTA PERSONA: 3"),
    "no se inyectó el contador",
  );
  assert(prompt.includes(CALENDLY_LINK), "falta el link de Calendly");
  assert(prompt.includes(MAIL_CONSULTAS), "falta el mail de derivación");
  assert(prompt.includes(NOMBRE_DOCTORA), "falta el nombre de la doctora");
});

Deno.test("el redactor se presenta como asistente Y recepcionista", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 0);

  assert(
    /asistente y recepcionista/i.test(prompt),
    "se perdió la persona 'asistente y recepcionista' que pidió Santi",
  );
  assert(
    /recepcionista de mostrador/i.test(prompt),
    "se perdió la descripción del rol acotado a lo administrativo",
  );
});

Deno.test("el redactor prohíbe opinar y recomendar, médico y no médico", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 0);

  // Reglas duras que no se pueden perder en un refactor de tono.
  for (
    const frase of [
      "No tenés conocimiento médico propio",
      "Nunca des diagnósticos",
      "Nunca recomiendes",
      "No comparás",
    ]
  ) {
    assert(prompt.includes(frase), `se perdió la regla dura: "${frase}"`);
  }

  assert(
    /embarazo,\s+lactancia,\s+alergias\s+o\s+medicación/i.test(prompt),
    "se perdió la regla sobre embarazo/lactancia/alergias/medicación",
  );

  assert(
    /ni sobre temas médicos, ni sobre\s+ningún otro tema/i.test(prompt),
    "falta la prohibición de opinar sobre temas NO médicos",
  );
});

Deno.test("pedir_precision le prohíbe al redactor cualquier cifra", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 0);

  const inicio = prompt.indexOf('tipo = "pedir_precision"');
  const fin = prompt.indexOf('tipo = "faq"');

  assert(
    inicio > 0 && fin > inicio,
    "no se encontró el bloque pedir_precision",
  );

  const bloque = prompt.slice(inicio, fin);

  assert(bloque.includes("CERO precios"), "falta la prohibición de precios");
  assert(
    /no se manda NUNCA/i.test(bloque),
    "falta la prohibición explícita de mandar la lista completa",
  );
  assert(
    /NO es una pregunta fuera de tema/i.test(bloque),
    "falta la aclaración de que pedir_precision no gasta el saludo de cortesía",
  );
});

Deno.test("el redactor inyecta la FAQ operativa y explica el tipo faq", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 0);

  assert(
    prompt.includes(FAQ_OPERATIVA),
    "no se inyectó la sección de FAQ operativa autorizada",
  );

  const inicio = prompt.indexOf('tipo = "faq"');
  const fin = prompt.indexOf('tipo = "saludo_generico"');

  assert(inicio > 0 && fin > inicio, "no se encontró el bloque faq");

  const bloque = prompt.slice(inicio, fin);

  assert(
    /esto NO es "faq"/i.test(bloque),
    "falta la aclaración de que el estado de un turno puntual no es faq",
  );
});

Deno.test("el redactor permite recitar cuidados literales del catálogo", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 0);

  assert(
    /EXCEPCIÓN — los cuidados y las reacciones esperables SÍ se pueden dar/i
      .test(prompt),
    "falta la excepción que permite citar cuidados previos/posteriores literales",
  );
});

Deno.test("agendar no gasta el saludo y prohíbe inventar fechas", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 0);

  const inicio = prompt.indexOf('tipo = "agendar"');
  const fin = prompt.indexOf('tipo = "seguimiento_tratamiento"');

  assert(inicio > 0 && fin > inicio, "no se encontró el bloque agendar");

  const bloque = prompt.slice(inicio, fin);

  assert(
    /No\s+gasta el saludo de cortesía ni toca el contador/i.test(bloque),
    "agendar tiene que ser on-topic y no tocar el contador",
  );
  assert(
    /NUNCA inventes\s+fechas, cupos o "jornadas especiales"/i.test(bloque),
    "falta la prohibición de inventar fechas/jornadas especiales",
  );
});

Deno.test("seguimiento_tratamiento siempre deriva a mail, sin importar el contador", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 5);

  const inicio = prompt.indexOf('tipo = "seguimiento_tratamiento"');
  const fin = prompt.indexOf('tipo = "saludo_generico"');

  assert(
    inicio > 0 && fin > inicio,
    "no se encontró el bloque seguimiento_tratamiento",
  );

  const bloque = prompt.slice(inicio, fin);

  assert(bloque.includes(MAIL_CONSULTAS), "no deriva al mail de la doctora");
  assert(
    /NUNCA se silencia ni se convierte en un saludo/i.test(bloque),
    "falta la aclaración de que este tipo nunca se silencia por el contador",
  );
});

Deno.test("fuera_de_tema no repite la presentación del consultorio", () => {
  const prompt = systemRedactor(CATALOGO_FALSO, 2);

  const inicio = prompt.indexOf('tipo = "fuera_de_tema"');
  const fin = prompt.indexOf('tipo = "silencio"');

  assert(inicio > 0 && fin > inicio, "no se encontró el bloque fuera_de_tema");

  const bloque = prompt.slice(inicio, fin);

  assert(
    /NO va acá/i.test(bloque),
    "falta la instrucción de no repetir 'Hola, este es el consultorio...'",
  );
  assert(
    /contador de abajo YA ES 1 O MÁS/i.test(bloque),
    "falta la condición del contador para fuera_de_tema",
  );
});

// ════════════════════ Prompt del JUEZ ════════════════════

Deno.test("el juez autoriza explícitamente el mail Y el link de Calendly", () => {
  const prompt = systemJuez(CATALOGO_FALSO, 0);

  const inicio = prompt.indexOf("LOS DOS CHEQUEOS QUE IMPORTAN");
  const fin = prompt.indexOf("QUÉ NO ES MOTIVO DE RECHAZO");

  assert(inicio > 0 && fin > inicio, "falta el bloque de los dos chequeos");

  const bloque = prompt.slice(inicio, fin);

  // Sin esto el juez rechaza todo saludo correcto por "dato que no está en el
  // catálogo": el link y el mail no figuran en precios_vigentes.
  assert(bloque.includes(MAIL_CONSULTAS), "el mail no está autorizado");
  assert(
    bloque.includes(CALENDLY_LINK),
    "el link de Calendly no está autorizado",
  );
});

Deno.test("el juez bloquea invención (diagnósticos, comparaciones, promesas de resultado)", () => {
  const prompt = systemJuez(CATALOGO_FALSO, 0);

  const inicio = prompt.indexOf("CHEQUEO 1");
  const fin = prompt.indexOf("CHEQUEO 2");

  assert(inicio > 0 && fin > inicio, "falta el bloque CHEQUEO 1");

  const bloque = prompt.slice(inicio, fin);

  for (
    const frase of [
      "diagnósticos",
      "promesas de resultado",
    ]
  ) {
    assert(bloque.includes(frase), `falta la prohibición: "${frase}"`);
  }

  assert(
    /dígito por dígito/i.test(bloque),
    "falta la verificación de precios dígito por dígito",
  );
  assert(
    /comparaciones o\s+juicios de valor entre tratamientos/i.test(bloque),
    "falta la prohibición de comparar o juzgar tratamientos",
  );
  assert(
    /listado de precios de varios tratamientos a la vez/i.test(bloque),
    "falta la prohibición de armar una lista completa de precios (v9: es la " +
      "única protección real contra pedir/filtrar el catálogo entero de a poco)",
  );
});

Deno.test("el juez fuerza seguimiento_tratamiento sin importar qué tipo declaró el redactor", () => {
  const prompt = systemJuez(CATALOGO_FALSO, 0);

  const inicio = prompt.indexOf("CHEQUEO 2");
  const fin = prompt.indexOf("QUÉ NO ES MOTIVO DE RECHAZO");

  assert(inicio > 0 && fin > inicio, "falta el bloque CHEQUEO 2");

  const bloque = prompt.slice(inicio, fin);

  assert(
    bloque.includes(MAIL_CONSULTAS),
    "CHEQUEO 2 tiene que derivar al mail de la doctora",
  );
  assert(
    /INDEPENDIENTE del tipo que haya declarado el redactor/i.test(bloque),
    "falta la aclaración de que este chequeo aplica sin importar el tipo declarado",
  );
});

Deno.test("el juez deja lugar explícito a la cordialidad", () => {
  const prompt = systemJuez(CATALOGO_FALSO, 0);

  const inicio = prompt.indexOf("QUÉ NO ES MOTIVO DE RECHAZO");

  assert(inicio > 0, "falta el bloque que protege la cordialidad");

  const bloque = prompt.slice(
    inicio,
    prompt.indexOf("No hay reglas adicionales por tipo"),
  );

  assert(
    /tono buscado/i.test(bloque),
    "falta la aclaración de que la calidez/cordialidad no se rechaza",
  );
  assert(
    /poco informativo/i.test(bloque),
    "falta la advertencia de no rechazar por 'poco informativo'",
  );
});

Deno.test("el juez ve la sección de FAQ operativa autorizada", () => {
  const prompt = systemJuez(CATALOGO_FALSO, 0);

  assert(
    prompt.includes(FAQ_OPERATIVA),
    "el juez no ve la sección de FAQ operativa autorizada",
  );
});

Deno.test("el juez no exige exhaustividad ni confunde cuidados con recomendación", () => {
  const prompt = systemJuez(CATALOGO_FALSO, 0);

  const inicio = prompt.indexOf("QUÉ NO ES MOTIVO DE RECHAZO");

  assert(inicio > 0, "falta el bloque de qué no es motivo de rechazo");

  const bloque = prompt.slice(
    inicio,
    prompt.indexOf("No hay reglas adicionales por tipo"),
  );

  assert(
    /no mencione TODAS las variantes/i.test(bloque),
    "falta la aclaración de que no hace falta ser exhaustivo",
  );
  assert(
    /no rechaces por "incompleto"/i.test(bloque),
    "falta la instrucción explícita de no rechazar por incompleto",
  );
  assert(
    /no una recomendación personalizada/i.test(bloque),
    "falta la aclaración de que los cuidados no son una recomendación",
  );
});

Deno.test("v9: el juez ya no tiene reglas propias por tipo declarado (relajación deliberada)", () => {
  const prompt = systemJuez(CATALOGO_FALSO, 0);

  // Pedido explícito de Santi 2026-08-05: borrar todo el bloque "Si el tipo
  // declarado es X" porque generaba rechazos de más (ver P05_lecciones_
  // guardrail.md). El juez ya no valida el contador de fuera de tema ni
  // exige nada específico por tipo — solo CHEQUEO 1 y CHEQUEO 2.
  for (const tipo of TIPOS_RESPUESTA.filter((t) => t !== "silencio")) {
    assert(
      !prompt.includes(`Si el tipo declarado es "${tipo}"`),
      `el juez todavía tiene una regla propia para '${tipo}' — se decidió sacarlas`,
    );
  }
  assert(
    prompt.includes("No hay reglas adicionales por tipo"),
    "falta la aclaración explícita de que no hay reglas por tipo",
  );
});

// ════════════════════ Prompts de usuario ════════════════════

Deno.test("los prompts de usuario envuelven el texto de la paciente en tags", () => {
  const mensaje = "hola, ¿cuánto sale el PRP?";

  const delRedactor = userRedactor(mensaje);

  assert(delRedactor.includes(`<mensaje_paciente>\n${mensaje}\n`));

  const delJuez = userJuez(mensaje, "pedir_precision", "¿Cuál te interesa?");

  assert(delJuez.includes("Tipo declarado por el redactor: pedir_precision"));
  assert(delJuez.includes("<mensaje_borrador>\n¿Cuál te interesa?\n"));
});
