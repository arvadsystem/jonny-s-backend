// HOTFIX (saldo dividido oculto, ronda 2): logica PURA extraida de
// routers/ventas.js para las divisiones ("cuenta dividida") nuevas que se
// agregan sobre un pedido que ya tiene divisiones existentes. Usada
// realmente por listarPedidosPendientesPago y por
// POST /ventas/pedidos/:id/registrar-pago -- no es una copia solo para
// pruebas.
import { roundMoney } from '../utils/moneyUtils.js';

// Estados operativos (Cocina/entrega) que NO deben excluir un pedido del
// endpoint financiero de pendientes de cobro: la deuda sigue vigente
// mientras estado_pago=PENDIENTE_PAGO y monto_pendiente>0, sin importar el
// estado operativo. Confirmado por auditoria de codigo (ronda 2): ningun
// flujo que marca un pedido como COMPLETADO o NO_ENTREGADO toca
// pedidos_pago_control ni anula el pago -- ambos son estados puramente
// operativos (ver routers/cocina.js, routers/ventas/services/pedidoOperationalRoutingService.js,
// routers/ventas/services/ventasReversionInventoryPolicyService.js). Los
// unicos codigos que representan una cancelacion financiera REAL
// (verificados: services/ventasReversionService.js anula el pago
// explicitamente al reversar una venta; routers/ventas.js:expirePendingPublicOrders
// anula pedidos PENDIENTE nunca pagados por timeout) son CANCELADO,
// ANULADO, CANCELADO_POR_NO_PAGO, CANCELADO_TIMEOUT y PAGO_ANULADO.
export const EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS = Object.freeze([
  'CANCELADO',
  'ANULADO',
  'CANCELADO_POR_NO_PAGO',
  'CANCELADO_TIMEOUT',
  'PAGO_ANULADO'
]);

// Prefijo de etiqueta controlado para identificar una division PENDIENTE
// creada automaticamente por el backend como respaldo de una linea
// sobrante (nunca por el usuario) sin agregar una columna nueva. Se valida
// SIEMPRE junto con estado/factura/monto_pagado antes de considerarla
// redistribuible -- el prefijo por si solo nunca es suficiente (seccion 6
// del ticket).
export const AUTO_BACKUP_DIVISION_LABEL_PREFIX = 'Saldo pendiente';

const normalizeEstadoDivision = (division) => String(division?.estado || '').trim().toUpperCase();

export const isDivisionEstadoAnulada = (division) => normalizeEstadoDivision(division) === 'ANULADA';

export const isDivisionEstadoActiva = (division) => !isDivisionEstadoAnulada(division);

// Una division es "respaldo automatico redistribuible" solo si CUMPLE
// TODAS estas condiciones financieras -- nunca solo por su etiqueta:
//   - PENDIENTE (nunca PAGADA, ANULADA no aplica aqui igual)
//   - sin factura asociada (id_factura NULL)
//   - sin nada pagado (monto_pagado === 0)
//   - etiqueta con el prefijo controlado que SOLO el backend genera
// Una division pagada, facturada o parcialmente cobrada NUNCA es
// redistribuible, sin importar su etiqueta.
export const isRedistributableBackupDivision = (division) => {
  const etiqueta = String(division?.etiqueta || '').trim();
  const estado = normalizeEstadoDivision(division);
  const montoPagado = Number(division?.monto_pagado || 0);
  const tieneFactura = Boolean(division?.id_factura);
  return (
    etiqueta.startsWith(AUTO_BACKUP_DIVISION_LABEL_PREFIX) &&
    estado === 'PENDIENTE' &&
    !tieneFactura &&
    montoPagado === 0
  );
};

// Lineas "activamente asignadas": pertenecen a una division ACTIVA
// (estado != ANULADA) que NO sea un respaldo automatico redistribuible.
// Una division ANULADA nunca reserva sus lineas (seccion 6 del ticket).
// Un respaldo automatico redistribuible tampoco las reserva de forma
// definitiva -- todavia puede reabsorberse en una division nueva (p.ej.
// renombrarla a "Persona 2") mientras no tenga factura ni pago.
export const resolveAssignedDetalleIds = (divisions = []) => {
  const ids = new Set();
  for (const division of Array.isArray(divisions) ? divisions : []) {
    if (!isDivisionEstadoActiva(division)) continue;
    if (isRedistributableBackupDivision(division)) continue;
    const items = Array.isArray(division?.items) ? division.items : [];
    for (const item of items) {
      const id = Number(item?.id_detalle_pedido);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  return ids;
};

export const filterAvailableLines = ({ allLines = [], divisions = [] } = {}) => {
  const assignedIds = resolveAssignedDetalleIds(divisions);
  return (Array.isArray(allLines) ? allLines : []).filter((line) => (
    !assignedIds.has(Number(line?.id_detalle_pedido))
  ));
};

// Asigna ordenes consecutivos SIEMPRE a partir del maximo orden existente
// -- nunca confia en el orden enviado por el frontend. Corrige la colision
// "Persona 2 nueva -> orden 1" cuando Persona 1 (existente) ya usa orden 1.
export const resolveNextOrdenSequence = ({ existingDivisions = [], count = 0 } = {}) => {
  const maxOrden = (Array.isArray(existingDivisions) ? existingDivisions : [])
    .reduce((max, division) => Math.max(max, Number(division?.orden) || 0), 0);
  const total = Math.max(0, Number(count) || 0);
  return Array.from({ length: total }, (_, index) => maxOrden + index + 1);
};

// Alternativa RECOMENDADA (seccion 5 del ticket): una division PENDIENTE
// independiente por cada linea sobrante, nunca una unica division que
// agrupe todas las lineas restantes. Cada una queda inmediatamente
// cobrable por si sola (id_cuenta_division directo) o redistribuible en un
// split nuevo (ver isRedistributableBackupDivision) sin bloquear a las
// demas. El total de cada una se calcula 100% desde la linea real
// (line.total_linea), nunca desde un valor enviado por el frontend.
export const buildBackupDivisionsPlan = ({ leftoverItems = [], startingOrden = 1 } = {}) => {
  const items = Array.isArray(leftoverItems) ? leftoverItems : [];
  return items.map((item, index) => ({
    etiqueta: items.length > 1
      ? `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} ${index + 1}`
      : `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} 1`,
    orden: Number(startingOrden) + index,
    subtotal_base: roundMoney(item?.line?.base_sub_total ?? item?.line?.sub_total ?? 0),
    subtotal_extras: roundMoney(item?.line?.subtotal_extras || 0),
    descuento_total: roundMoney(item?.line?.descuento || 0),
    isv_total: 0,
    total: roundMoney(item?.line?.total_linea || 0),
    items: [item]
  }));
};

// Resuelve la division NUEVA que debe cobrarse por su POSICION dentro del
// plan submitted (1-based), nunca por el valor de "orden" (que ahora lo
// controla el backend y puede no coincidir con lo que el frontend
// calculo). persistedDivisions preserva el mismo orden de arreglo que
// plan.divisions (ver persistCuentaDividida), asi que la posicion es un
// identificador seguro y sin ambiguedad para "la N-esima division de este
// envio especifico".
export const selectNewDivisionToCharge = ({ persistedDivisions = [], position } = {}) => {
  const index = Number(position) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= persistedDivisions.length) return null;
  return persistedDivisions[index] || null;
};

// Divisiones de respaldo EXISTENTES cuyas lineas quedaron TODAS cubiertas
// por el nuevo plan (newlyAssignedDetalleIds): estas quedan superadas y
// deben anularse (estado='ANULADA') para que sus lineas no queden
// representadas dos veces (una vez en el respaldo viejo, otra en la
// division nueva). Solo aplica a divisiones redistribuibles -- nunca a una
// division pagada, facturada o con lineas todavia sin cubrir.
export const resolveSupersededBackupDivisionIds = ({ existingDivisions = [], newlyAssignedDetalleIds } = {}) => {
  const assignedIds = newlyAssignedDetalleIds instanceof Set
    ? newlyAssignedDetalleIds
    : new Set(newlyAssignedDetalleIds || []);
  const superseded = [];
  for (const division of Array.isArray(existingDivisions) ? existingDivisions : []) {
    if (!isRedistributableBackupDivision(division)) continue;
    const items = Array.isArray(division?.items) ? division.items : [];
    if (!items.length) continue;
    const allCovered = items.every((item) => assignedIds.has(Number(item?.id_detalle_pedido)));
    if (allCovered) {
      const id = Number(division?.id_cuenta_division);
      if (Number.isInteger(id) && id > 0) superseded.push(id);
    }
  }
  return superseded;
};
