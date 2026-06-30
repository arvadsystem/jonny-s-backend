import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapExpectedReversionUniqueError } from '../ventasReversionService.js';

describe('mapeo 23505 en reversiones de inventario', () => {
  it('mapea solo ux_mov_inv_reversion_origen como ALREADY_FULLY_RETURNED', () => {
    const mapped = mapExpectedReversionUniqueError({
      code: '23505',
      constraint: 'ux_mov_inv_reversion_origen'
    });

    assert.equal(mapped?.code, 'ALREADY_FULLY_RETURNED');
    assert.equal(mapped?.httpStatus, 409);
  });

  it('no mapea movimientos_inventario_pkey', () => {
    const mapped = mapExpectedReversionUniqueError({
      code: '23505',
      constraint: 'movimientos_inventario_pkey'
    });

    assert.equal(mapped, null);
  });

  it('no mapea constraints desconocidas', () => {
    const mapped = mapExpectedReversionUniqueError({
      code: '23505',
      constraint: 'ux_desconocida'
    });

    assert.equal(mapped, null);
  });
});
