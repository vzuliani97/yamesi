import { FormEvent, useRef, useState } from 'react';
import { api, ApiError, DocumentType, errorMessage, Invoice, openPdf, PaymentMethod, Piece } from '../api';
import type { PageProps } from '../App';
import { DOCUMENT_LABELS, formatCop, formatGrams, PAYMENT_LABELS, splitVat, VAT_RATE } from '../format';
import { useApi } from '../useApi';

const EMPTY_CUSTOMER = { name: '', documentType: '' as DocumentType | '', document: '', email: '', phone: '', address: '' };

export function SellPage({ token, onUnauthorized }: PageProps) {
  const pieces = useApi<Piece[]>('/pieces?status=IN_STOCK', token, onUnauthorized);
  const invoices = useApi<Invoice[]>('/invoices', token, onUnauthorized);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [customer, setCustomer] = useState(EMPTY_CUSTOMER);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [paymentReference, setPaymentReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Invoice | null>(null);
  // One key per sale attempt: a retry after a network error can never invoice twice.
  // Any edit starts a new attempt, so a changed sale never reuses the key of a different one.
  const pendingKey = useRef<string | null>(null);

  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      pendingKey.current = null;
      setter(value);
    };
  const editCustomer = (field: keyof typeof EMPTY_CUSTOMER) => (value: string) =>
    // Choosing "consumidor final" clears the number, so a hidden document never reaches the invoice.
    edit(setCustomer)({ ...customer, [field]: value, ...(field === 'documentType' && !value ? { document: '' } : {}) });

  const toggle = (id: number) => {
    setIssued(null);
    edit(setSelected)(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const available = (pieces.data ?? []).filter((piece) =>
    `${piece.name} ${piece.reference ?? ''} ${piece.sku} ${piece.size ?? ''} ${piece.karat}k`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const cart = (pieces.data ?? []).filter((piece) => selected.includes(piece.id));
  const total = cart.reduce((sum, piece) => sum + piece.price, 0);
  const subtotal = cart.reduce((sum, piece) => sum + splitVat(piece.price).taxBase, 0);
  const goldGrams = cart.reduce((sum, piece) => sum + piece.grams, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    pendingKey.current ??= crypto.randomUUID();
    setBusy(true);
    setError(null);

    const optional = (value: string) => (value.trim() ? value.trim() : undefined);
    try {
      const response = await api<{ data: Invoice }>('/invoices', {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': pendingKey.current },
        body: {
          customerName: customer.name.trim(),
          customerDocumentType: customer.document.trim() ? customer.documentType || undefined : undefined,
          customerDocument: optional(customer.document),
          customerEmail: optional(customer.email),
          customerPhone: optional(customer.phone),
          customerAddress: optional(customer.address),
          paymentMethod,
          paymentReference: paymentMethod === 'CASH' ? undefined : optional(paymentReference),
          pieceIds: selected,
        },
      });
      pendingKey.current = null;
      setIssued(response.data);
      setSelected([]);
      setCustomer(EMPTY_CUSTOMER);
      setPaymentReference('');
      await Promise.all([pieces.reload(), invoices.reload()]);
    } catch (err) {
      if (err instanceof ApiError) {
        pendingKey.current = null;
        if (err.status === 401) return onUnauthorized();
      }
      setError(errorMessage(err));
      await pieces.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sell">
        <section className="card">
          <h2>
            Piezas disponibles <span className="badge neutral">{available.length}</span>
          </h2>
          <input
            className="search"
            type="search"
            placeholder="Buscar por nombre, referencia o talla"
            aria-label="Buscar piezas"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {pieces.error && <p className="alert error">{pieces.error}</p>}
          <div className="pieces">
            {available.map((piece) => (
              <label key={piece.id} className={selected.includes(piece.id) ? 'piece selected' : 'piece'}>
                <input type="checkbox" checked={selected.includes(piece.id)} onChange={() => toggle(piece.id)} />
                {piece.imageUrl ? <img src={piece.imageUrl} alt={piece.name} /> : <div className="placeholder">{piece.karat}k</div>}
                <strong>{piece.name}</strong>
                <span className="muted">
                  {piece.reference ?? piece.sku} · {piece.karat}k · {formatGrams(piece.grams)}
                  {piece.size && ` · ${piece.size}`}
                </span>
                <span className="price">{formatCop(piece.price)}</span>
              </label>
            ))}
          </div>
          {pieces.data?.length === 0 && <p className="muted">No hay piezas disponibles.</p>}
        </section>

        <form className="card invoice-panel" onSubmit={submit}>
          <h2>Factura de venta</h2>

          {issued && (
            <div className="issued" role="status">
              <span className="muted">Factura emitida</span>
              <strong>
                {issued.fullNumber} · {formatCop(issued.total)}
              </strong>
              <span className="hint">
                Base {formatCop(issued.subtotal)} · IVA {formatCop(issued.vatTotal)} · CUFE {issued.cufe?.slice(0, 12)}…
              </span>
              <button type="button" className="btn-secondary" onClick={() => void openPdf(`/invoices/${issued.id}/pdf`, token)}>
                Ver factura (PDF)
              </button>
            </div>
          )}

          <div className="panel-section">
            <h3>Cliente</h3>
            <label>
              Nombre o razón social
              <input value={customer.name} onChange={(e) => editCustomer('name')(e.target.value)} required minLength={2} autoComplete="name" />
            </label>
            <div className="row">
              <label>
                Tipo de documento
                <select value={customer.documentType} onChange={(e) => editCustomer('documentType')(e.target.value)}>
                  <option value="">Consumidor final</option>
                  {Object.entries(DOCUMENT_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Número
                <input
                  value={customer.document}
                  onChange={(e) => editCustomer('document')(e.target.value)}
                  pattern="[0-9A-Za-z-]{5,20}"
                  disabled={!customer.documentType}
                  required={Boolean(customer.documentType)}
                  placeholder={customer.documentType === 'NIT' ? '900123456-7' : ''}
                />
              </label>
            </div>
            <div className="row">
              <label>
                Correo electrónico
                <input type="email" value={customer.email} onChange={(e) => editCustomer('email')(e.target.value)} autoComplete="email" />
              </label>
              <label>
                Teléfono
                <input type="tel" value={customer.phone} onChange={(e) => editCustomer('phone')(e.target.value)} pattern="[0-9+() -]{7,20}" autoComplete="tel" />
              </label>
            </div>
            <label>
              Dirección (opcional)
              <input value={customer.address} onChange={(e) => editCustomer('address')(e.target.value)} minLength={5} autoComplete="street-address" />
            </label>
          </div>

          <div className="panel-section">
            <h3>Pago de contado</h3>
            <div className="segmented" role="radiogroup" aria-label="Medio de pago">
              {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((method) => (
                <label key={method}>
                  <input
                    type="radio"
                    name="paymentMethod"
                    value={method}
                    checked={paymentMethod === method}
                    onChange={() => edit(setPaymentMethod)(method)}
                  />
                  {PAYMENT_LABELS[method]}
                </label>
              ))}
            </div>
            {paymentMethod !== 'CASH' && (
              <label>
                {paymentMethod === 'CARD' ? 'N.º de aprobación del datáfono' : 'N.º de la transferencia'}
                <input value={paymentReference} onChange={(e) => edit(setPaymentReference)(e.target.value)} pattern="[0-9A-Za-z-]{4,40}" />
              </label>
            )}
          </div>

          <div className="stack">
            <h3 className="section-title">Resumen</h3>
            {cart.length === 0 && <p className="hint">Selecciona una o más piezas del catálogo.</p>}
            {cart.map((piece) => (
              <div key={piece.id} className="summary-line item">
                <span>
                  {piece.name} · {piece.reference ?? piece.sku} · {formatGrams(piece.grams)}
                </span>
                <span>{formatCop(piece.price)}</span>
              </div>
            ))}
            <div className="summary-line">
              <span>Subtotal (base gravable)</span>
              <span>{formatCop(subtotal)}</span>
            </div>
            <div className="summary-line">
              <span>IVA {VAT_RATE} %</span>
              <span>{formatCop(total - subtotal)}</span>
            </div>
            <div className="summary-line">
              <span>Oro</span>
              <span>{formatGrams(goldGrams)}</span>
            </div>
            <div className="summary-total">
              <span>Total a pagar</span>
              <strong>{formatCop(total)}</strong>
            </div>
          </div>

          {error && <p className="alert error">{error}</p>}
          <button type="submit" className="btn-gold" disabled={busy || selected.length === 0}>
            {busy ? 'Emitiendo factura…' : 'Emitir factura'}
          </button>
          <p className="hint">Incluye garantía de por vida sobre el oro. El precio de cada pieza ya incluye IVA.</p>
        </form>
      </div>

      <section className="card">
        <h2>Facturas de hoy</h2>
        <table>
          <thead>
            <tr>
              <th>Factura</th>
              <th>Cliente</th>
              <th>Pago</th>
              <th className="num">Base</th>
              <th className="num">IVA</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(invoices.data ?? []).map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <strong>{invoice.fullNumber}</strong>
                </td>
                <td>
                  {invoice.customerName}
                  <small>
                    {invoice.customerDocument ? `${invoice.customerDocumentType} ${invoice.customerDocument}` : 'Consumidor final'}
                  </small>
                </td>
                <td>
                  <span className="badge neutral">{PAYMENT_LABELS[invoice.paymentMethod]}</span>
                </td>
                <td className="num">{formatCop(invoice.subtotal)}</td>
                <td className="num">{formatCop(invoice.vatTotal)}</td>
                <td className="num">
                  <strong>{formatCop(invoice.total)}</strong>
                </td>
                <td className="num">
                  <button className="link" onClick={() => void openPdf(`/invoices/${invoice.id}/pdf`, token)}>
                    PDF
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {invoices.data?.length === 0 && <p className="muted">Aún no hay ventas hoy.</p>}
      </section>
    </>
  );
}
