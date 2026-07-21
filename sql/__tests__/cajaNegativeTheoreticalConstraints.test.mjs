import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const safeSource = readFileSync(
  resolve('sql/20260720_allow_negative_cash_close_theoretical_SAFE.sql'),
  'utf8'
);
const verifySource = readFileSync(
  resolve('sql/20260720_allow_negative_cash_close_theoretical_VERIFY.sql'),
  'utf8'
);
const rollbackSource = readFileSync(
  resolve('sql/20260720_allow_negative_cash_close_theoretical_ROLLBACK.sql'),
  'utf8'
);
const routerSource = readFileSync(resolve('routers/cajas.js'), 'utf8');

describe('monto teorico negativo en cierre de caja', () => {
  it('SAFE elimina solo los dos CHECK del monto teorico y no modifica filas', () => {
    assert.match(safeSource, /BEGIN;/);
    assert.match(safeSource, /COMMIT;/);
    assert.match(safeSource, /conkey/);
    assert.match(safeSource, /pg_get_expr\(c\.conbin, c\.conrelid\)/);
    assert.match(safeSource, /monto_teorico_cierre>=0/);
    assert.match(safeSource, /SET LOCAL lock_timeout = '5s';/);
    assert.match(safeSource, /SET LOCAL statement_timeout = '120s';/);
    assert.match(safeSource, /ARRAY\[target_column\]::smallint\[\]/);
    assert.match(safeSource, /DROP CONSTRAINT IF EXISTS ck_cajas_sesiones_monto_teorico/);
    assert.match(safeSource, /DROP CONSTRAINT IF EXISTS ck_cajas_cierres_monto_teorico/);
    assert.doesNotMatch(safeSource, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.doesNotMatch(safeSource, /monto_apertura\s*>?=|monto_declarado_cierre\s*>?=|monto_ventas|monto_ingresos_manuales|monto_egresos_manuales/i);
  });

  it('VERIFY detecta CHECK equivalentes por columna y conserva controles no negativos', () => {
    assert.match(verifySource, /c\.conkey @> ARRAY\[a\.attnum\]::smallint\[\]/);
    assert.match(verifySource, /checks_equivalentes_no_negativos/);
    assert.match(verifySource, /permite_valores_negativos/);
    for (const column of [
      'monto_apertura',
      'monto_declarado_cierre',
      'monto_ventas_efectivo',
      'monto_ventas_no_efectivo',
      'monto_ingresos_manuales',
      'monto_egresos_manuales',
      'monto_declarado'
    ]) {
      assert.match(verifySource, new RegExp(column));
    }
    assert.match(verifySource, /c\.convalidated/);
    assert.match(verifySource, /control_no_negativo_presente_y_validado/);
    assert.match(verifySource, /3000\.00::numeric\(14,2\)/);
    assert.match(verifySource, /16763\.00::numeric\(14,2\)/);
    assert.match(verifySource, /efectivo_teorico_esperado/);
    assert.match(verifySource, /WHERE cm\.id_movimiento_caja = 17/);
    assert.doesNotMatch(verifySource, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
  });

  it('ROLLBACK restaura ambos CHECK y falla cerrado si existen negativos', () => {
    assert.match(rollbackSource, /SET LOCAL lock_timeout = '5s';/);
    assert.match(rollbackSource, /SET LOCAL statement_timeout = '120s';/);
    assert.match(rollbackSource, /WHERE monto_teorico_cierre < 0/g);
    assert.match(rollbackSource, /Rollback bloqueado/);
    assert.match(rollbackSource, /constraint_columns IS DISTINCT FROM ARRAY\[target_column\]::smallint\[\]/g);
    assert.match(rollbackSource, /constraint_validated IS NOT TRUE/g);
    assert.match(rollbackSource, /monto_teorico_cierreisnullormonto_teorico_cierre>=0/);
    assert.match(rollbackSource, /monto_teorico_cierre>=0/);
    assert.match(rollbackSource, /existe con una definicion incorrecta o no validada/g);
    assert.match(rollbackSource, /ADD CONSTRAINT ck_cajas_sesiones_monto_teorico/);
    assert.match(rollbackSource, /ADD CONSTRAINT ck_cajas_cierres_monto_teorico/);
    assert.match(rollbackSource, /VALIDATE CONSTRAINT ck_cajas_sesiones_monto_teorico/);
    assert.match(rollbackSource, /VALIDATE CONSTRAINT ck_cajas_cierres_monto_teorico/);
  });

  it('el cierre conserva valor exacto, diferencia, revision y notificacion', () => {
    const start = routerSource.indexOf('const closeSessionHandler = async');
    const end = routerSource.indexOf("router.patch('/ventas/cajas/sesiones/:id/cerrar'", start);
    const closeSource = routerSource.slice(start, end);

    assert.match(closeSource, /montoTeorico = Number\(validationToLink\.total_teorico \|\| 0\)/);
    assert.match(closeSource, /diferencia = Number\(validationToLink\.diferencia_total \|\| 0\)/);
    assert.match(closeSource, /PENDIENTE_REVISION/);
    assert.match(closeSource, /createCajaCloseEmailNotification\(client/);
    assert.match(closeSource, /requiresAudit/);
    assert.doesNotMatch(closeSource, /Math\.max\(0,\s*montoTeorico\)|montoTeorico\s*=\s*0/);
  });
});
