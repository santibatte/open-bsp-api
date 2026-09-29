import { assertEquals } from "jsr:@std/assert@1";
import {
  datosEfectivos,
  leerTurnoConsultado,
  resolverTurnoDesdeConsulta,
  type TurnoConsultado,
  turnoConsultadoDe,
  validarGateAgendar,
} from "./turnos.ts";
import { crearMemoriaPaciente } from "./memoria.ts";
import type { ContactAddressRow, ContactRow } from "../../_shared/supabase.ts";
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

// ══════════════ TURNO CONSULTADO (2026-09-29) ══════════════

// 29/09/2026 12:40 ART — el momento real del bug de Laura Ragucci.
const AHORA_LAURA = new Date("2026-09-29T12:40:00-03:00");

const IPL_8_OCT: TurnoConsultado = {
  tratamiento: "luz pulsada IPL",
  opciones: [{
    fecha: "2026-10-08",
    horarios: ["08:30", "09:00", "12:00", "12:30", "16:00"],
  }],
  consultado_en: "2026-09-29T15:29:20.000Z",
};

const ARGS_LAURA = {
  hora: "12:00",
  email: "laura.ragucci@educ.ar",
  fecha: { tipo: "hoy", dia_semana: null, fecha_explicita: null },
  nombre: "Laura Ragucci",
  tratamiento_o_tipo_turno: "consulta general",
};

const HISTORIAL_LAURA =
  "8 de octubre podría\nPerfecto, el 8 de octubre tengo varios horarios disponibles: 8:30, 9:00, 12:00...\n12 para mí, 12.30 para madre";

Deno.test("gate: regresión Laura — con turno consultado agenda el 8/10 IPL aunque el modelo diga 'hoy' + 'consulta general'", () => {
  const r = validarGateAgendar(
    ARGS_LAURA,
    HISTORIAL_LAURA,
    AHORA_LAURA,
    IPL_8_OCT,
  );

  assertEquals(r, {
    ok: true,
    fechaHoraDeseada: "2026-10-08T12:00:00-03:00",
    tratamiento: "luz pulsada IPL",
  });
});

Deno.test("gate: sin turno consultado, el comportamiento de siempre (Laura se bloquea por fecha en el pasado)", () => {
  const r = validarGateAgendar(ARGS_LAURA, HISTORIAL_LAURA, AHORA_LAURA);

  assertEquals(r.ok, false);
});

Deno.test("gate: hora que no está entre los horarios consultados → bloquea", () => {
  const r = validarGateAgendar(
    { ...ARGS_LAURA, hora: "11:30" },
    `${HISTORIAL_LAURA} 11:30`,
    AHORA_LAURA,
    IPL_8_OCT,
  );

  assertEquals(r.ok, false);
});

Deno.test("resolverTurnoDesdeConsulta: hora en varios días desempata con la fecha del modelo, o bloquea", () => {
  const semana: TurnoConsultado = {
    ...IPL_8_OCT,
    opciones: [
      { fecha: "2026-10-07", horarios: ["12:00"] },
      { fecha: "2026-10-08", horarios: ["12:00"] },
    ],
  };

  const conFecha = resolverTurnoDesdeConsulta(semana, "12:00", "2026-10-08");
  assertEquals(conFecha.ok && conFecha.fechaISO, "2026-10-08");

  const sinFecha = resolverTurnoDesdeConsulta(semana, "12:00", "2026-09-29");
  assertEquals(sinFecha.ok, false);
});

Deno.test("turnoConsultadoDe: día puntual, alternativas y rango, fechas a ISO", () => {
  assertEquals(
    turnoConsultadoDe({
      disponible: true,
      tipoEvento: "Luz Pulsada Intensa OCTUBRE",
      fecha: "08/10/2026",
      horarios: ["12:00", "12:30"],
      tratamientoSolicitado: "IPL",
    }, AHORA_LAURA)?.opciones,
    [{ fecha: "2026-10-08", horarios: ["12:00", "12:30"] }],
  );

  assertEquals(
    turnoConsultadoDe({
      disponible: false,
      motivo: "sin_horarios_ese_dia",
      tipoEvento: "x",
      fecha: "20/10/2026",
      tratamientoSolicitado: "PRP",
      alternativaAntes: null,
      alternativaDespues: { fecha: "21/10/2026", horarios: ["11:00"] },
    }, AHORA_LAURA)?.opciones,
    [{ fecha: "2026-10-21", horarios: ["11:00"] }],
  );

  assertEquals(
    turnoConsultadoDe({
      disponible: false,
      motivo: "tipo_turno_ambiguo",
      detalle: "x",
    }, AHORA_LAURA),
    null,
  );
});

Deno.test("leerTurnoConsultado: vencido o mal formado → null", () => {
  assertEquals(
    leerTurnoConsultado({ turno_consultado: IPL_8_OCT }, AHORA_LAURA)
      ?.tratamiento,
    "luz pulsada IPL",
  );
  assertEquals(
    leerTurnoConsultado(
      { turno_consultado: IPL_8_OCT },
      new Date("2026-10-05T12:00:00-03:00"),
    ),
    null,
  );
  assertEquals(
    leerTurnoConsultado({ turno_consultado: null }, AHORA_LAURA),
    null,
  );
});

// ══════════════ MEMORIA SIN CONTACTO (2026-09-29) ══════════════

Deno.test("memoria: regresión Popova — sin contacto, la memoria vive en la fila del teléfono", () => {
  const direccion = {
    organization_id: "org",
    service: "whatsapp",
    address: "5491173852630",
    contact_id: null,
    extra: { agendamiento_estado: "confirmando_datos" },
  } as unknown as ContactAddressRow;

  const m = crearMemoriaPaciente(undefined, direccion);

  assertEquals(m.destino, {
    tipo: "direccion",
    organizationId: "org",
    service: "whatsapp",
    address: "5491173852630",
  });
  assertEquals(m.extra.agendamiento_estado, "confirmando_datos");
});

Deno.test("memoria: con contacto, usa el contacto (como siempre)", () => {
  const m = crearMemoriaPaciente(
    { id: "c1", extra: { etapa: "agendando" } } as unknown as ContactRow,
    { address: "549", extra: {} } as unknown as ContactAddressRow,
  );

  assertEquals(m.destino, { tipo: "contacto", contactId: "c1" });
  assertEquals(m.extra.etapa, "agendando");
});

Deno.test("memoria: contacto armado solo con el nombre (sin id) cae a la dirección", () => {
  const m = crearMemoriaPaciente(
    { name: "Mariya" } as unknown as ContactRow,
    {
      organization_id: "org",
      service: "whatsapp",
      address: "549",
      extra: { name: "Mariya" },
    } as unknown as ContactAddressRow,
  );

  assertEquals(m.destino?.tipo, "direccion");
});
