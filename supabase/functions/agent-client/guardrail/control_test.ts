/**
 * Tests del loop de control (verificador → juez médico → una reescritura),
 * sin red: `fetch` se reemplaza por respuestas falsas de la Messages API.
 *
 * Correr: deno test --config deno.json --allow-read --allow-env \
 *   agent-client/guardrail/control_test.ts
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { controlarBorrador, type ControlParams } from "./control.ts";

const CATALOGO = `### Toxina Botulínica (Botox)
Suaviza arrugas dinámicas.

Precios:
- Botox tercio superior: $180.000 en efectivo o transferencia, $198.000 con tarjeta`;

type RespuestaFalsa = Record<string, unknown> | { status: number };

/** Encola respuestas de Anthropic y registra qué paso pidió cada una. */
function stubAnthropic(respuestas: RespuestaFalsa[]) {
  const original = globalThis.fetch;
  const pedidos: string[] = [];

  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const system = body.system.map((b: { text: string }) => b.text).join("");
    pedidos.push(system.includes("control médico") ? "juez" : "reescritura");

    const r = respuestas.shift();

    if (!r) throw new Error("llamado a Anthropic no esperado");
    if ("status" in r && typeof r.status === "number") {
      return Promise.resolve(new Response("error falso", { status: r.status }));
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(r) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  return { pedidos, restaurar: () => (globalThis.fetch = original) };
}

function params(borrador: string): ControlParams {
  return {
    llamado: { apiKey: "test" },
    catalogo: CATALOGO,
    evidencia: "",
    mensajePaciente: "¿cuánto sale el botox?",
    historial: [],
    tipo: "catalogo",
    borrador,
    ahora: new Date("2026-09-29T16:00:00Z"),
  };
}

Deno.test("control: borrador limpio → solo el juez, aprobado", async () => {
  const stub = stubAnthropic([{
    aprobado: true,
    motivo: "sin contenido médico",
  }]);

  try {
    const r = await controlarBorrador(
      params("El botox tercio superior sale $180.000."),
    );
    assert(r.enviar);
    assertEquals(r.reescrito, false);
    assertEquals(stub.pedidos, ["juez"]);
  } finally {
    stub.restaurar();
  }
});

Deno.test("control: precio inventado → verificador (sin juez) → reescritura → juez aprueba", async () => {
  const stub = stubAnthropic([
    { mensaje: "El botox tercio superior sale $180.000." },
    { aprobado: true, motivo: "ok" },
  ]);

  try {
    const r = await controlarBorrador(
      params("El botox tercio superior sale $170.000."),
    );
    assert(r.enviar);
    assertEquals(r.reescrito, true);
    assertEquals(r.mensaje, "El botox tercio superior sale $180.000.");
    assertEquals(r.primerRechazo?.por, "verificador");
    // El juez NO corre sobre un borrador con datos inventados: se ahorra el llamado.
    assertEquals(stub.pedidos, ["reescritura", "juez"]);
  } finally {
    stub.restaurar();
  }
});

Deno.test("control: la reescritura no arregla el dato → silencio, sin llamar al juez", async () => {
  const stub = stubAnthropic([{ mensaje: "Sale $175.000." }]);

  try {
    const r = await controlarBorrador(
      params("El botox tercio superior sale $170.000."),
    );
    assert(!r.enviar);
    assert(
      r.motivoRegistro.startsWith("rechazado 2 veces por el verificador:"),
    );
    assertEquals(stub.pedidos, ["reescritura"]);
  } finally {
    stub.restaurar();
  }
});

Deno.test("control: el juez rechaza dos veces → silencio con el motivo del juez", async () => {
  const stub = stubAnthropic([
    { aprobado: false, motivo: "REGLA 1: 'es perfecto para vos'" },
    { mensaje: "El botox es perfecto para vos igual." },
    { aprobado: false, motivo: "REGLA 1 otra vez" },
  ]);

  try {
    const r = await controlarBorrador(params("El botox es perfecto para vos."));
    assert(!r.enviar);
    assertEquals(
      r.motivoRegistro,
      "rechazado 2 veces por el juez: REGLA 1 otra vez",
    );
    assertEquals(r.primerRechazo?.por, "juez");
    assertEquals(stub.pedidos, ["juez", "reescritura", "juez"]);
  } finally {
    stub.restaurar();
  }
});

Deno.test("control: el juez falla (HTTP 500) → no se envía (fail-closed)", async () => {
  const stub = stubAnthropic([{ status: 500 }]);

  try {
    const r = await controlarBorrador(params("¡Hola! ¿En qué te ayudo?"));
    assert(!r.enviar);
    assertEquals(r.motivo, "error en el juez");
    assert(r.motivoRegistro.startsWith("error técnico en el juez:"));
  } finally {
    stub.restaurar();
  }
});

Deno.test("control: la reescritura viene vacía → no se envía", async () => {
  const stub = stubAnthropic([{ mensaje: "   " }]);

  try {
    const r = await controlarBorrador(
      params("El botox tercio superior sale $170.000."),
    );
    assert(!r.enviar);
    assertEquals(r.motivo, "reescritura vacía");
  } finally {
    stub.restaurar();
  }
});
