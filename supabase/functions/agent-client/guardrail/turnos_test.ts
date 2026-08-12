import { assertEquals } from "jsr:@std/assert@1";
import { datosEfectivos } from "./turnos.ts";
import type { DatosContactoGuardados } from "./prompts.ts";

const SIN_DATOS_GUARDADOS: DatosContactoGuardados = {
  email: null,
  nombreCompleto: null,
  turnoAdicionalAvisado: false,
};

// Regresión Incidente 2026-08-10 (Maria Ines Cerdá, ver
// P05_lecciones_guardrail.md): el mail recién tipeado en ESTE mensaje tiene
// que quedar disponible de inmediato, no recién en el próximo mensaje una
// vez persistido — es el mismo valor que `guardrail/index.ts` usa para
// llamar a `consultarTurno`.
Deno.test("datosEfectivos: mail de este mensaje gana aunque no haya nada guardado todavía", () => {
  const r = datosEfectivos(SIN_DATOS_GUARDADOS, {
    email: "minecerda2014@gmail.com",
    nombre_completo: null,
  });

  assertEquals(r.email, "minecerda2014@gmail.com");
});

Deno.test("datosEfectivos: sin mail en este mensaje, usa el guardado", () => {
  const r = datosEfectivos(
    { ...SIN_DATOS_GUARDADOS, email: "guardado@ejemplo.com" },
    { email: null, nombre_completo: null },
  );

  assertEquals(r.email, "guardado@ejemplo.com");
});

Deno.test("datosEfectivos: mail vacío o mal formado en este mensaje no descarta el guardado", () => {
  const r = datosEfectivos(
    { ...SIN_DATOS_GUARDADOS, email: "guardado@ejemplo.com" },
    { email: "  ", nombre_completo: null },
  );

  assertEquals(r.email, "guardado@ejemplo.com");
});

Deno.test("datosEfectivos: sin mail en ningún lado → null, nunca string vacío", () => {
  const r = datosEfectivos(SIN_DATOS_GUARDADOS, undefined);

  assertEquals(r.email, null);
});
