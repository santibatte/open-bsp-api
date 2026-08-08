import { assertEquals } from "jsr:@std/assert@1";
import { resolverFechaExpresion, validarHoraHHMM } from "./fechas.ts";

// Ancla: jueves 2026-08-06, 15:00 hora de Buenos Aires — el mismo día real
// del Incidente 9 (el mensaje real que disparó el bug de timezone).
const JUEVES_2026_08_06 = new Date("2026-08-06T15:00:00-03:00");

Deno.test("regresión Incidente 9: 'el miércoles' desde un jueves resuelve al miércoles siguiente, no al martes", () => {
  const r = resolverFechaExpresion(
    { tipo: "dia_semana", dia_semana: "miercoles" },
    JUEVES_2026_08_06,
  );

  assertEquals(r, { ok: true, fechaISO: "2026-08-12" });
});

Deno.test("'el jueves' con ancla jueves resuelve a HOY (delta 0), nunca al jueves siguiente", () => {
  const r = resolverFechaExpresion(
    { tipo: "dia_semana", dia_semana: "jueves" },
    JUEVES_2026_08_06,
  );

  assertEquals(r, { ok: true, fechaISO: "2026-08-06" });
});

Deno.test("'mañana' y 'pasado mañana' suman 1 y 2 días de calendario", () => {
  assertEquals(
    resolverFechaExpresion({ tipo: "manana" }, JUEVES_2026_08_06),
    { ok: true, fechaISO: "2026-08-07" },
  );
  assertEquals(
    resolverFechaExpresion({ tipo: "pasado_manana" }, JUEVES_2026_08_06),
    { ok: true, fechaISO: "2026-08-08" },
  );
});

Deno.test("fecha_explicita 'DD/MM' sin año asume el año de la ancla", () => {
  const r = resolverFechaExpresion(
    { tipo: "fecha_explicita", fecha_explicita: "19/08" },
    JUEVES_2026_08_06,
  );

  assertEquals(r, { ok: true, fechaISO: "2026-08-19" });
});

Deno.test("fecha_explicita que ya pasó este año rueda al año siguiente", () => {
  const r = resolverFechaExpresion(
    { tipo: "fecha_explicita", fecha_explicita: "01/01" },
    JUEVES_2026_08_06,
  );

  assertEquals(r, { ok: true, fechaISO: "2027-01-01" });
});

Deno.test("fecha_explicita inválida (día/mes imposibles) rechaza, no inventa", () => {
  const r = resolverFechaExpresion(
    { tipo: "fecha_explicita", fecha_explicita: "32/13" },
    JUEVES_2026_08_06,
  );

  assertEquals(r.ok, false);
});

Deno.test("validarHoraHHMM acepta HH:MM 24hs y rechaza formatos inválidos", () => {
  assertEquals(validarHoraHHMM("16:00"), true);
  assertEquals(validarHoraHHMM("09:30"), true);
  assertEquals(validarHoraHHMM("23:59"), true);
  assertEquals(validarHoraHHMM("24:00"), false);
  assertEquals(validarHoraHHMM("9:00"), false);
  assertEquals(validarHoraHHMM("16hs"), false);
  assertEquals(validarHoraHHMM(""), false);
});
