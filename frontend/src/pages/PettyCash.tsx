import { FormEvent, useState } from 'react';
import { api, ApiError, errorMessage, Expense } from '../api';
import type { PageProps } from '../App';
import { EXPENSE_CATEGORIES, formatCop, titleCase } from '../format';
import { useApi } from '../useApi';

export function PettyCashPage({ token, onUnauthorized }: PageProps) {
  const expenses = useApi<Expense[]>('/expenses', token, onUnauthorized);
  const [category, setCategory] = useState<string>('TRANSPORTE');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const data = new FormData();
    data.append('category', category);
    data.append('description', description.trim());
    data.append('amount', amount);
    if (receipt) data.append('receipt', receipt);

    try {
      await api<Expense>('/expenses', { method: 'POST', token, body: data });
      setMessage({ kind: 'ok', text: 'Gasto registrado.' });
      setDescription('');
      setAmount('');
      setReceipt(null);
      (event.target as HTMLFormElement).reset();
      await expenses.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const total = (expenses.data ?? []).reduce((sum, e) => sum + e.amount, 0);

  return (
    <div className="grid">
      <form className="card" onSubmit={submit}>
        <h2>Registrar gasto de caja menor</h2>
        <label>
          Categoría
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Descripción
          <input value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} maxLength={200} />
        </label>
        <label>
          Valor (COP)
          <input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label>
          Foto del recibo (opcional)
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
        </label>
        {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
        <button type="submit" disabled={busy}>
          Registrar
        </button>
      </form>

      <section className="card">
        <h2>Gastos de hoy · {formatCop(total)}</h2>
        {expenses.error && <p className="alert error">{expenses.error}</p>}
        <table>
          <tbody>
            {(expenses.data ?? []).map((e) => (
              <tr key={e.id}>
                <td>{titleCase(e.category)}</td>
                <td>{e.description}</td>
                <td>{formatCop(e.amount)}</td>
                <td>
                  {e.receiptUrl ? (
                    <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="receipt-thumb">
                      <img src={e.receiptUrl} alt={`Recibo: ${e.description}`} />
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {expenses.data?.length === 0 && <p className="muted">Sin gastos hoy.</p>}
      </section>

      {(expenses.data ?? []).some((e) => e.receiptUrl) && (
        <section className="card wide">
          <h2>Recibos del día</h2>
          <div className="receipts">
            {(expenses.data ?? [])
              .filter((e) => e.receiptUrl)
              .map((e) => (
                <figure key={e.id}>
                  <a href={e.receiptUrl!} target="_blank" rel="noreferrer">
                    <img src={e.receiptUrl!} alt={`Recibo: ${e.description}`} loading="lazy" />
                  </a>
                  <figcaption>
                    {e.description} · {formatCop(e.amount)}
                  </figcaption>
                </figure>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
