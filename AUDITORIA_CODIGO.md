# Auditoría de calidad de código y organización — `open-bsp-api`

> Revisión hecha el 2026-08-08 sobre la branch `feat/rediseno-guardrail-v2`
> (HEAD `5764463`). Alcance: `supabase/functions/` completo, con foco en
> `agent-client/` (el agente de WhatsApp del consultorio), más el esquema SQL,
> el CI y el pipeline de deploy.
>
> Criterio: solo se reporta lo que se pudo verificar leyendo el código. Donde
> algo no se puede determinar desde el repo (estado real de la base de
> producción, métricas de latencia reales), se dice explícitamente en vez de
> asumirlo.

---

## 0. Resumen ejecutivo

Este no es un repo mediocre con una lista de quejas. Es un fork de un producto
open source genérico (`open-bsp-api`) sobre el que se construyó un agente médico
con un nivel de rigor **muy por encima del promedio** de lo que se ve en
proyectos de este tipo: los gates de seguridad están en código y no en prompt,
el diseño es fail-closed de forma consistente y deliberada, y los comentarios
documentan el incidente real que motivó cada decisión con fecha y todo. Eso es
raro y es valioso.

Los problemas serios que encontré no están en la lógica del guardrail. Están en
**la frontera entre el código y su entorno**: SQL que se aplica a mano y puede
quedar a medias sin que nadie se entere, tests que existen pero no corre nadie,
y una carrera de concurrencia que el diseño actual no cubre en el camino de
agendar turnos.

**Lo más crítico, en orden:**

| # | Problema                                                                  | Dónde                                                  | Por qué importa                                                                                          |
| - | ------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1 | El SQL del guardrail se aplica a mano, fuera de migraciones y fuera de CI | `supabase/vampiresa_meli/agent_guardrails.sql`         | Ya causó un fallo de 3 días en producción (Incidente 14a). El diseño lo permite otra vez.                |
| 2 | Race condition real en el camino de agendamiento                          | `agent-client/index.ts` + `guardrail/index.ts`         | Dos mensajes seguidos pueden producir dos turnos reales en Calendly. La idempotencia actual no lo cubre. |
| 3 | CI no corre ningún test                                                   | `.github/workflows/check.yml`                          | Hay 3 archivos de test (~1.500 líneas). Ninguno se ejecuta automáticamente.                              |
| 4 | `max_tokens` por defecto (1024) trunca el paso de turnos                  | `guardrail/turnos.ts`                                  | Falla ya observada y documentada, tratada como "pendiente". Produce silencio en el camino más caro.      |
| 5 | Datos de salud en logs de stdout y en tablas sin RLS                      | `agent-client/index.ts:502`, `agent_guardrails.sql:58` | Son datos de salud de pacientes identificables.                                                          |
| 6 | El golden set no corre en CI y duplica el pipeline                        | `guardrail-golden-set/index.ts`                        | Ya certificó 32/32 mientras producción estaba rota (Incidente 13d). Se mitigó parcialmente.              |

---

## 1. Organización del código

### 1.1 La separación en Edge Functions tiene sentido — con una excepción

El corte por función es correcto y sigue una lógica clara de **canal ×
responsabilidad**:

```
whatsapp-webhook    →  recibe de Meta, normaliza, escribe en public.messages
whatsapp-dispatcher →  lee de public.messages, manda a Meta
whatsapp-management →  administración (templates, signup) — no está en el camino del mensaje
```

…replicado idénticamente para `instagram-*` y `generic-*`. La orquestación no la
hace código: la hacen **triggers de Postgres**
(`handle_incoming_message_to_agent`, `handle_outgoing_message_to_dispatcher`)
que llaman a la siguiente función vía `pg_net`. Esto es un buen diseño: cada
función es independiente, testeable por separado, y la tabla `messages` es el
único punto de acoplamiento.

**La excepción:** `agent-client/index.ts` (1.242 líneas) hace demasiadas cosas.
Es a la vez el router de mensajes entrantes, el gate de conversación (contacto
autorizado / pausada / mensaje más nuevo / bienvenida), el selector de agente,
el bucle ReAct genérico del producto open source, **y** el punto de entrada del
guardrail médico. Las dos últimas responsabilidades no tienen nada que ver entre
sí: el guardrail hace `return` en la línea 679 y todo lo que sigue (~560 líneas
de bucle ReAct, MCP, tools genéricas) es código muerto para este negocio.

> **Sugerencia concreta:** extraer las líneas 303-682 a
> `agent-client/pipeline.ts` (los gates de conversación, que son comunes) y
> dejar `index.ts` como un despachador de tres líneas: gates → `runGuardrail()`
> o `runReAct()`. No es cosmético: hoy cualquier cambio en los gates obliga a
> leer 1.200 líneas para entender si afecta al camino médico o al genérico.

### 1.2 `_shared/` no es un cajón de sastre — está bien usado

Esto me sorprendió positivamente. `_shared/` tiene 16 archivos y **cada uno
tiene una razón de existir clara**, no es el típico `utils.ts`:

- `calendly.ts` (951 líneas) — cliente de Calendly. Está acá y no en
  `agent-client/` porque lo usan también `recordatorio-buttons.ts` y el golden
  set. Correcto.
- `fechas.ts` + `fechas_test.ts` — resolución de expresiones de fecha en código.
  Existe por un incidente real (v15) y tiene test propio.
- `telefonos.ts`, `markdown.ts`, `media.ts`, `urls.ts` — cada uno una
  responsabilidad.
- `types/` — 10 archivos de tipos separados por origen (payloads de WhatsApp, de
  Instagram, de la DB). Bien.

El único olor: `supabase.ts` **y** `supabase_client.ts` conviven, y
`db_types.ts` (1.911 líneas, autogenerado) más `types/database_types.ts`
también. No es un problema real, pero un lector nuevo no sabe cuál importar.

### 1.3 Acoplamiento raro: sí, uno

`guardrail-golden-set/` importa directamente de `agent-client/guardrail/`
(`../agent-client/guardrail/anthropic.ts`, `.../turnos.ts`, `.../catalogo.ts`).
Es decir: dos Edge Functions que se despliegan por separado comparten código por
ruta relativa. Funciona porque Deno resuelve en tiempo de bundle, pero significa
que **desplegar `agent-client` sin desplegar `guardrail-golden-set` deja al
arnés de test corriendo una versión vieja del pipeline**. Eso es exactamente lo
que causó el Incidente 13d (golden set 32/32 mientras producción fallaba). Se
mitigó factorizando dos funciones puras (`aplicarOverrideEtapaSobreTipo`,
`calcularSubEstadoParaLlamado`), pero **la mitigación es por convención, no
estructural**: nada impide que la próxima pieza de orquestación vuelva a
duplicarse.

> **Sugerencia:** el golden set debería importar `runGuardrail()` entera y
> mockear sus dependencias (client, tools, envío), en vez de reimplementar el
> pipeline. Hoy no puede porque `runGuardrail` recibe un `SupabaseClient` real y
> escribe en tablas. Inyectar un `enviarMensaje`/`registrarNoEnviada` como
> parámetros opcionales resolvería esto y eliminaría la clase entera de bug.

---

## 2. Calidad del código dentro de `agent-client/`

### 2.1 Lo que está bien hecho (y no es poco)

**El tipado es genuinamente estricto en el módulo que importa.** En todo
`agent-client/guardrail/` (5.000+ líneas) hay **cero** `: any`. Los dos únicos
`: any` del proyecto están en `index.ts` (el código heredado del fork), y ambos
tienen `deno-lint-ignore` con justificación. Se usan uniones discriminadas de
verdad donde corresponde:

```ts
// _shared/calendly.ts — el caller no puede leer `horariosAlternativos`
// sin haber chequeado `motivo` primero. El compilador lo obliga.
export type ResultadoAgendar =
  | { agendado: true; eventUuid: string /* … */ }
  | { agendado: false; motivo: "falta_email" }
  | { agendado: false; motivo: "tipo_turno_ambiguo"; detalle: string }
  | {
    agendado: false;
    motivo: "horario_no_disponible";
    horariosAlternativos: string[]; /* … */
  };
```

**El manejo de errores es consistente y deliberado.** El principio fail-closed
está aplicado en todos los caminos del guardrail, y —lo que es más difícil— las
excepciones al principio están justificadas por escrito:

- `clasificarEtapa()` es **fail-soft** a propósito (etapa.ts:14-20): si falla,
  devuelve la etapa guardada. El razonamiento está escrito: la etapa es tono, no
  seguridad; callar a una paciente por no poder calcular el tono es peor.
- `guardarSubEstado()` es best-effort: "el peor caso es repetir un escalón,
  nunca saltearse uno".
- `ejecutarPasoTurnos()` aborta fail-closed si el modelo pide una segunda tool.

**El sobrecargado de `callStructured` es elegante:** sin `tools` devuelve `T`
directo; con `tools` devuelve una unión discriminada. El caller no puede
olvidarse de manejar el caso `tool_use`.

**La documentación de decisiones es excepcional.** Casi todos los comentarios
largos citan el incidente real, la fecha y el archivo del plan. Ejemplo
(`turnos.ts:100-119`): 20 líneas explicando por qué
`calcularSubEstadoParaLlamado` está acotada a _una_ transición, con el bug que
causó no acotarla (Incidente 13e). Esto es lo que hace mantenible un sistema con
lógica no obvia.

### 2.2 Tamaño de archivos y funciones

| Archivo                 | Líneas | Veredicto                                                                 |
| ----------------------- | ------ | ------------------------------------------------------------------------- |
| `guardrail/prompts.ts`  | 1.836  | Aceptable — es casi todo texto de prompt, no lógica                       |
| `agent-client/index.ts` | 1.242  | **Problema** — ver §1.1                                                   |
| `guardrail/turnos.ts`   | 1.054  | Límite. Mezcla gates, ejecución de tools, formateo de evidencia y el loop |
| `guardrail/index.ts`    | 814    | `runGuardrail()` es **una sola función de ~550 líneas**                   |
| `_shared/calendly.ts`   | 951    | Aceptable — cliente HTTP, funciones chicas                                |

**`runGuardrail()` (index.ts:260-814) es la peor ofensora de legibilidad.** Es
una función lineal de 550 líneas con 8 puntos de `return` tempranos, un bloque
`if (redactor.tipo === "gestion_turno")` de 150 líneas embebido, y un
`while(true)` de reescritura al final. Es _seguible_ porque está impecablemente
comentada, pero no es testeable por partes: no hay forma de probar el loop de
juez/reescritura sin montar todo el pipeline (que es exactamente por qué el
golden set tuvo que duplicarlo).

> **Sugerencia concreta:** extraer tres funciones puras — `cargarContexto()`,
> `ejecutarRedactor()`, `loopJuezReescritura()` — cada una recibiendo lo que
> necesita y devolviendo un resultado. No cambia comportamiento y hace testeable
> el loop de reescritura, que es justamente el que produjo el bug más peligroso
> del proyecto (Incidente 12: el reescritor invirtió una negativa e inventó un
> monto de $20.000).

### 2.3 Duplicación real

1. **`getIncomingBurstText` tiene su docstring duplicado literalmente** —
   `index.ts:106-137` y `index.ts:174-198` son el mismo bloque de 30 líneas de
   comentario, uno de ellos huérfano encima de `indiceInicioTanda`. Cosmético,
   pero confunde al lector sobre qué documenta qué.

2. **El pipeline duplicado en el golden set** — ver §1.3. Este sí es serio.

3. **Cuatro redefiniciones sucesivas del mismo `CHECK` en el SQL**
   (`agent_guardrails.sql` líneas 40, 77, 92, 243). Es intencional (migraciones
   idempotentes acumuladas en un archivo), pero ver §5.1.

### 2.4 Tests: existen, son buenos, y **no los corre nadie**

Hay tres archivos de test:

| Archivo                                     | Líneas | Qué cubre                                                 |
| ------------------------------------------- | ------ | --------------------------------------------------------- |
| `guardrail/prompts_test.ts`                 | 1.209  | 53 tests sobre el contenido de los prompts                |
| `_shared/fechas_test.ts`                    | ~100   | Resolución de fechas (reproduce el incidente real de v15) |
| `agent-client/recordatorio-buttons_test.ts` | ~200   | Ruteo de botones del recordatorio                         |

**El CI no ejecuta `deno test`.** `.github/workflows/check.yml` corre
únicamente:

```yaml
- run: deno fmt --check
- run: cd supabase/functions && deno lint && deno check .
- run: cd plugin && deno lint && deno check .
```

Esto significa que los 53 tests de `prompts_test.ts` —que codifican reglas de
seguridad médica— solo se verifican cuando alguien se acuerda de correrlos a
mano. El documento de lecciones registra que sí se corren en la práctica ("53/53
tests"), pero eso es disciplina humana, no una garantía.

> **Sugerencia (una línea):** agregar
> `- run: cd supabase/functions && deno test -A` al workflow. Es el cambio con
> mejor relación costo/beneficio de toda esta auditoría.

Además, hay una **cobertura desbalanceada**: `prompts.ts` (texto) tiene 53
tests, pero `turnos.ts` (que contiene los gates de seguridad de código —
`validarGateAgendar`, `proximoSubEstado`, `toolsParaSubEstado`) **no tiene
ningún test unitario**. Son funciones puras, triviales de testear, y son
literalmente lo que impide que se agende un turno inventado. Ese es el hueco de
testing más importante del repo.

---

## 3. Gestión de estado y persistencia

### 3.1 Dónde vive el estado

No hay una tabla de "sesión de conversación". El estado está repartido:

| Estado                       | Dónde                                       | Cómo se escribe                    |
| ---------------------------- | ------------------------------------------- | ---------------------------------- |
| Historial de mensajes        | `public.messages`                           | Insert por cada mensaje            |
| Etapa de conversación        | `contacts.extra.etapa` (JSONB)              | RPC `merge_contact_datos_contacto` |
| Sub-estado de agendamiento   | `contacts.extra.agendamiento_estado`        | mismo RPC                          |
| Mail / nombre de la paciente | `contacts.extra.email` / `.nombre_completo` | mismo RPC                          |
| Conversación pausada         | `conversations.extra.paused`                | trigger de Postgres                |
| Acciones sobre turnos        | `public.turno_acciones`                     | insert + update                    |
| Costo de LLM                 | `public.agent_llm_calls`                    | insert fire-and-forget             |
| Respuestas no enviadas       | `public.agent_respuestas_no_enviadas`       | insert                             |

**Lo bien resuelto:** el merge en `contacts.extra` se hace con un **RPC atómico
en SQL** (`merge_contact_datos_contacto`), no con un read-modify-write desde
TypeScript. Eso evita que dos escrituras concurrentes se pisen los campos entre
sí. Es la decisión correcta y está bien ejecutada.

### 3.2 Race conditions: hay una real, y está en el peor lugar posible

El sistema tiene dos defensas contra mensajes concurrentes del mismo contacto:

1. **Debounce** (`RESPONSE_DELAY_SECS`, configurado en 6s para esta org): la
   función espera antes de procesar.
2. **"Gana el más nuevo"** (`getNewestIncomingMessage`): si mientras esperaba
   llegó un mensaje más nuevo, esta invocación se descarta.

El bucle ReAct genérico **re-chequea** si llegó un mensaje nuevo en cada
iteración (`index.ts:815-832`). **El camino del guardrail no lo hace.**

Concretamente: `runGuardrail()` puede tardar entre 2 y 5 llamadas a Claude, y el
paso de turnos tiene un deadline de **55 segundos** (`DEADLINE_MS`, subido de
25s porque 25s no alcanzaba). Durante esa ventana:

- Llega un mensaje nuevo de la misma paciente → dispara una **segunda invocación
  concurrente** de `agent-client`.
- La segunda pasa el chequeo de "más nuevo" (ella _es_ la más nueva).
- Las dos corren `runGuardrail` en paralelo, contra el mismo contacto.

**Consecuencias verificables en el código:**

- **Doble turno.** La idempotencia de `agendar_turno` es un índice único sobre
  `(incoming_message_id, tool)` (`agent_guardrails.sql:261`). Dos mensajes
  distintos = dos `incoming_message_id` distintos = **el índice no protege
  nada**. Si la paciente manda "dale, a las 11" y un segundo después "sí,
  confirmalo", ambos pueden llegar a `lista_para_agendar` y ejecutar
  `agendarTurno` contra Calendly. El único freno es que el segundo slot ya no
  esté libre — pero Calendly puede tener varios slots ese día.
- **Sub-estado pisado.** Las dos invocaciones leen el mismo sub-estado inicial y
  escriben resultados distintos. El RPC es atómico por campo, pero el orden de
  llegada decide cuál gana.

> **Sugerencia concreta:** añadir un lock por conversación. La forma más barata
> dado el esquema actual es un
> `pg_advisory_xact_lock(hashtext(conversation_id))` al principio del camino de
> guardrail, o mover la idempotencia de `turno_acciones` de
> `incoming_message_id` a una clave de negocio —
> `(contact_address, fecha_hora, tipo_turno)` — que sí colisiona entre dos
> mensajes distintos que intentan el mismo turno. Lo segundo es más simple y
> ataca directamente el daño (doble turno real a una paciente).

### 3.3 Versionado de esquema: existe para el core, **no** para lo del guardrail

- El esquema core está bien: 72 migraciones en `supabase/migrations/`, generadas
  por `supabase db diff` desde `supabase/schemas/`, con el flujo documentado en
  `CLAUDE.md`.
- **Todo el esquema del guardrail está fuera de ese sistema.**
  `supabase/vampiresa_meli/agent_guardrails.sql` (426 líneas) crea 3 tablas y 2
  funciones, y su propio encabezado dice: _"no se aplica vía CI — se corre una
  sola vez a mano en el SQL editor"_. Verificado: `grep` de `turno_acciones`,
  `agent_llm_calls` y `merge_contact_datos_contacto` en `migrations/` y
  `schemas/` no devuelve **nada**.

Esto no es teórico. Ya falló: el Incidente 14a documenta que
`merge_contact_datos_contacto()` **nunca se corrió en producción**, el código
que la llamaba estuvo deployado 3 días fallando el 100% de las veces, y no se
detectó porque las tres llamadas son best-effort (loguean y siguen). El síntoma
visible fue "el bot vuelve a pedir el mail cada vez", que parece un problema de
prompt.

**El mismo diseño permite una falla más silenciosa todavía**, que quiero dejar
señalada porque no está documentada en ningún lado:

El `CHECK` de `tipo_declarado` se redefine cuatro veces en el archivo. Solo la
última (línea 243) incluye `'gestion_turno'`. Si esa sección puntual no se
corriera —igual que pasó con el RPC—, **cada `registrarNoEnviada()` del camino
de agendamiento fallaría con violación de constraint**, y el error solo se
loguea (`guardrail/index.ts:210`). Resultado: el log de auditoría perdería en
silencio exactamente los fallos del camino más caro y más riesgoso del sistema,
que es justamente el que más se necesita auditar.

> **Sugerencia concreta:** mover `agent_guardrails.sql` a `supabase/migrations/`
> aunque sea partiéndolo en migraciones idempotentes. Si por decisión de
> producto tiene que quedar fuera (es específico de un tenant), entonces agregar
> un **chequeo de arranque**: que `runGuardrail` verifique una vez por isolate
> que el RPC existe y que el `CHECK` acepta `gestion_turno`, y que loguee
> `error` bien visible si no. El costo es una query; el beneficio es no repetir
> un fallo de 3 días.

---

## 4. El guardrail redactor/juez

### 4.1 El diseño "etapa + sub-estado" está bien implementado

Es una máquina de estados de dos niveles:

- **Etapa** (`explorando` → `quiere_agendar` → `agendando` → `agendado`) — la
  calcula un clasificador LLM aparte, mirando la conversación completa. Es
  deliberadamente "pegajosa".
- **Sub-estado** (`recolectando_horario` → `confirmando_datos` →
  `lista_para_agendar` → `agendado`) — solo vive dentro del flujo de turnos.

**Lo que hace robusto este diseño no es el prompt, es que las transiciones las
valida el código:**

```ts
// turnos.ts::proximoSubEstado — el modelo propone, el código dispone
if (iPropuesto <= iActual) return actual; // no se retrocede
const destino = ORDEN_SUB_ESTADOS[Math.min(iPropuesto, iActual + 1)]; // 1 escalón/mensaje
if (destino === "agendado") return actual; // solo el código llega acá
if (
  destino === "lista_para_agendar" && !(datos.email && datos.nombreCompleto)
) {
  return "confirmando_datos"; // sin datos, no se abre el gate
}
```

Y el gate de tools es de **exposición**, no de instrucción: `agendar_turno`
literalmente no viaja en el request si el sub-estado no es `lista_para_agendar`
(`toolsParaSubEstado`). El modelo no puede llamarla aunque un prompt injection
se lo pida. Esta es la decisión de arquitectura más importante y más acertada de
todo el sistema.

### 4.2 Dónde es frágil

**(a) El override de etapa sobre tipo es un instrumento contundente.**

```ts
// turnos.ts::aplicarOverrideEtapaSobreTipo
if (
  (etapa === "agendando" || etapa === "agendado") &&
  tipo !== "silencio" && tipo !== "seguimiento_tratamiento" &&
  tipo !== "gestion_turno"
) {
  return "gestion_turno";
}
```

Resuelve el Incidente 13a (mensajes cortos de continuación que perdían el hilo),
pero el efecto colateral es que **una paciente en medio de un agendamiento que
pregunta cualquier otra cosa** —"¿cuánto sale?", "¿dónde queda el consultorio?",
"¿aceptan tarjeta?"— es forzada a `gestion_turno`, un paso que no tiene el
catálogo de precios ni la FAQ operativa como fuente principal. Las dos
excepciones de seguridad (`silencio`, `seguimiento_tratamiento`) están bien
elegidas, pero `faq` y `catalogo` no están entre ellas. No encontré ningún caso
del golden set que ejercite este escenario. Es un hueco real y probable.

**(b) La etapa depende de un LLM y es pegajosa por diseño.** Si el clasificador
se equivoca y marca `agendando`, esa etapa persiste en `contacts.extra` y se usa
como fallback ante cualquier fallo posterior (`clasificarEtapa` es fail-soft).
Una etapa mal clasificada se auto-perpetúa hasta que otro llamado la corrija.

**(c) `max_tokens` no se dimensiona por paso — y ya rompió algo.** El paso de
turnos usa `llamado.maxTokens ?? 1024`. Como `agent.extra.max_tokens` está sin
definir, todos los pasos usan 1024. El propio documento de lecciones registra
que `subestado_confirma_datos_guardados` falla **2/2 corridas** con
`"Respuesta truncada por max_tokens"`, y está anotado como "no investigado a
fondo". Es un bug real con causa conocida: el paso de turnos genera la respuesta
_más larga_ del pipeline (mensaje + `datos_detectados` + `avanzar_a`) y comparte
el mismo techo que el clasificador de etapa, que necesita 128.

> **Sugerencia (una línea):** `maxTokens: llamado.maxTokens ?? 2048` en
> `ejecutarPasoTurnos`. `etapa.ts` ya hace lo correcto (fija 128 explícitamente
> para no pagar 1024 en cada mensaje); el paso de turnos necesita el ajuste en
> la dirección opuesta.

### 4.3 Versionado (`PROMPT_VERSION`) y pruebas

**El versionado funciona y es disciplinado.** `PROMPT_VERSION` está en **22**
(nota: el brief de esta tarea decía 21 — la constante se movió en el commit
`5764463`, así que cualquier documentación externa que diga 21 está desfasada).
Cada versión está mapeada a un commit y a un incidente en
`P05_lecciones_guardrail.md`, con instrucciones para reconstruir el texto exacto
(`git show <hash>:.../prompts.ts`). Es mejor trazabilidad de prompts que la que
tiene la mayoría de los equipos.

**El golden set: fortalezas reales.**

- 34 casos, con fixtures inyectables para Calendly (nunca toca la API real).
- Fija el instante "ahora" por caso (`ahora?: Date`) para que los casos con "el
  miércoles" sean deterministas.
- El mock de disponibilidad **reusa `formatearFechaCalendarioDMY` del módulo
  real** — corrección explícita tras descubrir (Incidente 9) que el mock tenía
  el mismo bug de timezone que el código y por eso lo ocultaba.
- La cultura alrededor es sana: está escrito y aceptado que **no se persigue el
  100%**, porque un pipeline de dos LLMs no es una suite determinista y el valor
  del set es _comparativo_ (antes/después de un cambio).

**Debilidades:**

1. **Es manual.** Se ejecuta haciendo POST a una Edge Function desplegada. No
   está en CI, no hay umbral, no hay histórico de corridas versionado. El
   registro de resultados vive en un `.md` de otro repo, escrito a mano.
2. **Duplica el pipeline** (§1.3) — ya certificó verde con producción rota.
3. **No cubre las reglas más nuevas.** El propio documento de lecciones lo
   admite sobre v22: _"el golden set actual no tiene ningún caso que ejercite
   ninguna de las dos reglas nuevas"_. Es decir: se cambió el prompt de tono y
   no hay forma de verificar que el cambio hizo algo.
4. **Cobertura sesgada.** De 34 casos, ~20 son de agendamiento y disponibilidad.
   Categorías enteras de fallo real no tienen ni un caso: cancelación,
   reprogramación, doble turno, contraindicaciones médicas, cambio de tema
   dentro del agendamiento, datos de contacto malformados.

> Esto último es lo que aborda el tercer entregable (`GOLDEN_SET_AMPLIADO.md` +
> `casos_ampliados.ts`).

---

## 5. Tools y function-calling

### 5.1 Las tools están bien definidas

Solo **dos** tools se exponen al modelo: `consultar_disponibilidad` (lectura,
siempre) y `agendar_turno` (escritura, solo en `lista_para_agendar`). Las demás
operaciones son código:

- `consultarTurno` la ejecuta el código **siempre**, nunca a pedido del modelo,
  y **el teléfono nunca sale de los argumentos del modelo** — siempre de
  `conversation.contact_address` (`turnos.ts:702`). Excelente decisión: elimina
  de raíz que un prompt injection consulte los turnos de otra persona.
- `cancelar_turno` **no se expone como tool**. Se pasa el `cancel_url` literal
  que ya trajo Calendly. Menos superficie, cero riesgo de cancelar el turno
  equivocado.

### 5.2 Validación antes de ejecutar acciones reales: fuerte, con un punto débil

`validarGateAgendar()` (`turnos.ts:481-573`) valida, **en código**, antes de
tocar Calendly: fecha resoluble, hora en formato `HH:MM`, fecha en el futuro,
email con `@`, nombre no vacío, tratamiento no vacío, y —la parte más
interesante— **evidencia textual de que el día y la hora aparecen en la
conversación**:

```ts
if (!evidenciaDiaEncontrada(expr, textoNormalizado)) {
  return { ok: false, motivo: "…posible fecha inventada" };
}
if (
  !textoNormalizado.includes(hora.slice(0, 2)) &&
  !textoNormalizado.includes(horaNum)
) {
  return { ok: false, motivo: "…posible hora inventada" };
}
```

El propio código la llama "heurística barata, NO una verificación semántica
real", lo cual es honesto y correcto.

**El punto débil:** el chequeo de hora es un `includes` de substring sobre el
texto normalizado de toda la conversación. `"11"` matchea contra "11 de agosto",
"$11.000", "tengo 11 lunares" o un mail que contenga `11`. En una conversación
larga la probabilidad de un falso positivo tiende a 1, lo que degrada el gate a
casi siempre-pasa. No es explotable de forma trivial, pero tampoco protege lo
que dice proteger.

> **Sugerencia:** matchear contra el texto con una expresión que exija contexto
> horario (`\b11\s*(hs?|:00|horas)?\b`) o, mejor, limitar la búsqueda a los
> últimos 2-3 turnos en vez de a toda la conversación.

### 5.3 Qué pasa si el LLM alucina una tool call inválida

Bien cubierto, en tres capas:

1. **Schema garantizado.** Se usa la Messages API nativa con
   `output_config.format` en vez de la capa de compatibilidad OpenAI. El
   comentario de `anthropic.ts:5-25` documenta _por qué_: esa capa **ignora en
   silencio** `response_format` y `strict`. Para un juez que debe devolver un
   booleano confiable, "casi siempre parsea" no alcanza. Verifiqué esta
   afirmación contra la documentación actual de la API: es correcta.
2. **Tool desconocida** → `motivo: "tool desconocida pedida por el modelo"`,
   corte.
3. **Tool no expuesta** (`agendar_turno` fuera de `lista_para_agendar`) → error
   explícito y abort, no warning.
4. **Segunda tool en el mismo mensaje** → abort fail-closed
   (`MAX_TOOL_CALLS = 1`).

En el bucle ReAct genérico (código del fork), la validación es distinta pero
también existe: se valida el input contra el JSON Schema con **Ajv** antes de
ejecutar (`index.ts:1000-1024`).

### 5.4 Efectos reales de cada tool

| Tool                       | Efecto real                                                                                               | Reversible           |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| `consultar_disponibilidad` | Ninguno (GET a Calendly)                                                                                  | —                    |
| `agendar_turno`            | **Crea un turno real en Calendly**, manda mail de confirmación al paciente, ocupa la agenda de la doctora | Sí, vía `cancel_url` |
| `consultarTurno` (código)  | Ninguno (GET)                                                                                             | —                    |
| Cancelación (recordatorio) | **Cancela un turno real en Calendly**                                                                     | No                   |

`agendar_turno` y la cancelación por botón son las dos únicas escrituras contra
un sistema externo. Ambas están registradas (`turno_acciones`,
`vampiresa_meta_sends_log`). Bien.

---

## 6. Seguridad

### 6.1 Lo que está bien

- **Firma de webhooks de Meta: sí se valida.**
  `whatsapp-webhook/index.ts:117-195` hace HMAC-SHA256 de `X-Hub-Signature-256`
  con `META_APP_SECRET`. Soporta múltiples apps (`APP_ID`/`APP_SECRET` separados
  por `|`). Instagram hace lo mismo. Si falta el secret, devuelve `false`
  (fail-closed).
- **Autenticación entre funciones:** las internas (`agent-client`,
  `*-dispatcher`, `media-preprocessor`, `storage-gc`) exigen
  `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`. El token lo inyecta el
  trigger desde `vault.decrypted_secrets` — no está hardcodeado.
- **Secretos por variable de entorno**, no en el repo. `.env.example` sin
  valores. El workflow de release los pasa por `secrets`/`vars` de GitHub.
- **El teléfono de la paciente nunca lo provee el modelo** (§5.1).
- **Hay defensa explícita contra prompt injection**: los turnos de la paciente
  se cercan en `<mensaje_paciente>` tanto en el mensaje actual como en el
  historial (`getRecentHistoryTurns`), con el criterio escrito de "no bajar la
  guardia en los turnos históricos". Y el `CHEQUEO 1` del juez prohíbe armar una
  lista completa de precios, que era el objetivo de injection identificado.

### 6.2 Lo que hay que arreglar

**(a) Comparación de firma no es de tiempo constante.**
`whatsapp-webhook/index.ts:180` hace `signatureValue === expectedSignature`
sobre strings. Es un oráculo de timing teórico. En la práctica, sobre HTTP y con
jitter de red, explotarlo contra Edge Functions es poco realista — pero el
arreglo es trivial (comparar byte a byte acumulando con XOR, o
`crypto.subtle.verify`) y es el tipo de detalle que un auditor externo va a
marcar.

**(b) Falta de firma en el log de fallo.** Cuando la firma no valida, se loguea
`{ expected, received }` (`index.ts:183-186`) — es decir, **se escribe el HMAC
esperado en los logs**. Con acceso de lectura a logs, eso facilita forjar
peticiones. Loguear solo "firma inválida" + el `app_id`.

**(c) API keys de LLM en la base de datos.** `guardrail/index.ts:338`:

```ts
const apiKey = agent.extra.api_key ?? Deno.env.get("ANTHROPIC_API_KEY");
```

`agents.extra` es una columna JSONB. Una API key de Anthropic puede vivir ahí,
lo que la expone a cualquier consulta que lea esa fila, a los backups, y a la UI
si alguna vez muestra `extra`. La variable de entorno es el camino correcto; el
fallback a DB debería eliminarse o, como mínimo, moverse a Supabase Vault.

**(d) Datos de salud en logs de stdout.** Estos son datos de salud de personas
identificables (van asociados a un número de teléfono):

```ts
log.info("Contact request", messages.at(-1)?.content); // index.ts:502
log.info("Agent response", response.messages.at(-1)?.content); // index.ts:1175
log.info("Guardrail — resultado", result); // index.ts:677
```

`log.info("Contact request", …)` escribe **el texto crudo del mensaje de la
paciente** en `function_logs`, con la retención que tenga Supabase por defecto,
accesible a cualquiera con acceso al proyecto. Un mensaje como el del caso
`seguimiento_quemadura` ("la doctora me hizo un tratamiento y me salió como una
quemadura en la cara") es un dato clínico. En Argentina aplica la Ley 25.326
(datos sensibles de salud); si alguna vez hay pacientes de la UE, GDPR Art. 9.

> **Sugerencia:** loguear `content.type` y longitud, no el texto. Si hace falta
> el texto para depurar, ponerlo detrás de una variable de entorno
> (`LOG_MESSAGE_BODIES=1`) apagada en producción.

**(e) Tablas de datos de pacientes sin RLS.** El propio SQL lo dice
(`agent_guardrails.sql:58-62`): _"se deja SIN habilitar… Si en algún momento
esta tabla se expone en la UI, HAY que habilitar RLS"_.
`agent_respuestas_no_enviadas` contiene `mensaje_paciente` en texto plano y
`contact_address` (teléfono). Hoy solo la escribe el service role, pero
PostgREST expone el esquema `public` por la API REST: **una clave anon o un JWT
de usuario con permiso de `select` sobre esa tabla podría leer mensajes de
pacientes de cualquier organización.** No verifiqué los `GRANT` reales sobre la
base de producción (no tengo acceso), así que no puedo afirmar que sea
explotable hoy — pero el diseño depende de que nadie otorgue ese permiso, y eso
no es una garantía.

**(f) No hay rate limiting propio.** Se manejan los códigos de rate limit _de
Meta_ (429, 130429, 80007) en los dispatchers, pero no hay límite sobre cuántos
mensajes puede disparar un mismo `contact_address` hacia el agente. Cada mensaje
entrante = entre 2 y 5 llamadas a Claude + hasta 4 llamadas a Calendly. Un
número que mande 100 mensajes seguidos genera costo real y puede agotar el rate
limit de Calendly para el resto de las pacientes. El debounce de 6s mitiga
mensajes de tipeo rápido, no un abuso deliberado.

---

## 7. Deploy y operación

### 7.1 Cómo se despliega (y la documentación no coincide con la realidad)

`CLAUDE.md` afirma:

> _"Migrations apply automatically via CI: pushing to `origin/develop` deploys
> to DEV, pushing to `origin/main` deploys to PROD."_

Pero `.github/workflows/release.yml` tiene el trigger de push **comentado**:

```yaml
on:
  # Using Supabase GitHub integration instead
  #push:
  #  branches: [main, develop]
  workflow_dispatch:
```

El despliegue real lo hace la **integración de GitHub de Supabase** (hay un
archivo `.trigger_deploy` con fecha 2026-07-23 confirmándolo). Eso despliega
funciones y migraciones, pero **no** los archivos de `supabase/vampiresa_meli/`
(§3.3), y tampoco `config.toml` (el propio comentario del archivo lo advierte
para el servidor OAuth). Resultado: hay **tres** mecanismos de despliegue
distintos (integración GitHub, workflow manual, SQL a mano) y la documentación
describe uno que no está activo.

> **Sugerencia:** corregir `CLAUDE.md` y el README para que digan cuál es el
> camino real, y listar explícitamente qué queda fuera (SQL de tenant,
> `config.toml`).

### 7.2 Staging vs producción

El workflow de release _tiene_ la separación (`environment: Production` si es
`main`, si no `Staging`), y existe una rama `origin/develop`. Pero como ese
workflow no se dispara por push, la separación depende de cómo esté configurada
la integración de Supabase, que no es visible desde el repo. **No puedo
determinar desde el código si hoy existe un entorno de staging efectivo.** Lo
que sí veo es que el flujo real descrito en el documento de lecciones es
"deployado a `velvet-agent`" (el proyecto de producción) directamente desde
ramas `feat/*`, y que el golden set se corre **contra producción**. Eso implica
que no hay un entorno intermedio en uso práctico.

### 7.3 Observabilidad: buena en costo, incompleta en trazabilidad

**Muy bien:**

- `agent_llm_calls` registra **una fila por llamada a Claude** con modelo,
  tokens de entrada/salida, tokens de caché (lectura y escritura por separado,
  correctamente, porque tienen precios distintos), latencia y `step`. Es más
  observabilidad de costo de LLM que la que tiene la mayoría de los productos en
  producción.
- `turno_acciones` distingue `intentado` / `ok` / `error` / `bloqueado`. El
  estado `bloqueado` (el gate de código dijo que no) es exactamente el que hay
  que auditar y está separado.
- Se pasan headers de trazabilidad a Anthropic (`organization-id`,
  `conversation-id`, `agent-id`).

**Huecos:**

1. **No hay un id de correlación por invocación.** Para reconstruir "qué pasó
   con el mensaje X" hay que cruzar `function_logs` (por timestamp) con
   `agent_llm_calls` (por `conversation_id`) y `agent_respuestas_no_enviadas`.
   No hay una clave común. Agregar `incoming_message_id` a `agent_llm_calls`
   costaría una columna y resolvería el 80% de las depuraciones.
2. **Los inserts de observabilidad son fire-and-forget.** Si `agent_llm_calls`
   falla, se traga el error. Es la decisión correcta para no tumbar una
   respuesta, pero significa que **los datos de costo pueden tener huecos
   silenciosos** — y ya vimos (Incidente 14a) que un fallo best-effort puede
   durar días sin detectarse.
3. **El logger usa directivas de color CSS** (`%c`, `color: blue`) pensadas para
   la consola del navegador. En `function_logs` de Supabase eso queda como ruido
   literal en cada línea.
4. **No hay alertas.** `agent_respuestas_no_enviadas` es explícitamente "para
   revisión humana en bloque, no dispara nada". Es una decisión de producto
   consciente y documentada — pero significa que si el bot deja de responder al
   100% de las pacientes, nadie se entera hasta que alguien mira la tabla.
5. **Sin indicador de "escribiendo…" en el camino del guardrail.** Es deliberado
   y está justificado (uno de los resultados posibles es no responder). Pero
   combinado con el deadline de 55s del paso de turnos, una paciente puede
   esperar un minuto sin ninguna señal.

---

## 8. Resumen de acciones sugeridas, por relación costo/beneficio

| Prioridad | Acción                                                                                                                       | Esfuerzo                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 🔴 1      | Añadir `deno test -A` al CI                                                                                                  | 1 línea                 |
| 🔴 2      | `maxTokens: 2048` en `ejecutarPasoTurnos`                                                                                    | 1 línea                 |
| 🔴 3      | Dejar de loguear el texto de los mensajes de pacientes                                                                       | ~3 líneas               |
| 🔴 4      | Cambiar la clave de idempotencia de `turno_acciones` a `(contact_address, fecha_hora)` para cubrir la carrera de doble turno | 1 migración + 1 función |
| 🟠 5      | Tests unitarios de `validarGateAgendar` / `proximoSubEstado` / `toolsParaSubEstado`                                          | ~2 h                    |
| 🟠 6      | Chequeo de arranque de que el RPC y el `CHECK` existen en la base                                                            | ~1 h                    |
| 🟠 7      | Sacar el fallback de `api_key` desde `agents.extra`                                                                          | ~30 min                 |
| 🟠 8      | Habilitar RLS en las 3 tablas del guardrail                                                                                  | 1 migración             |
| 🟡 9      | Extraer `runGuardrail` en 3 funciones y hacer que el golden set llame al pipeline real                                       | ~1 día                  |
| 🟡 10     | Comparación de firma en tiempo constante + no loguear el HMAC esperado                                                       | ~30 min                 |
| 🟡 11     | Corregir `CLAUDE.md`/README sobre el flujo real de deploy                                                                    | ~30 min                 |
| 🟡 12     | `incoming_message_id` en `agent_llm_calls`                                                                                   | 1 migración             |

---

## 9. Lo que está bien y conviene no romper

Para que esta auditoría no se lea como una lista de quejas, dejo explícito lo
que considero que hay que **preservar** en cualquier refactor futuro:

1. **Los gates de seguridad en código, no en prompt.** `toolsParaSubEstado`,
   `validarGateAgendar`, `proximoSubEstado`, `tool_choice` forzado. Cada uno
   nació de un incidente en el que el prompt no alcanzó. No los conviertan en
   reglas de texto.
2. **El teléfono nunca viene del modelo.**
3. **Fail-closed por defecto, con las excepciones justificadas por escrito.**
4. **La Messages API nativa en vez de la capa de compatibilidad**, por el motivo
   documentado en `anthropic.ts`.
5. **La cultura del golden set:** comparativo, no absoluto; no perseguir el
   100%; correrlo antes de decir "está listo".
6. **La disciplina de documentar el porqué.** Los comentarios largos de este
   repo son la razón por la que fue posible hacer esta auditoría en una sesión.
