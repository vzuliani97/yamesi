import { useState } from 'react';
import type { PageProps } from '../App';
import { formatCop, formatGrams } from '../format';
import { useApi } from '../useApi';

interface GoldRow {
  karat: number;
  gramsInLots: number;
  gramsInStock: number;
  gramsSold: number;
  lotsValueAtCost: number;
}

interface Margins {
  invoices: number;
  revenue: number;
  cost: number;
  grossMargin: number;
  marginPercent: number;
}

interface AuditEntry {
  id: number;
  action: string;
  entityId: string;
  actor: string;
  createdAt: string;
}

// en-CA gives YYYY-MM-DD in the browser's local time zone (toISOString would use UTC).
const today = () => new Date().toLocaleDateString('en-CA');
const monthStart = () => today().slice(0, 8) + '01';

export function ReportsPage({ token, onUnauthorized }: PageProps) {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const gold = useApi<GoldRow[]>('/reports/gold-inventory', token, onUnauthorized);
  const margins = useApi<Margins>(`/reports/margins?from=${from}&to=${to}`, token, onUnauthorized);
  const audit = useApi<AuditEntry[]>('/audit', token, onUnauthorized);

  return (
    <div className="grid">
      <section className="card">
        <h2>Oro por kilataje</h2>
        <table>
          <thead>
            <tr>
              <th>Kilates</th>
              <th>En lotes</th>
              <th>En piezas</th>
              <th>Vendido</th>
              <th>Valor en lotes</th>
            </tr>
          </thead>
          <tbody>
            {(gold.data ?? []).map((row) => (
              <tr key={row.karat}>
                <td>{row.karat}k</td>
                <td>{formatGrams(row.gramsInLots)}</td>
                <td>{formatGrams(row.gramsInStock)}</td>
                <td>{formatGrams(row.gramsSold)}</td>
                <td>{formatCop(row.lotsValueAtCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Margen bruto</h2>
        <div className="row">
          <label>
            Desde
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Hasta
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {margins.data && (
          <table>
            <tbody>
              <tr>
                <td>Facturas</td>
                <td>{margins.data.invoices}</td>
              </tr>
              <tr>
                <td>Ventas</td>
                <td>{formatCop(margins.data.revenue)}</td>
              </tr>
              <tr>
                <td>Costo (oro + mano de obra)</td>
                <td>{formatCop(margins.data.cost)}</td>
              </tr>
              <tr>
                <td>
                  <strong>Margen</strong>
                </td>
                <td>
                  <strong>
                    {formatCop(margins.data.grossMargin)} ({margins.data.marginPercent}%)
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {margins.error && <p className="alert error">{margins.error}</p>}
      </section>

      <section className="card wide">
        <h2>Auditoría</h2>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Usuario</th>
              <th>Acción</th>
              <th>Registro</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data ?? []).map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString('es-CO')}</td>
                <td>{entry.actor}</td>
                <td>{entry.action}</td>
                <td>{entry.entityId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
