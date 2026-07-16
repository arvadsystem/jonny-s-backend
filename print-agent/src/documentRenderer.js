const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = (value) => `L ${Number(value || 0).toFixed(2)}`;

export const renderPrintJobHtml = (payload) => {
  if (Number(payload?.schema_version) !== 1 || !payload?.documento) throw new Error('PAYLOAD_NO_SOPORTADO');
  const doc = payload.documento;
  const rows = (Array.isArray(doc.items) ? doc.items : []).map((item) =>
    `<tr><td>${escapeHtml(item.cantidad)}</td><td>${escapeHtml(item.descripcion)}</td><td>${money(item.total)}</td></tr>`
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;font-size:11px;margin:0;padding:2mm;color:#000}h1{text-align:center;font-size:16px;margin:0 0 4px}
    p{margin:2px 0}table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:2px 0}td:last-child{text-align:right}
    .total{font-size:14px;font-weight:bold;border-top:1px dashed #000;margin-top:5px;padding-top:5px}.center{text-align:center}
  </style></head><body><h1>${escapeHtml(doc.titulo || "JONNY'S WINGS")}</h1>
  <p class="center">${escapeHtml(doc.sucursal || '')}</p><p>${escapeHtml(doc.numero || '')}</p><p>${escapeHtml(doc.fecha || '')}</p>
  <p>Cliente: ${escapeHtml(doc.cliente || 'Consumidor final')}</p><table>${rows}</table>
  ${Number(doc.descuento || 0) ? `<p>Descuento: ${money(doc.descuento)}</p>` : ''}<p class="total">TOTAL: ${money(doc.total)}</p>
  <p class="center">${escapeHtml(doc.pie || '')}</p></body></html>`;
};
