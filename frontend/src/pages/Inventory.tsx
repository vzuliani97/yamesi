import { FormEvent, useState } from 'react';
import { api, ApiError, errorMessage, Lot, Piece } from '../api';
import type { PageProps } from '../App';
import { CATEGORIES, formatCop, formatGrams, titleCase } from '../format';
import { useApi } from '../useApi';

type Message = { kind: 'ok' | 'error'; text: string } | null;

export function InventoryPage({ token, user, onUnauthorized }: PageProps) {
  const pieces = useApi<Piece[]>('/pieces', token, onUnauthorized);
  const lots = useApi<Lot[]>('/lots', token, onUnauthorized);
  const isAdmin = user.role === 'ADMIN';

  const reloadAll = () => Promise.all([pieces.reload(), lots.reload()]);

  return (
    <div className="grid">
      {isAdmin && <NewLotForm token={token} onCreated={reloadAll} onUnauthorized={onUnauthorized} />}
      {isAdmin && <NewPieceForm token={token} lots={lots.data ?? []} onCreated={reloadAll} onUnauthorized={onUnauthorized} />}

      <section className="card wide">
        <h2>Lotes de oro</h2>
        <table>
          <thead>
            <tr>
              <th>Lote</th>
              <th>Kilates</th>
              <th>Proveedor</th>
              <th>Comprado</th>
              <th>Disponible</th>
              <th>Costo / g</th>
            </tr>
          </thead>
          <tbody>
            {(lots.data ?? []).map((lot) => (
              <tr key={lot.id}>
                <td>{lot.code}</td>
                <td>{lot.karat}k</td>
                <td>{lot.supplier}</td>
                <td>{lot.purchasedOn}</td>
                <td>
                  {formatGrams(lot.remainingGrams)} de {formatGrams(lot.totalGrams)}
                </td>
                <td>{formatCop(lot.costPerGram)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card wide">
        <h2>Piezas</h2>
        {pieces.error && <p className="alert error">{pieces.error}</p>}
        <div className="pieces">
          {(pieces.data ?? []).map((piece) => (
            <div key={piece.id} className={piece.status === 'SOLD' ? 'piece sold' : 'piece'}>
              {piece.imageUrl ? <img src={piece.imageUrl} alt={piece.name} /> : <div className="placeholder">{piece.karat}k</div>}
              <strong>{piece.name}</strong>
              <span className="muted">
                {piece.sku} · lote {piece.lotCode} · {formatGrams(piece.grams)}
              </span>
              <span>
                {formatCop(piece.price)} · {piece.status === 'SOLD' ? 'Vendida' : 'Disponible'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface FormProps {
  token: string;
  onCreated: () => Promise<unknown>;
  onUnauthorized: () => void;
}

function useSubmit(onUnauthorized: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await action() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, run };
}

function NewLotForm({ token, onCreated, onUnauthorized }: FormProps) {
  const { busy, message, run } = useSubmit(onUnauthorized);
  const [form, setForm] = useState({ karat: '18', supplier: '', grams: '', costPerGram: '', purchasedOn: '' });
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [field]: e.target.value });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const lot = await api<Lot>('/lots', {
        method: 'POST',
        token,
        body: {
          karat: Number(form.karat),
          supplier: form.supplier.trim(),
          grams: Number(form.grams),
          costPerGram: Number(form.costPerGram),
          purchasedOn: form.purchasedOn,
        },
      });
      setForm({ ...form, supplier: '', grams: '', costPerGram: '' });
      await onCreated();
      return `Lote ${lot.code} registrado.`;
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Nuevo lote de oro</h2>
      <label>
        Kilates
        <select value={form.karat} onChange={set('karat')}>
          <option value="18">18k (ley 750)</option>
        </select>
      </label>
      <label>
        Proveedor
        <input value={form.supplier} onChange={set('supplier')} required minLength={2} />
      </label>
      <label>
        Gramos
        <input type="number" step="0.001" min="0.001" value={form.grams} onChange={set('grams')} required />
      </label>
      <label>
        Costo por gramo (COP)
        <input type="number" step="1" min="1" value={form.costPerGram} onChange={set('costPerGram')} required />
      </label>
      <label>
        Fecha de compra
        <input type="date" value={form.purchasedOn} onChange={set('purchasedOn')} required />
      </label>
      {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
      <button type="submit" disabled={busy}>
        Registrar lote
      </button>
    </form>
  );
}

function NewPieceForm({ token, lots, onCreated, onUnauthorized }: FormProps & { lots: Lot[] }) {
  const { busy, message, run } = useSubmit(onUnauthorized);
  const [image, setImage] = useState<File | null>(null);
  const [form, setForm] = useState({ name: '', category: 'ANILLO', lotId: '', grams: '', laborCost: '', price: '' });
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [field]: e.target.value });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const data = new FormData();
      Object.entries(form).forEach(([key, value]) => data.append(key, value.trim()));
      if (image) data.append('image', image);

      const piece = await api<Piece>('/pieces', { method: 'POST', token, body: data });
      setForm({ ...form, name: '', grams: '', laborCost: '', price: '' });
      setImage(null);
      await onCreated();
      return `Pieza ${piece.sku} creada.`;
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Nueva pieza</h2>
      <label>
        Nombre
        <input value={form.name} onChange={set('name')} required minLength={2} />
      </label>
      <label>
        Categoría
        <select value={form.category} onChange={set('category')}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Lote de oro
        <select value={form.lotId} onChange={set('lotId')} required>
          <option value="" disabled>
            Selecciona un lote
          </option>
          {lots
            .filter((lot) => lot.remainingGrams > 0)
            .map((lot) => (
              <option key={lot.id} value={lot.id}>
                {lot.code} · {lot.karat}k · quedan {formatGrams(lot.remainingGrams)}
              </option>
            ))}
        </select>
      </label>
      <label>
        Gramos de oro
        <input type="number" step="0.001" min="0.001" value={form.grams} onChange={set('grams')} required />
      </label>
      <label>
        Mano de obra (COP)
        <input type="number" step="1" min="0" value={form.laborCost} onChange={set('laborCost')} required />
      </label>
      <label>
        Precio de venta (COP)
        <input type="number" step="1" min="1" value={form.price} onChange={set('price')} required />
      </label>
      <label>
        Foto (opcional, máx. 2 MB)
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
      </label>
      {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
      <button type="submit" disabled={busy}>
        Crear pieza
      </button>
    </form>
  );
}
