import { accumulateInvoicePoints } from './accumulateInvoicePoints.js';
import { enqueueInvoiceAccumulation } from '../infrastructure/fidelizacionQueue.js';

// Unica interfaz que Ventas puede llamar: void notifyPaidInvoice({ idFactura }).catch(() => undefined).
// No recibe monto, puntos ni configuracion; Fidelizacion los resuelve por su
// cuenta a partir de datos ya persistidos (ver infrastructure/fidelizacionRepository.js).
// Nunca lanza: un fallo aqui jamas debe afectar la respuesta 201 de Ventas,
// ni impresion, inventario, caja o facturacion.
export const notifyPaidInvoice = async ({ idFactura } = {}) => {
  try {
    enqueueInvoiceAccumulation({ idFactura }, accumulateInvoicePoints);
  } catch (err) {
    console.error('[fidelizacion:notify] error al encolar acumulacion:', {
      id_factura: idFactura || null,
      code: err?.code || err?.name || 'FIDELIZACION_NOTIFY_ERROR'
    });
  }
};
