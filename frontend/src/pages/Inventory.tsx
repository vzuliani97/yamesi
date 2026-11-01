import { FormEvent, useEffect, useRef, useState } from 'react';
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
      <CatalogPortal
        pieces={pieces.data ?? []}
        error={pieces.error}
        isAdmin={isAdmin}
        token={token}
        onChanged={pieces.reload}
        onUnauthorized={onUnauthorized}
      />

      {isAdmin && <NewPieceForm token={token} lots={lots.data ?? []} onCreated={reloadAll} onUnauthorized={onUnauthorized} />}
      {isAdmin && <NewLotForm token={token} onCreated={reloadAll} onUnauthorized={onUnauthorized} />}

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
    </div>
  );
}

type StatusFilter = 'IN_STOCK' | 'SOLD' | 'ALL';

interface PortalProps {
  pieces: Piece[];
  error: string | null;
  isAdmin: boolean;
  token: string;
  onChanged: () => Promise<unknown>;
  onUnauthorized: () => void;
}

/** The catalog as the store sees it: search, filter, and (for admins) edit a piece or replace its photo. */
function CatalogPortal({ pieces, error, isAdmin, token, onChanged, onUnauthorized }: PortalProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('ALL');
  const [status, setStatus] = useState<StatusFilter>('IN_STOCK');
  const [editing, setEditing] = useState<Piece | null>(null);

  const inStock = pieces.filter((piece) => piece.status === 'IN_STOCK');
  const stockValue = inStock.reduce((sum, piece) => sum + piece.price, 0);
  const stockGrams = inStock.reduce((sum, piece) => sum + piece.grams, 0);
  const withoutPhoto = inStock.filter((piece) => !piece.imageUrl).length;

  const needle = query.trim().toLowerCase();
  const visible = pieces.filter(
    (piece) =>
      (status === 'ALL' || piece.status === status) &&
      (category === 'ALL' || piece.category === category) &&
      `${piece.name} ${piece.reference ?? ''} ${piece.sku} ${piece.size ?? ''}`.toLowerCase().includes(needle),
  );

  return (
    <section className="card wide">
      <h2>
        Catálogo
        <span className="badge neutral">{visible.length} piezas</span>
      </h2>
      <div className="stats">
        <div>
          <span>En vitrina</span>
          <strong>{inStock.length}</strong>
        </div>
        <div>
          <span>Valor de venta</span>
          <strong>{formatCop(stockValue)}</strong>
        </div>
        <div>
          <span>Oro en vitrina</span>
          <strong>{formatGrams(Math.round(stockGrams * 1000) / 1000)}</strong>
        </div>
        <div>
          <span>Sin foto</span>
          <strong>{withoutPhoto}</strong>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Buscar por nombre, referencia o talla"
          aria-label="Buscar en el catálogo"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select aria-label="Categoría" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="ALL">Todas las categorías</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)}
            </option>
          ))}
        </select>
        <select aria-label="Estado" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="IN_STOCK">Disponibles</option>
          <option value="SOLD">Vendidas</option>
          <option value="ALL">Todas</option>
        </select>
      </div>

      {error && <p className="alert error">{error}</p>}
      <div className="pieces">
        {visible.map((piece) => (
          <article key={piece.id} className={piece.status === 'SOLD' ? 'piece sold' : 'piece'}>
            {piece.imageUrl ? <img src={piece.imageUrl} alt={piece.name} /> : <div className="placeholder">Sin foto</div>}
            <strong>{piece.name}</strong>
            <span className="muted">
              {piece.reference ?? piece.sku} · lote {piece.lotCode} · {formatGrams(piece.grams)}
              {piece.size && ` · ${piece.size}`}
            </span>
            <span className="piece-foot">
              <span className="price">{formatCop(piece.price)}</span>
              {piece.status === 'SOLD' ? (
                <span className="badge neutral">Vendida</span>
              ) : (
                isAdmin && (
                  <button type="button" className="link" onClick={() => setEditing(piece)}>
                    {piece.imageUrl ? 'Editar' : 'Subir foto'}
                  </button>
                )
              )}
            </span>
          </article>
        ))}
      </div>
      {visible.length === 0 && <p className="muted">Ninguna pieza coincide con la búsqueda.</p>}

      {editing && (
        <EditPieceDialog
          piece={editing}
          token={token}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
          onUnauthorized={onUnauthorized}
        />
      )}
    </section>
  );
}

interface EditProps {
  piece: Piece;
  token: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onUnauthorized: () => void;
}

function EditPieceDialog({ piece, token, onClose, onSaved, onUnauthorized }: EditProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { busy, message, run } = useSubmit(onUnauthorized);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(piece.imageUrl);
  const [form, setForm] = useState({
    name: piece.name,
    reference: piece.reference ?? '',
    size: piece.size ?? '',
    category: piece.category,
    price: String(piece.price),
  });
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [field]: e.target.value });

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const pickPhoto = (file: File | undefined) => file && setPhoto(file);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      // Only the fields that changed are sent, so the audit log records exactly what was edited.
      const next = {
        name: form.name.trim(),
        reference: form.reference.trim() ? form.reference.trim().toUpperCase() : null,
        size: form.size.trim() || null,
        category: form.category,
        price: Number(form.price),
      };
      const changes = Object.fromEntries(
        Object.entries(next).filter(([key, value]) => value !== (piece as unknown as Record<string, unknown>)[key]),
      );
      if (Object.keys(changes).length > 0) {
        await api<Piece>(`/pieces/${piece.id}`, { method: 'PATCH', token, body: changes });
      }
      if (photo) {
        const data = new FormData();
        data.append('image', photo);
        await api<Piece>(`/pieces/${piece.id}/photo`, { method: 'PUT', token, body: data });
      }
      await onSaved();
      return 'Pieza actualizada.';
    });
  };

  return (
    <dialog ref={dialog} className="edit-dialog" onClose={onClose} aria-labelledby="edit-title">
      <form onSubmit={submit}>
        <header>
          <h2 id="edit-title">Editar {piece.reference ?? piece.sku}</h2>
          <button type="button" className="link" onClick={onClose}>
            Cerrar
          </button>
        </header>
        <label
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pickPhoto(e.dataTransfer.files[0]);
          }}
        >
          {preview ? <img src={preview} alt={`Foto de ${piece.name}`} /> : <span className="placeholder">Sin foto</span>}
          <span>{photo ? photo.name : 'Arrastra una foto aquí o haz clic para elegirla (JPEG, PNG o WebP, máx. 2 MB)'}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => pickPhoto(e.target.files?.[0])} />
        </label>
        <label>
          Nombre
          <input value={form.name} onChange={set('name')} required minLength={2} />
        </label>
        <div className="row">
          <label>
            Referencia
            <input value={form.reference} onChange={set('reference')} pattern="[A-Za-z0-9][A-Za-z0-9-]{1,23}" />
          </label>
          <label>
            Talla o largo
            <input value={form.size} onChange={set('size')} maxLength={24} />
          </label>
        </div>
        <div className="row">
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
            Precio de venta (COP, con IVA)
            <input type="number" step="1" min="1" value={form.price} onChange={set('price')} required />
          </label>
        </div>
        <p className="hint">
          {formatGrams(piece.grams)} de oro {piece.karat}k del lote {piece.lotCode}. El peso y el lote no se editan: el oro ya se
          descontó del lote.
        </p>
        {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
        <button type="submit" className="btn-gold" disabled={busy}>
          Guardar cambios
        </button>
      </form>
    </dialog>
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
  const [form, setForm] = useState({
    name: '',
    reference: '',
    size: '',
    category: 'ANILLO',
    lotId: '',
    grams: '',
    laborCost: '',
    price: '',
  });
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [field]: e.target.value });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const data = new FormData();
      Object.entries(form).forEach(([key, value]) => data.append(key, value.trim()));
      if (image) data.append('image', image);

      const piece = await api<Piece>('/pieces', { method: 'POST', token, body: data });
      setForm({ ...form, name: '', reference: '', size: '', grams: '', laborCost: '', price: '' });
      setImage(null);
      await onCreated();
      return `Pieza ${piece.reference ?? piece.sku} creada.`;
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Nueva pieza</h2>
      <label>
        Nombre
        <input value={form.name} onChange={set('name')} required minLength={2} />
      </label>
      <div className="row">
        <label>
          Referencia (opcional)
          <input value={form.reference} onChange={set('reference')} placeholder="AN-DAM-172" pattern="[A-Za-z0-9][A-Za-z0-9-]{1,23}" />
        </label>
        <label>
          Talla o largo (opcional)
          <input value={form.size} onChange={set('size')} placeholder="Talla 7 o 45 cm" maxLength={24} />
        </label>
      </div>
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
