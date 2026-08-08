import { assertEquals } from "jsr:@std/assert@1";
import {
  horaEnFranja,
  resolverFechaExpresion,
  resolverRangoFecha,
  validarHoraHHMM,
} from "./fechas.ts";

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

// ── v23: resolverRangoFecha — semana acotada para pedidos vagos-pero-con-señal ──

Deno.test("resolverRangoFecha 'semana_actual' arranca HOY (nunca antes) y termina el domingo de esta semana", () => {
  // Ancla jueves 06/08 → lunes de esta semana es 03/08, domingo es 09/08.
  const r = resolverRangoFecha({ tipo: "semana_actual" }, JUEVES_2026_08_06);

  assertEquals(r, { ok: true, inicioISO: "2026-08-06", finISO: "2026-08-09" });
});

Deno.test("resolverRangoFecha 'semana_que_viene' es el lunes a domingo siguiente completo", () => {
  const r = resolverRangoFecha(
    { tipo: "semana_que_viene" },
    JUEVES_2026_08_06,
  );

  assertEquals(r, { ok: true, inicioISO: "2026-08-10", finISO: "2026-08-16" });
});

Deno.test("resolverRangoFecha con ancla en domingo: 'semana_actual' es un rango de un solo día (hoy)", () => {
  // 09/08/2026 es domingo — último día de la semana que arrancó el 03/08.
  const DOMINGO = new Date("2026-08-09T10:00:00-03:00");
  const r = resolverRangoFecha({ tipo: "semana_actual" }, DOMINGO);

  assertEquals(r, { ok: true, inicioISO: "2026-08-09", finISO: "2026-08-09" });
});

Deno.test("resolverRangoFecha delega un día puntual a resolverFechaExpresion (rango de un solo día)", () => {
  const r = resolverRangoFecha(
    { tipo: "dia_semana", dia_semana: "miercoles" },
    JUEVES_2026_08_06,
  );

  assertEquals(r, { ok: true, inicioISO: "2026-08-12", finISO: "2026-08-12" });
});

Deno.test("horaEnFranja: corte al mediodía, 'manana' es antes de las 13:00", () => {
  assertEquals(horaEnFranja("09:00", "manana"), true);
  assertEquals(horaEnFranja("12:59", "manana"), true);
  assertEquals(horaEnFranja("13:00", "manana"), false);
  assertEquals(horaEnFranja("13:00", "tarde"), true);
  assertEquals(horaEnFranja("18:30", "tarde"), true);
  assertEquals(horaEnFranja("08:00", "tarde"), false);
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
