import { FormEvent, useState } from 'react';
import { api, errorMessage, User } from '../api';
import type { Session } from '../App';
import { DEMO_PASSWORD, IS_PUBLIC_DEMO } from '../demo';
import { DemoNotice } from '../WakeGate';

export function LoginPage({ onSignIn }: { onSignIn: (session: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api<{ accessToken: string; user: User }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      onSignIn({ token: result.accessToken, user: result.user });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Joyería Yamesi</h1>
        <p className="muted">Inventario, ventas y caja</p>
        <label>
          Correo
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p className="alert error">{error}</p>}
        <button type="submit" className="btn-gold" disabled={busy}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
        {IS_PUBLIC_DEMO && DEMO_PASSWORD ? (
          <p className="hint">
            Cuentas de la demo (solo datos sintéticos): <code>vendedor@yamesi.local</code> o <code>admin@yamesi.local</code>, contraseña{' '}
            <code>{DEMO_PASSWORD}</code>
          </p>
        ) : (
          <p className="hint">Demo: vendedor@yamesi.local o admin@yamesi.local</p>
        )}
      </form>
      <DemoNotice />
    </div>
  );
}
