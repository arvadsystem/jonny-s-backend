import {
  VENTA_COMPLEMENTO_TIPO_SALSAS
} from '../constants.js';
import { roundMoney } from '../utils/moneyUtils.js';
import {
  isPlainObject,
  normalizeObservation,
  parseBooleanInput,
  parseComplementosPayload,
  parseEntityIdentifier,
  parseOptionalPositiveInt,
  parsePositiveInt,
  parseVentaExtrasPayload
} from '../utils/parseUtils.js';

export const buildComplementSnapshot = (line) => {
  const selected = Array.isArray(line?.complementos_detalle) ? line.complementos_detalle : [];
  if (selected.length === 0) return null;
  return {
    tipo: VENTA_COMPLEMENTO_TIPO_SALSAS,
    seleccion: selected.map((entry) => ({
      id_complemento: Number(entry?.id_complemento || 0),
      id_salsa: Number(entry?.id_salsa || entry?.id_complemento || 0),
      nombre: String(entry?.nombre || 'Complemento').trim(),
      inventario: entry?.inventario || null
    })).filter((entry) => entry.id_complemento > 0)
  };
};

export const buildComplementLineConfig = (line) => {
  const selected = Array.isArray(line?.complementos_detalle) ? line.complementos_detalle : [];
  const extras = Array.isArray(line?.extras_detalle) ? line.extras_detalle : [];
  const metadata = line?.complementos_metadata;
  if (!selected.length && !metadata?.requiere_complementos && !extras.length) return null;
  return {
    tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
    requiere_complementos: Boolean(metadata?.requiere_complementos),
    minimo_complementos: Number(metadata?.minimo_complementos || 0),
    maximo_complementos: Number(metadata?.maximo_complementos || 0),
    complementos_incompletos_autorizados: Boolean(metadata?.complementos_incompletos_autorizados),
    complementos_recomendados: Number(metadata?.complementos_recomendados ?? metadata?.minimo_complementos ?? 0),
    complementos_seleccionados: Number(metadata?.complementos_seleccionados ?? selected.length),
    complementos: selected.map((entry) => ({
      id_complemento: Number(entry?.id_complemento || 0),
      id_salsa: Number(entry?.id_salsa || entry?.id_complemento || 0),
      nombre: String(entry?.nombre || 'Complemento').trim(),
      inventario: entry?.inventario || null
    })).filter((entry) => entry.id_complemento > 0),
    extras: extras.map((entry) => ({
      id_extra: Number(entry?.id_extra || 0),
      codigo: String(entry?.codigo || '').trim() || null,
      nombre: String(entry?.nombre || 'Extra').trim(),
      cantidad: Number(entry?.cantidad || 0),
      precio_unitario: roundMoney(entry?.precio_unitario),
      subtotal: roundMoney(entry?.subtotal),
      id_insumo: entry?.id_insumo ? Number(entry.id_insumo) : null,
      cant: Number(entry?.cant ?? entry?.cantidad_insumo ?? 0) > 0
        ? Number(entry?.cant ?? entry?.cantidad_insumo)
        : null,
      id_unidad_medida: parseOptionalPositiveInt(entry?.id_unidad_medida)
    })).filter((entry) => entry.id_extra > 0 && entry.cantidad > 0)
  };
};

export const normalizeCartKey = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

export const normalizeVentaItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Debe enviar al menos un item en la venta.' };
  }

  const normalized = [];

  for (const [index, item] of items.entries()) {
    if (!isPlainObject(item)) {
      return { ok: false, message: 'Cada item debe ser un objeto valido.' };
    }

    const productoResult = parseEntityIdentifier(item.id_producto, 'id_producto');
    if (!productoResult.ok) return { ok: false, message: productoResult.message };

    const comboResult = parseEntityIdentifier(item.id_combo, 'id_combo');
    if (!comboResult.ok) return { ok: false, message: comboResult.message };

    const recetaResult = parseEntityIdentifier(item.id_receta, 'id_receta');
    if (!recetaResult.ok) return { ok: false, message: recetaResult.message };
    const extraResult = parseEntityIdentifier(item.id_extra, 'id_extra');
    if (!extraResult.ok) return { ok: false, message: extraResult.message };

    const cantidad = parsePositiveInt(item.cantidad);
    if (!cantidad) {
      return {
        ok: false,
        message: `La linea ${index + 1} debe incluir cantidad entera mayor a 0.`
      };
    }

    const presentIds = [
      ['PRODUCTO', productoResult.value],
      ['COMBO', comboResult.value],
      ['RECETA', recetaResult.value],
      ['ITEM', extraResult.value]
    ].filter(([, value]) => value !== null);

    if (presentIds.length !== 1) {
      return {
        ok: false,
        message:
          'Cada item debe incluir exactamente uno entre id_producto, id_combo, id_receta o id_extra.'
      };
    }

    const [kind, entityId] = presentIds[0];
    const idDescuentoCatalogoLinea = parseOptionalPositiveInt(item.id_descuento_catalogo);
    if (
      item.id_descuento_catalogo !== undefined &&
      item.id_descuento_catalogo !== null &&
      !idDescuentoCatalogoLinea
    ) {
      return {
        ok: false,
        message: 'id_descuento_catalogo por linea debe ser entero mayor a 0.'
      };
    }

    const complementosResult = parseComplementosPayload(item.complementos);
    if (!complementosResult.ok) {
      return { ok: false, message: complementosResult.message };
    }
    const extrasResult = parseVentaExtrasPayload(item.extras, { kind });
    if (!extrasResult.ok) {
      return { ok: false, message: extrasResult.message };
    }
    const complementosIncompletosInput = item.complementos_incompletos_autorizados ?? item.permitir_complementos_incompletos;
    let complementosIncompletosAutorizados = false;
    if (complementosIncompletosInput !== undefined && complementosIncompletosInput !== null) {
      const parsedComplementosIncompletos = parseBooleanInput(complementosIncompletosInput);
      if (!parsedComplementosIncompletos.ok) {
        return { ok: false, message: 'complementos_incompletos_autorizados debe ser booleano.' };
      }
      complementosIncompletosAutorizados = parsedComplementosIncompletos.value;
    }

    normalized.push({
      kind,
      cart_key: normalizeCartKey(item.cart_key),
      cantidad,
      id_producto: kind === 'PRODUCTO' ? entityId : null,
      id_combo: kind === 'COMBO' ? entityId : null,
      id_receta: kind === 'RECETA' ? entityId : null,
      id_extra: kind === 'ITEM' ? entityId : null,
      observacion: normalizeObservation(item.observacion),
      id_descuento_catalogo_linea: idDescuentoCatalogoLinea,
      complementos: complementosResult.data,
      complementos_incompletos_autorizados: complementosIncompletosAutorizados,
      extras: extrasResult.data
    });
  }

  return { ok: true, data: normalized };
};
