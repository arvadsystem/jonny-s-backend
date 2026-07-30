import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getActiveFidelizacionConfig } from '../fidelizacionService.js';

const source = readFileSync(resolve('services/fidelizacionService.js'), 'utf8');

// Mock minimo, fiel al WHERE real: filtra por sucursal, aplica la ventana de
// vigencia contra la fecha de referencia (o NOW() si es null), y solo exige
// estado=true cuando la fecha de referencia es null (busqueda "actual").
const createConfigTableClient = (rows) => ({
  calls: [],
  async query(sql, params) {
    this.calls.push({ sql: String(sql).trim(), params });
    const [idSucursal, referenceDate] = params;
    const refDate = referenceDate ? new Date(referenceDate) : new Date();
    const matches = rows.filter((row) => {
      if (row.id_sucursal !== idSucursal) return false;
      if (!referenceDate && !(row.estado ?? true)) return false;
      const desde = new Date(row.vigente_desde);
      const hasta = row.vigente_hasta ? new Date(row.vigente_hasta) : null;
      return desde <= refDate && (!hasta || hasta > refDate);
    });
    matches.sort((a, b) => new Date(b.vigente_desde) - new Date(a.vigente_desde) || b.id_configuracion - a.id_configuracion);
    return { rows: matches.slice(0, 1) };
  }
});

describe('getActiveFidelizacionConfig', () => {
  it('el SQL solo exige estado=true cuando NO hay fecha de referencia (busqueda actual)', () => {
    assert.match(
      source,
      /WHERE fcs\.id_sucursal = \$1\s*\n\s*AND \(\$2::timestamptz IS NOT NULL OR COALESCE\(fcs\.estado, true\) = true\)/,
      'la condicion de estado debe quedar anulada (OR true) cuando se pasa referenceDate'
    );
  });


  const sucursalId = 1;
  const configuracionAnteriorDesactivada = {
    id_configuracion: 10,
    id_sucursal: sucursalId,
    lempiras_por_punto: 10,
    vigente_desde: '2024-01-01T00:00:00Z',
    vigente_hasta: '2026-01-01T00:00:00Z',
    estado: false
  };
  const configuracionActual = {
    id_configuracion: 20,
    id_sucursal: sucursalId,
    lempiras_por_punto: 50,
    vigente_desde: '2026-01-01T00:00:00Z',
    vigente_hasta: null,
    estado: true
  };

  it('configuracion historica con estado=false: se encuentra si la fecha de referencia cae en su ventana', async () => {
    const client = createConfigTableClient([configuracionAnteriorDesactivada, configuracionActual]);

    const result = await getActiveFidelizacionConfig(client, sucursalId, '2025-06-01T12:00:00Z');

    assert.ok(result, 'debe encontrar la configuracion aunque este desactivada');
    assert.equal(result.id_configuracion, 10);
    assert.equal(result.lempiras_por_punto, 10);
  });

  it('operacion actual (referenceDate null) NO usa una configuracion inactiva ni vencida', async () => {
    const client = createConfigTableClient([configuracionAnteriorDesactivada, configuracionActual]);

    const result = await getActiveFidelizacionConfig(client, sucursalId, null);

    assert.ok(result, 'debe encontrar la configuracion vigente y activa');
    assert.equal(result.id_configuracion, 20);
    assert.equal(result.estado, true);
  });

  it('operacion actual: si la unica configuracion vigente esta inactiva, no retorna nada', async () => {
    const soloInactivaYVigente = {
      id_configuracion: 30,
      id_sucursal: sucursalId,
      lempiras_por_punto: 99,
      vigente_desde: '2026-01-01T00:00:00Z',
      vigente_hasta: null,
      estado: false
    };
    const client = createConfigTableClient([soloInactivaYVigente]);

    const result = await getActiveFidelizacionConfig(client, sucursalId, null);

    assert.equal(result, null);
  });

  it('factura historica fuera de cualquier ventana: no encuentra configuracion', async () => {
    const client = createConfigTableClient([configuracionAnteriorDesactivada, configuracionActual]);

    const result = await getActiveFidelizacionConfig(client, sucursalId, '2020-01-01T00:00:00Z');

    assert.equal(result, null);
  });

  it('compatibilidad con canje/administracion: llamada de 2 argumentos sigue exigiendo estado=true y vigencia actual', async () => {
    const client = createConfigTableClient([configuracionAnteriorDesactivada, configuracionActual]);

    const result = await getActiveFidelizacionConfig(client, sucursalId);

    assert.equal(result.id_configuracion, 20);
  });
});
