// Tests de la lógica pura de ruteo de botones del recordatorio de turno
// (parseo del payload entrante, sin tocar red ni base de datos).
//
// No hay un patrón de test ya establecido en este repo para features
// similares (el guardrail redactor/juez tampoco tiene tests automatizados),
// así que se sigue la convención idiomática de Deno: `deno test` descubre
// archivos `*_test.ts` sin configuración adicional.

import { assertEquals } from "jsr:@std/assert@1";
import type { MessageRow } from "../_shared/supabase.ts";
import {
  esBotonRecordatorio,
  extraerTituloBoton,
} from "./recordatorio-buttons.ts";

function botonContent(text: string): MessageRow["content"] {
  return {
    version: "1",
    type: "data",
    kind: "button",
    data: { text, payload: text.toUpperCase() },
  } as MessageRow["content"];
}

function interactiveButtonReplyContent(title: string): MessageRow["content"] {
  return {
    version: "1",
    type: "data",
    kind: "interactive",
    data: {
      type: "button_reply",
      button_reply: { id: "id-1", title },
    },
  } as MessageRow["content"];
}

function interactiveListReplyContent(title: string): MessageRow["content"] {
  return {
    version: "1",
    type: "data",
    kind: "interactive",
    data: {
      type: "list_reply",
      list_reply: { id: "id-1", title },
    },
  } as MessageRow["content"];
}

function textContent(text: string): MessageRow["content"] {
  return {
    version: "1",
    type: "text",
    kind: "text",
    text,
  } as MessageRow["content"];
}

Deno.test("extraerTituloBoton — quick-reply de template (type: button)", () => {
  assertEquals(extraerTituloBoton(botonContent("Confirmo")), "Confirmo");
  assertEquals(extraerTituloBoton(botonContent("Reprogramar")), "Reprogramar");
  assertEquals(extraerTituloBoton(botonContent("Cancelar")), "Cancelar");
});

Deno.test("extraerTituloBoton — botón de mensaje interactivo (button_reply)", () => {
  assertEquals(
    extraerTituloBoton(interactiveButtonReplyContent("Confirmo")),
    "Confirmo",
  );
});

Deno.test("extraerTituloBoton — list_reply no es un botón, se ignora", () => {
  assertEquals(
    extraerTituloBoton(interactiveListReplyContent("Confirmo")),
    undefined,
  );
});

Deno.test("extraerTituloBoton — mensaje de texto no es un botón", () => {
  assertEquals(extraerTituloBoton(textContent("Confirmo")), undefined);
});

Deno.test("esBotonRecordatorio — reconoce los 3 botones del template", () => {
  assertEquals(esBotonRecordatorio("Confirmo"), true);
  assertEquals(esBotonRecordatorio("Reprogramar"), true);
  assertEquals(esBotonRecordatorio("Cancelar"), true);
});

Deno.test("esBotonRecordatorio — rechaza texto libre y undefined", () => {
  assertEquals(esBotonRecordatorio("Hola, tengo una consulta"), false);
  assertEquals(esBotonRecordatorio(undefined), false);
  assertEquals(esBotonRecordatorio(""), false);
});
