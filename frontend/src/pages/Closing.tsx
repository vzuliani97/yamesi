import { FormEvent, useState } from 'react';
import { api, ApiError, DaySummary, errorMessage } from '../api';
import type { PageProps } from '../App';
import { formatCop, PAYMENT_LABELS } from '../format';
import { useApi } from '../useApi';

export function ClosingPage({ token, user, onUnauthorized }: PageProps) {
  const summary = useApi<DaySummary>('/closings/today', token, onUnauthorized);
  const [countedCash, setCountedCash] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const day = summary.data;

  async function close(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<DaySummary>('/closings', {
        method: 'POST',
        token,
        body: { countedCash: Number(countedCash), ...(notes.trim() ? { notes: notes.trim() } : {}) },
      });
      await summary.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!day) {
    return <p className="muted">{summary.error ?? 'Cargando…'}</p>;
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Caja del {day.date}</h2>
        <table>
          <tbody>
            <tr>
              <td>Base de apertura</td>
              <td>{formatCop(day.openingCash)}</td>
            </tr>
            {Object.entries(day.salesByMethod).map(([method, total]) => (
              <tr key={method}>
                <td>Ventas en {PAYMENT_LABELS[method as keyof typeof PAYMENT_LABELS].toLowerCase()}</td>
                <td>{formatCop(total)}</td>
              </tr>
            ))}
            <tr>
              <td>Gastos de caja menor</td>
              <td className="negative">−{formatCop(day.expenses)}</td>
            </tr>
            <tr>
              <td>
                <strong>Efectivo esperado</strong>
              </td>
              <td>
                <strong>{formatCop(day.expectedCash)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          {day.invoiceCount} factura(s). Las ventas con tarjeta y transferencia no entran a la caja.
        </p>
      </section>

      {day.closed && day.closing ? (
        <section className="card">
          <h2>Día cerrado</h2>
          <p>Efectivo contado: {formatCop(day.closing.countedCash)}</p>
          <p className={day.closing.difference === 0 ? 'positive' : 'negative'}>
            Diferencia: {formatCop(day.closing.difference)}
            {day.closing.difference === 0 ? ' (cuadra)' : day.closing.difference < 0 ? ' (faltante)' : ' (sobrante)'}
          </p>
          {day.closing.notes && <p className="muted">{day.closing.notes}</p>}
        </section>
      ) : user.role === 'ADMIN' ? (
        <form className="card" onSubmit={close}>
          <h2>Cerrar el día</h2>
          <label>
            Efectivo contado en caja (COP)
            <input type="number" min="0" step="1" value={countedCash} onChange={(e) => setCountedCash(e.target.value)} required />
          </label>
          {countedCash !== '' && (
            <p className="muted">Diferencia: {formatCop(Number(countedCash) - day.expectedCash)}</p>
          )}
          <label>
            Observaciones (opcional)
            <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
          </label>
          {error && <p className="alert error">{error}</p>}
          <button type="submit" disabled={busy}>
            Cerrar caja
          </button>
          <p className="hint">Después del cierre no se pueden registrar más ventas ni gastos en esta fecha.</p>
        </form>
      ) : (
        <section className="card">
          <p className="muted">El cierre de caja lo hace la administración.</p>
        </section>
      )}
    </div>
  );
}
