import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../20260805005844_secure_financial_data_api_surface.sql', import.meta.url), 'utf8');
const executableSql = migration.replace(/^\s*--.*$/gm, '');
const protectedTables = [
  'pedidos', 'detalle_pedido', 'detalle_pedido_extras', 'pedidos_contexto',
  'pedidos_contacto', 'pedidos_delivery', 'pedidos_pago_control',
  'pedidos_inventario_alertas', 'facturas', 'detalle_facturas',
  'detalle_facturas_origen', 'detalle_factura_extras', 'facturas_cobros',
  'cajas_movimientos', 'cajas_sesiones', 'ventas_cuenta_divisiones',
  'ventas_cuenta_division_items', 'descuentos', 'facturacion_config_sucursal',
  'facturacion_correlativos_diarios', 'fidelizacion_acumulacion_facturas_estado',
  'fidelizacion_movimientos'
];

test('cierra tablas financieras y habilita RLS sin politicas permisivas', () => {
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated;/);
  for (const table of protectedTables) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
  }
  assert.doesNotMatch(executableSql, /CREATE\s+POLICY|FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
});

test('cierra secuencias sin reiniciarlas', () => {
  assert.match(migration, /REVOKE ALL PRIVILEGES ON SEQUENCE[\s\S]*FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(migration, /setval|RESTART|ALTER\s+SEQUENCE/i);
});

for (const version of ['v1', 'v2']) {
  test(`revoca EXECUTE publico de registrar_venta_pos_${version}`, () => {
    assert.match(
      migration,
      new RegExp(`REVOKE EXECUTE\\s+ON FUNCTION public\\.registrar_venta_pos_${version}\\(jsonb, jsonb\\)\\s+FROM PUBLIC, anon, authenticated;`)
    );
  });
}
