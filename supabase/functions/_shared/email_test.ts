import { assertEquals } from "jsr:@std/assert@1";
import { parsearEmailOpcional } from "./email.ts";

Deno.test("parsearEmailOpcional: null/undefined/vacío/espacios → null", () => {
  assertEquals(parsearEmailOpcional(null), null);
  assertEquals(parsearEmailOpcional(undefined), null);
  assertEquals(parsearEmailOpcional(""), null);
  assertEquals(parsearEmailOpcional("   "), null);
});

Deno.test("parsearEmailOpcional: mail mal formado → null (nunca llega a Calendly)", () => {
  assertEquals(parsearEmailOpcional("no es un mail"), null);
  assertEquals(parsearEmailOpcional("falta-arroba.com"), null);
});

Deno.test("parsearEmailOpcional: mail válido → normalizado (trim + lowercase)", () => {
  assertEquals(
    parsearEmailOpcional("  Minecerda2014@Gmail.com  "),
    "minecerda2014@gmail.com",
  );
  assertEquals(
    parsearEmailOpcional("paciente@ejemplo.com"),
    "paciente@ejemplo.com",
  );
});
