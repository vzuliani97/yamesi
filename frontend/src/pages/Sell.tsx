import { FormEvent, useRef, useState } from 'react';
import { api, ApiError, errorMessage, Invoice, openPdf, PaymentMethod, Piece } from '../api';
import type { PageProps } from '../App';
import { formatCop, formatGrams, PAYMENT_LABELS } from '../format';
import { useApi } from '../useApi';

export function SellPage({ token, onUnauthorized }: PageProps) {
  const pieces = useApi<Piece[]>('/pieces?status=IN_STOCK', token, onUnauthorized);
  const invoices = useApi<Invoice[]>('/invoices', token, onUnauthorized);

  const [selected, setSelected] = useState<number[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerDocument, setCustomerDocument] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // One key per sale attempt: a retry after a network error can never invoice twice.
  const pendingKey = useRef<string | null>(null);

  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      pendingKey.current = null;
      setter(value);
    };

  const toggle = (id: number) =>
    edit(setSelected)(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const total = (pieces.data ?? []).filter((p) => selected.includes(p.id)).reduce((sum, p) => sum + p.price, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    pendingKey.current ??= crypto.randomUUID();
    setBusy(true);
    setMessage(null);

    try {
      const response = await api<{ data: Invoice }>('/invoices', {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': pendingKey.current },
        body: {
          customerName: customerName.trim(),
          ...(customerDocument.trim() ? { customerDocument: customerDocument.trim() } : {}),
          paymentMethod,
          pieceIds: selected,
        },
      });
      pendingKey.current = null;
      setMessage({ kind: 'ok', text: `Factura N.º ${response.data.number} por ${formatCop(response.data.total)}.` });
      setSelected([]);
      setCustomerName('');
      setCustomerDocument('');
      await Promise.all([pieces.reload(), invoices.reload()]);
    } catch (err) {
      if (err instanceof ApiError) {
        pendingKey.current = null;
        if (err.status === 401) return onUnauthorized();
      }
      setMessage({ kind: 'error', text: errorMessage(err) });
      await pieces.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <section className="card wide">
        <h2>Piezas disponibles</h2>
        {pieces.error && <p className="alert error">{pieces.error}</p>}
        <div className="pieces">
          {(pieces.data ?? []).map((piece) => (
            <label key={piece.id} className={selected.includes(piece.id) ? 'piece selected' : 'piece'}>
              <input type="checkbox" checked={selected.includes(piece.id)} onChange={() => toggle(piece.id)} />
              {piece.imageUrl ? <img src={piece.imageUrl} alt={piece.name} /> : <div className="placeholder">{piece.karat}k</div>}
              <strong>{piece.name}</strong>
              <span className="muted">
                {piece.sku} · {piece.karat}k · {formatGrams(piece.grams)}
              </span>
              <span>{formatCop(piece.price)}</span>
            </label>
          ))}
        </div>
        {pieces.data?.length === 0 && <p className="muted">No hay piezas disponibles.</p>}
      </section>

      <form className="card" onSubmit={submit}>
        <h2>Nueva venta</h2>
        <label>
          Cliente
          <input value={customerName} onChange={(e) => edit(setCustomerName)(e.target.value)} required minLength={2} />
        </label>
        <label>
          Documento (opcional)
          <input value={customerDocument} onChange={(e) => edit(setCustomerDocument)(e.target.value)} pattern="[0-9A-Za-z-]{5,20}" />
        </label>
        <label>
          Forma de pago
          <select value={paymentMethod} onChange={(e) => edit(setPaymentMethod)(e.target.value as PaymentMethod)}>
            {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="total">
          {selected.length} pieza(s) · <strong>{formatCop(total)}</strong>
        </p>
        {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
        <button type="submit" disabled={busy || selected.length === 0}>
          {busy ? 'Facturando…' : 'Facturar'}
        </button>
      </form>

      <section className="card">
        <h2>Facturas de hoy</h2>
        <table>
          <tbody>
            {(invoices.data ?? []).map((invoice) => (
              <tr key={invoice.id}>
                <td>N.º {invoice.number}</td>
                <td>{invoice.customerName}</td>
                <td>{PAYMENT_LABELS[invoice.paymentMethod]}</td>
                <td>{formatCop(invoice.total)}</td>
                <td>
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
    </div>
  );
}
