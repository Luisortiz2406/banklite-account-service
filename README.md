# Account Service (`account-service`)

[![CI](https://github.com/Luisortiz2406/banklite-account-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Luisortiz2406/banklite-account-service/actions/workflows/ci.yml)

Cuentas de ahorro de los clientes, sus límites y estado, cuentas de comercio y llaves Bre-B.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Administra las cuentas bancarias. Una cuenta solo se **activa** cuando llega el evento
`identity.verified` de kyc-service. Es la fuente de verdad de *a quién pertenece* cada
cuenta, su estado y sus límites diario y mensual; el saldo **no** vive aquí sino en
ledger-service. También registra las **llaves Bre-B** (correo, documento o alfanumérica)
que transfer-service resuelve para enviar dinero, y la **cancelación de la cuenta** por
parte del cliente (cierra todas sus cuentas y avisa al resto de servicios).

**Reglas de negocio principales**

- Número de cuenta único de 11 dígitos; una cuenta `merchant` por convenio (idempotente por código).
- Estados `pending` → `active` (al verificarse la identidad), `blocked` y `closed`; una cuenta bloqueada o cerrada no mueve dinero.
- Límites diario y mensual por cuenta (el ledger los consulta antes de cada débito).
- Llaves Bre-B: formato validado en el servidor, una por tipo, registro y borrado con clave dinámica.
- El cliente solo ve y modifica sus cuentas; el panel cambia estado y límites (solo `admin`).
- **Cancelar la cuenta** (ver abajo): saldo en $0 y nada pendiente en ahorro, recargas ni
  revisiones de seguridad; confirmación con clave + código por WhatsApp (ticket de cierre de
  auth, un solo uso) y la palabra `CANCELAR`. Cierra todas las cuentas del cliente (no se
  borran), libera sus llaves Bre-B, publica `account.closed` y cierra el acceso en auth.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | `account.closed` (outbox) → card y notification |
| Consume eventos | `identity.verified` (kyc) → crea/activa la cuenta (cola con reintentos y DLQ) |
| Llama a | auth-service: clave dinámica (llaves Bre-B) y cierre del acceso al cancelar<br>kyc-service: nombre del titular<br>ledger-service: saldo de cada cuenta al cancelar<br>savings, deposit y fraud: `resumen-cierre` (lo que impide cancelar) |
| Lo llaman | ledger, card, payment y transfer: datos de la cuenta (`/internal/accounts/*`)<br>api-gateway (rutas `/accounts/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/accounts`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`account_db`)

| Tabla | Contenido |
|---|---|
| `accounts` | Cuentas (titular, número, tipo, moneda, estado, límites). |
| `breb_keys` | Llaves Bre-B registradas. |
| `identity_verifications` | Proyección de `identity.verified` (idempotencia del evento). |
| `admin_audit` | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| `account_closures` | Una fila por cliente que canceló: fecha, cuentas cerradas y ticket usado. |
| `closure_ticket_uses` | Tickets de cierre ya usados (`jti`, clave primaria): un solo uso. |
| `account_outbox` | Eventos por publicar en RabbitMQ (`account.closed`), guardados en la misma transacción. |
| `auth_access_tasks` | Tarea "cerrar el acceso en auth" de cada cierre: intentos, próximo intento y último error. |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb account_db
psql "postgres://usuario:clave@localhost:5432/account_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-account-service .
docker run --env-file .env -p 3002:3002 banklite-account-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3002/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/accounts/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/accounts/create` | Abre una cuenta para el cliente de la sesión. |
| GET | `/accounts` | Cuentas del cliente. |
| GET | `/accounts/:account_id/limits` | Límites diario y mensual de la cuenta. |
| PUT | `/accounts/:account_id/status` | Cambia el estado de una cuenta propia. |
| GET | `/accounts/:account_id` | Detalle de una cuenta propia. |
| GET | `/accounts/keys` | Llaves Bre-B del cliente. |
| GET | `/accounts/keys/lookup` | Consulta a quién pertenece una llave (nombre enmascarado) antes de transferir. |
| POST | `/accounts/keys` | Registra una llave Bre-B (exige clave dinámica). |
| POST | `/accounts/keys/:type/remove` | Elimina una llave Bre-B (exige clave dinámica). |
| GET | `/accounts/cierre/requisitos` | Qué falta para cancelar la cuenta: `puedeCancelar`, `cuentas` (con su saldo) y `pendientes` (código y mensaje). |
| POST | `/accounts/cierre` | Cancela la cuenta. Cuerpo `{ ticket, confirmacion: "CANCELAR" }`. 403 si el ticket no es válido; 409 si ya se usó o si algo quedó pendiente (con `pendientes`). |

### Cancelar la cuenta

1. El frontend muestra `GET /accounts/cierre/requisitos`. Si hay saldo, ofrece enviarlo antes.
2. Auth confirma la identidad: `POST /auth/cierre/iniciar` (clave → código por WhatsApp) y
   `POST /auth/cierre/confirmar` (código → **ticket de cierre**: JWT HS256 firmado con
   `CLOSURE_TICKET_SECRET`, `type: closure_ticket`, `aud: account-service`, 5 minutos).
3. `POST /accounts/cierre` con el ticket y `CANCELAR`:
   - verifica el ticket (algoritmo, firma, tipo, audiencia, vencimiento y que sea del cliente del token);
   - lo **gasta** (`closure_ticket_uses`): reenviar el mismo ticket devuelve el mismo cierre y nunca
     cierra dos veces; un ticket gastado en un intento rechazado ya no sirve;
   - **vuelve a revisar los requisitos** en ese momento (no confía en la pantalla anterior); si un
     servicio no responde, no cierra;
   - en **una transacción**: cuentas en `closed` con `closed_at`, llaves Bre-B borradas, fila en
     `account_closures`, evento `account.closed` en el outbox y tarea en `auth_access_tasks`.
4. Después, sin que el cliente espere:
   - el outbox publica `account.closed` → `data: { idUser, cerradaEn, cuentas: [accountNumber] }`;
   - el relevo llama a `POST /internal/auth/cierre-acceso` (idempotente). Si falla, reintenta con
     espera creciente (10 s, 20 s, 40 s… hasta 1 h) y nunca se rinde; como la tarea vive en la base,
     los reintentos siguen después de un reinicio.

Quien canceló no puede abrir otra cuenta con el mismo usuario.

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/accounts/admin/accounts` | cualquier empleado | Busca cuentas. |
| GET | `/accounts/admin/accounts/:id` | cualquier empleado | Detalle de una cuenta. |
| PATCH | `/accounts/admin/accounts/:id/status` | admin | Bloquea, activa o cierra una cuenta. |
| PATCH | `/accounts/admin/accounts/:id/limits` | admin | Cambia los límites de una cuenta. |
| GET | `/accounts/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| GET | `/accounts/admin/dlq` | cualquier empleado | Mensajes en la cola de errores (DLQ). |
| GET | `/accounts/admin/dlq/messages` | cualquier empleado | Contenido de los mensajes de la DLQ. |
| POST | `/accounts/admin/dlq/requeue` | admin | Reencola mensajes de la DLQ (solo administradores). |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/internal/accounts/:account_id/ledger-info` | Titular, estado, moneda y límites de una cuenta. |
| GET | `/internal/accounts/number/:account_number/ledger-info` | Lo mismo, buscando por número de cuenta. |
| POST | `/internal/accounts/merchants` | Crea u obtiene la cuenta de un comercio/convenio. |
| GET | `/internal/accounts/keys/resolve` | Resuelve una llave Bre-B a su cuenta (transfer-service). |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3002` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://account_svc:<DB_PASSWORD_ACCOUNT>@localhost:5432/account_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `INTERNAL_TRUSTED_KEYS` | **Sí** (no arranca sin ella) | `ledger:<clave-de-ledger>,card:<clave-de-card>,payment:<clave-de-payment>,transfer:<clave-de-transfer>` | Claves internas que acepta, `servicio:clave,servicio:clave` (ver `InternalKeyGuard`). |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `AUTH_SERVICE_URL` | Sí | `http://localhost:3001` | URL interna de auth-service. |
| `KYC_SERVICE_URL` | Sí | `http://localhost:3003` | URL interna de kyc-service. |
| `LEDGER_SERVICE_URL` | Sí | `http://localhost:3006` | URL interna de ledger-service (saldo al cancelar la cuenta). |
| `SAVINGS_SERVICE_URL` | Sí | `http://localhost:3013` | URL interna de savings-service (`resumen-cierre`). |
| `DEPOSIT_SERVICE_URL` | Sí | `http://localhost:3014` | URL interna de deposit-service (`resumen-cierre`). |
| `FRAUD_SERVICE_URL` | Sí | `http://localhost:3009` | URL interna de fraud-service (`resumen-cierre`). |
| `CLOSURE_TICKET_SECRET` | Para cancelar cuentas | — | El mismo valor que en auth-service; verifica el ticket de cierre. Distinto de `JWT_SECRET`. Sin ella el servicio arranca, pero cancelar responde 503. |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella no se consume `identity.verified` y `account.closed` queda en el outbox. |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `RABBITMQ_QUEUE` | No | `account-service.identity-verified` | Cola propia del servicio (con `<cola>.retry` y `<cola>.dlq`). |
| `EVENT_MAX_RETRIES` | No | `5` | Reintentos de un evento antes de mandarlo a la DLQ. |
| `EVENT_RETRY_DELAY_MS` | No | `10000` | Espera entre reintentos de un evento. |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |

## Pruebas

```bash
npm test   # Jest
```

Las pruebas de la cancelación (`src/closure/*.spec.ts`) corren contra un PostgreSQL real:
definen `TEST_DATABASE_URL` (p. ej. `postgres://postgres:postgres@localhost:5432/postgres`)
y cada corrida crea su propia base temporal y la borra. Sin esa variable se omiten en local;
en CI son obligatorias (el workflow levanta Postgres 16). Cubren el ticket de un solo uso
(también con solicitudes simultáneas), la segunda revisión de requisitos al cerrar y los
reintentos hacia auth después de un reinicio.

Las reglas de negocio se prueban de punta a punta con los scripts de `scripts/pruebas/` del repositorio principal.

## Despliegue

Desplegado en Railway **desde este repositorio** (rama `main`): `railway.json` en la
raíz define el build por `Dockerfile` y el health check en `/health`; cada push a
`main` redespliega el servicio. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `account-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/accounts/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-kyc-service](https://github.com/Luisortiz2406/banklite-kyc-service) | **Llama a:** nombre del titular<br>**Recibe:** `identity.verified` (activa la cuenta) |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Llama a:** verificación de la clave dinámica (llaves Bre-B) y cierre del acceso al cancelar la cuenta (`/internal/auth/cierre-acceso`) |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** saldo de cada cuenta al cancelar (con el token del cliente)<br>**Lo llama:** titular, estado y límites de la cuenta |
| [banklite-card-service](https://github.com/Luisortiz2406/banklite-card-service) | **Lo llama:** dueño y límite de la cuenta<br>**Envía:** `account.closed` (cancela tarjetas y suscripciones) |
| [banklite-notification-service](https://github.com/Luisortiz2406/banklite-notification-service) | **Envía:** `account.closed` (correo que confirma la cancelación) |
| [banklite-deposit-service](https://github.com/Luisortiz2406/banklite-deposit-service) | **Llama a:** `resumen-cierre` (recargas pendientes o en revisión) |
| [banklite-fraud-service](https://github.com/Luisortiz2406/banklite-fraud-service) | **Llama a:** `resumen-cierre` (revisiones de seguridad abiertas) |
| [banklite-payment-service](https://github.com/Luisortiz2406/banklite-payment-service) | **Lo llama:** cuenta origen y cuenta del convenio |
| [banklite-transfer-service](https://github.com/Luisortiz2406/banklite-transfer-service) | **Lo llama:** cuentas origen y destino, resolución de llaves Bre-B |
| [banklite-rewards-service](https://github.com/Luisortiz2406/banklite-rewards-service) | **Lo llama:** cuenta del cliente |
| [banklite-savings-service](https://github.com/Luisortiz2406/banklite-savings-service) | **Llama a:** `resumen-cierre` (bolsillos y metas con dinero, CDT vigentes)<br>**Lo llama:** cuenta del cliente |
