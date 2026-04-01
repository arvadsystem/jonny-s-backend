# Hardening + QA Final (Personas/Empleados/Clientes/Planillas)

Fecha: 2026-03-27

## 1) Ejecucion automatizada

Backend:

```bash
npm run qa:hardening
```

Este script valida:

- crear empleado con persona nueva
- crear empleado con persona existente
- crear cliente con persona nueva
- crear cliente con empresa nueva
- rollback forzado (persona creada + error en empleado) y verificacion anti-huerfanos
- existencia de permisos `PLANILLAS_*` y asignacion a roles `administrador`/`super_admin`

## 2) Checklist funcional UI

### Contexto `?sucursal=`

- [ ] `Personas` mantiene selector de contexto por sucursal
- [ ] `Empleados` consume `id_sucursal` en backend y filtra listado/KPI/busqueda/paginacion
- [ ] `Clientes` envia `id_sucursal`; backend aplica filtro SQL si el modelo tiene `id_sucursal`
- [ ] `Planillas` lista/genera/detalle por sucursal seleccionada
- [ ] `KPIs` en tabs con filtro aplicado se recalculan sobre data filtrada

### Permisos / RBAC

- [ ] Sin `PLANILLAS_MODULO_VER` no se visualiza tab de planillas
- [ ] Sin `PLANILLAS_LISTADO_VER` backend devuelve `403` en `GET /planillas`
- [ ] Sin `PLANILLAS_GENERAR` backend devuelve `403` en `POST /planillas/generar`
- [ ] Sin `PLANILLAS_CERRAR/PAGAR/ANULAR` no se ejecutan cambios de estado
- [ ] Botones sensibles respetan permisos en UI (generar/recalcular/movimientos/adelantos/estado)

### UX final

- [ ] Loading state visible en listados y detalle de planillas
- [ ] Empty state amigable cuando no hay datos
- [ ] Mensajes de error claros en operaciones fallidas
- [ ] Confirmaciones para: anular movimiento, anular planilla, pagar y cerrar planilla
- [ ] Toasts consistentes en exito/error

## 3) Notas de alcance y fallback

- `Personas` y `Empresas` pueden comportarse como vistas globales por modelo actual.
- En `Clientes`, el filtro por sucursal se aplica con precision solo si la BD expone `id_sucursal` en al menos una de estas tablas:
  - `clientes.id_sucursal`
  - `personas.id_sucursal`
  - `empresas.id_sucursal`
- Si esos campos no existen, el backend responde en modo `global_fallback` para mantener estabilidad del flujo.
