# Runtime de despliegue

## Servicio web

```env
PROCESS_ROLE=web
DB_POOL_MAX=5
EMAIL_SCHEDULER_ENABLED=false
PORT=3001
```

Start command permitido:

```text
vacio
npm start
node bootstrap.js
```

Prohibido:

```text
node app.js
```

Health check:

```text
/health/ready
```

Restart policy:

```text
always
```

### Liveness vs readiness (arranque sin bloquear el puerto)

El puerto HTTP abre de inmediato al arrancar, sin esperar a que PostgreSQL responda. La
disponibilidad de la base se rastrea por separado en segundo plano (`config/dbReadiness.js`):

- `/health/live` -- siempre 200 si el proceso Node esta vivo, nunca consulta la DB. Util para
  un liveness probe si EasyPanel llega a distinguirlo del readiness probe.
- `/health/ready` -- 200 solo si un `SELECT 1` reciente contra PostgreSQL tuvo exito; 503
  mientras la DB no responda. Es el probe que EasyPanel ya tiene configurado arriba; no
  requiere ningun cambio de configuracion.
- Mientras la DB no haya confirmado estar lista tras el arranque, cualquier ruta que
  dependa de ella responde `503 { status: "not_ready" }` de forma controlada (nunca 500 ni
  colgada). El chequeo de PostgreSQL en segundo plano reintenta con backoff + jitter
  (2s, 4s, 8s, 15s, tope 30s) y nunca corre mas de un ciclo de reconexion a la vez.
- Los workers en segundo plano (outbox de correo de cierre de caja, corte operativo)
  arrancan una sola vez, recien cuando la DB confirma estar lista -- no antes.
- Con esto, una caida o lentitud puntual de PostgreSQL durante el arranque ya no tumba el
  proceso ni provoca reinicios en bucle: el contenedor sigue arriba y `/health/ready`
  simplemente reporta 503 hasta que la conexion se recupera sola.

No se requieren variables de entorno nuevas para este comportamiento; reutiliza
`DB_CONNECTION_TIMEOUT_MS` y `GRACEFUL_SHUTDOWN_TIMEOUT_MS` ya documentados en `.env.example`.

## Servicio scheduler

```env
PROCESS_ROLE=scheduler
DB_POOL_MAX=2
EMAIL_SCHEDULER_ENABLED=true
EMAIL_SCHEDULER_INTERVAL_MS=15000
```

Tambien requiere variables:

```text
PostgreSQL
SMTP
campanas
```

Configuracion:

```text
sin dominio
sin proxy HTTP
sin health check de puerto 3001
restart policy always
una sola replica
```

No desplegar dos replicas scheduler sin implementar coordinacion distribuida.

La imagen compartida no define `HEALTHCHECK` en el Dockerfile porque el mismo artefacto corre como `web` y como `scheduler`. Configure el health check solo en EasyPanel para el servicio web.
