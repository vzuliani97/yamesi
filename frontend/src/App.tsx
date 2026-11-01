import { useCallback, useState } from 'react';
import { User } from './api';
import { AssistantPage } from './pages/Assistant';
import { ClosingPage } from './pages/Closing';
import { InventoryPage } from './pages/Inventory';
import { LoginPage } from './pages/Login';
import { PettyCashPage } from './pages/PettyCash';
import { ReportsPage } from './pages/Reports';
import { SellPage } from './pages/Sell';

export interface Session {
  token: string;
  user: User;
}

export interface PageProps {
  token: string;
  user: User;
  onUnauthorized: () => void;
}

const STORAGE_KEY = 'yamesi.session';

// Simple line icons (24x24 viewBox), drawn inline so the app needs no icon package.
const ICONS = {
  sell: 'M6 6h15l-1.5 9h-12L6 6Zm0 0L5 3H2m6 18a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  inventory: 'M3 7l9-4 9 4-9 4-9-4Zm0 0v10l9 4 9-4V7M12 11v10',
  'petty-cash': 'M4 4h16v16l-3-2-3 2-2-2-2 2-3-2-3 2V4Zm4 5h8m-8 4h5',
  closing: 'M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5V10Zm7 4v3',
  reports: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  assistant: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Zm6 12l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15Z',
} as const;

const TABS = [
  { id: 'sell', label: 'Vender', title: 'Punto de venta', subtitle: 'Selecciona las piezas y emite la factura de venta.', page: SellPage, adminOnly: false },
  { id: 'inventory', label: 'Inventario', title: 'Inventario y catálogo', subtitle: 'Piezas con foto, referencia y peso; lotes de oro con trazabilidad.', page: InventoryPage, adminOnly: false },
  { id: 'petty-cash', label: 'Caja menor', title: 'Caja menor', subtitle: 'Gastos del día con la foto de su recibo.', page: PettyCashPage, adminOnly: false },
  { id: 'closing', label: 'Cierre de caja', title: 'Cierre de caja', subtitle: 'Efectivo esperado contra contado; el cierre bloquea el día.', page: ClosingPage, adminOnly: false },
  { id: 'reports', label: 'Reportes', title: 'Reportes', subtitle: 'Oro por kilataje, margen bruto y auditoría.', page: ReportsPage, adminOnly: true },
  { id: 'assistant', label: 'Asistente', title: 'Asistente', subtitle: 'Preguntas sobre el negocio, solo con consultas de lectura.', page: AssistantPage, adminOnly: true },
] as const;

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('sell');

  const signIn = (next: Session) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSession(next);
  };

  // Stable identity, so pages can list it as an effect dependency without reloading in a loop.
  const signOut = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSession(null);
  }, []);

  if (!session) {
    return <LoginPage onSignIn={signIn} />;
  }

  const tabs = TABS.filter((t) => !t.adminOnly || session.user.role === 'ADMIN');
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const Page = current.page;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            Y
          </span>
          <div>
            <strong>Joyería Yamesi</strong>
            <small>Yamesi Core</small>
          </div>
        </div>
        <nav className="tabs" aria-label="Secciones">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={t.id === current.id ? 'tab active' : 'tab'}
              aria-current={t.id === current.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={ICONS[t.id]} />
              </svg>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-user">
          {session.user.name}
          <span>{session.user.role === 'ADMIN' ? 'Administración' : 'Ventas'}</span>
          <button className="link" onClick={signOut}>
            Cerrar sesión
          </button>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <h1>{current.title}</h1>
          <p>{current.subtitle}</p>
        </header>
        <Page token={session.token} user={session.user} onUnauthorized={signOut} />
      </main>
    </div>
  );
}
