import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildPedidoPendienteRpcPayload,
  buildVentaRpcPayload,
  buildVentaRpcV2Payload
} from '../routers/ventas/services/ventasRpcPayloadService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [routerSource, detailSource, migrationSource] = await Promise.all([
  readFile(path.join(root, 'routers/ventas.js'), 'utf8'),
  readFile(path.join(root, 'routers/ventas/services/ventaDetalleReadService.js'), 'utf8'),
  readFile(path.join(root, 'sql/2026-06-20_ventas_contacto_delivery_opcional.sql'), 'utf8')
]);

const venta = {
  contacto: { nombre_contacto: 'Zohan', telefono_contacto: '9203-8975' },
  contexto: { canal: 'LOCAL', modalidad: 'CONSUMO_LOCAL' },
  all_lines: []
};
assert.deepEqual(buildVentaRpcPayload({
  venta,
  correlativoVenta: {},
  facturacionVenta: {},
  facturacionNormalizada: {}
}).contacto, venta.contacto);
assert.deepEqual(buildVentaRpcV2Payload({ venta }).contexto, venta.contexto);

const deliveryEmpty = buildPedidoPendienteRpcPayload({
  modalidad: 'DELIVERY',
  contacto: { nombre_contacto: null, telefono_contacto: null },
  delivery: {
    costo_envio: null,
    nombre_receptor: null,
    telefono_receptor: null,
    direccion_entrega: null,
    referencia_entrega: null,
    observacion_delivery: null
  }
});
assert.equal(deliveryEmpty.delivery.costo_envio, null, 'Costo vacio debe permanecer null');
assert.equal(deliveryEmpty.delivery.nombre_receptor, null);

const deliveryZero = buildPedidoPendienteRpcPayload({ modalidad: 'DELIVERY', delivery: { costo_envio: 0 } });
assert.equal(deliveryZero.delivery.costo_envio, 0, 'Costo cero debe permitirse');
const pickup = buildPedidoPendienteRpcPayload({ modalidad: 'RECOGER', delivery: { costo_envio: 10 } });
assert.equal(pickup.delivery, null, 'RECOGER no debe crear delivery');

assert.match(routerSource, /const persistVentaPedidoSnapshots/);
assert.equal((routerSource.match(/INSERT INTO public\.pedidos_contacto \(/g) || []).length, 2,
  'Debe existir un writer para venta pagada y uno para pedido pendiente legacy');
assert.match(routerSource, /await persistVentaPedidoSnapshots\(\{ client, idPedido, venta \}\)/,
  'Legacy debe persistir contacto en la transaccion');
assert.match(routerSource, /rpcCreateResult\.response\?\.id_pedido/,
  'RPC debe persistir contacto antes del commit externo');
assert.doesNotMatch(routerSource, /contacto\.nombre_contacto es obligatorio/);
assert.doesNotMatch(routerSource, /contacto\.telefono_contacto es obligatorio/);
assert.doesNotMatch(routerSource, /missingDeliveryField/);
assert.match(routerSource, /delivery\.costo_envio debe ser numerico mayor o igual a 0/);
assert.match(routerSource, /UPDATE public\.pedidos_delivery SET costo_envio = NULL WHERE id_pedido = \$1/,
  'RPC pendiente debe conservar costo null antes del commit');
assert.match(detailSource, /pedidos_contacto/, 'Detalle debe leer contacto persistido');
assert.match(migrationSource, /ALTER COLUMN nombre_contacto DROP NOT NULL/);
assert.match(migrationSource, /ALTER COLUMN costo_envio DROP NOT NULL/);
assert.match(migrationSource, /ALTER COLUMN direccion_entrega DROP NOT NULL/);

console.log('QA backend ventas contacto/entrega: OK');
