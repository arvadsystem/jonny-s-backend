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

### Liveness vs readiness (monitor continuo, un unico estado compartido)

El puerto HTTP abre de inmediato al arrancar, sin esperar a que PostgreSQL responda. La
disponibilidad de la base vive en un unico estado compartido, mantenido por un monitor que
corre durante toda la vida del proceso (`config/dbReadiness.js`) -- no solo al arrancar:

- `/health/live` -- siempre 200 si el proceso Node esta vivo, nunca consulta la DB.
- `/health/ready`, el middleware que protege las rutas de negocio, y el arranque de los
  workers en segundo plano leen exactamente el mismo estado (`isDatabaseReady()`). Nunca
  pueden divergir: `/health/ready` no ejecuta un `SELECT 1` propio por cada llamada, solo
  reporta el resultado del ultimo chequeo del monitor.
- Mientras `ready` es `false` (al arrancar, o si Postgres cae mas tarde), cualquier ruta
  que dependa de la base responde `503 { status: "not_ready" }` de forma controlada (nunca
  500 ni colgada).
- El monitor nunca se detiene: si Postgres esta arriba, vuelve a comprobar cada
  `DB_READINESS_CHECK_INTERVAL_MS` (5s por defecto); si un chequeo falla -- al arrancar o
  despues de haber estado arriba -- marca `ready=false` de inmediato y retoma el backoff con
  jitter desde el primer escalon (2s, 4s, 8s, 15s, tope 30s). Nunca hay dos chequeos en
  vuelo ni dos timers activos a la vez.
- Los workers en segundo plano (outbox de correo de cierre de caja, corte operativo)
  arrancan una sola vez, la PRIMERA vez que la DB confirma estar lista. No se duplican en
  caidas/recuperaciones posteriores; si Postgres cae despues de que arrancaron, cada uno
  sigue con su propia logica de reintento interna, sin depender de este monitor.
- Con esto, una caida o lentitud de PostgreSQL -- al arrancar o en cualquier momento
  posterior -- ya no tumba el proceso ni provoca reinicios en bucle: el contenedor sigue
  arriba y `/health/ready` refleja el estado real en todo momento.

Variable de entorno nueva (opcional, ya con default razonable):

```env
DB_READINESS_CHECK_INTERVAL_MS=5000
```

Tambien reutiliza `DB_CONNECTION_TIMEOUT_MS` y `GRACEFUL_SHUTDOWN_TIMEOUT_MS`, ya
documentados en `.env.example`.

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
