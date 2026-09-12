import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWarehouseAssignmentsBatch } from '../services/catalogoMaestroAsignacionesService.js';

const assignmentCases = [
  { type: 'PRODUCTO', masterId: 101, assignmentExists: true, estado: true, expected: true },
  { type: 'PRODUCTO', masterId: 102, assignmentExists: true, estado: false, expected: false },
  { type: 'PRODUCTO', masterId: 103, assignmentExists: true, estado: null, expected: true },
  { type: 'PRODUCTO', masterId: 104, assignmentExists: false, estado: null, expected: false },
  { type: 'INSUMO', masterId: 201, assignmentExists: true, estado: true, expected: true },
  { type: 'INSUMO', masterId: 202, assignmentExists: true, estado: false, expected: false },
  { type: 'INSUMO', masterId: 203, assignmentExists: true, estado: null, expected: true },
  { type: 'INSUMO', masterId: 204, assignmentExists: false, estado: null, expected: false }
];

const createContractDb = (scenario) => ({
  async query(sql, params) {
    assert.match(sql, /pa\.id_producto IS NOT NULL AND COALESCE\(pa\.estado, true\)/);
    assert.match(sql, /ia\.id_insumo IS NOT NULL AND COALESCE\(ia\.estado, true\)/);
    assert.deepEqual(params, [
      scenario.type === 'PRODUCTO' ? [scenario.masterId] : [],
      scenario.type === 'INSUMO' ? [scenario.masterId] : [],
      4
    ]);
    const estadoAllowsAssignment = scenario.estado === null || scenario.estado === true;
    return {
      rows: [{
        tipo: scenario.type,
        id_maestro: scenario.masterId,
        existe: true,
        activo: true,
        asignado: scenario.assignmentExists && estadoAllowsAssignment
      }]
    };
  }
});

for (const scenario of assignmentCases) {
  const presence = scenario.assignmentExists ? `fila estado=${String(scenario.estado)}` : 'sin fila de asignacion';
  test(`${scenario.type} ${presence} produce asignado=${scenario.expected}`, async () => {
    const [result] = await validateWarehouseAssignmentsBatch(
      [{ type: scenario.type, masterId: scenario.masterId }],
      4,
      createContractDb(scenario)
    );
    assert.equal(result.existe, true);
    assert.equal(result.activo, true);
    assert.equal(result.asignado, scenario.expected);
  });
}
