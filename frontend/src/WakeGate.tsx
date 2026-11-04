import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, IS_PUBLIC_DEMO, LINKS } from './demo';

// Free hosting stops the API after a quiet period; waking it takes about a minute.
const EXPECTED_WAKE_MS = 60_000;
const GIVE_UP_MS = 180_000;

type State = 'waking' | 'ready' | 'timeout';

/** Shows a start-up screen until the API answers /health. Outside the public demo it renders the app at once. */
export function WakeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(IS_PUBLIC_DEMO ? 'waking' : 'ready');
  const [elapsed, setElapsed] = useState(0);
  const attempt = useRef(0);

  const wake = useCallback(() => {
    let cancelled = false;
    const started = Date.now();
    attempt.current = 0;
    setState('waking');
    setElapsed(0);

    const tick = setInterval(() => setElapsed(Date.now() - started), 500);
    const poll = async () => {
      while (!cancelled) {
        try {
          const response = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(10_000) });
          if (response.ok) {
            setState('ready');
            return;
          }
        } catch {
          // Still asleep or starting: try again below.
        }
        if (Date.now() - started > GIVE_UP_MS) {
          setState('timeout');
          return;
        }
        // Bounded backoff: 2 s, 4 s, then every 8 s.
        attempt.current += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * 2 ** (attempt.current - 1), 8000)));
      }
    };
    void poll().finally(() => clearInterval(tick));
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, []);

  useEffect(() => (IS_PUBLIC_DEMO ? wake() : undefined), [wake]);

  if (state === 'ready') return <>{children}</>;

  const progress = Math.min(95, Math.round((elapsed / EXPECTED_WAKE_MS) * 100));
  return (
    <div className="login">
      <div className="card wake" role="status" aria-live="polite">
        <h1>Joyería Yamesi</h1>
        {state === 'waking' ? (
          <>
            <p>Iniciando el entorno público de demostración. El hosting gratuito puede necesitar un momento para activarse.</p>
            <p className="muted">Starting the public demo environment. Free hosting may need a short moment to wake up.</p>
            <div className="wake-bar" aria-label={`Progreso ${progress} %`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="hint">{Math.round(elapsed / 1000)} s</p>
          </>
        ) : (
          <>
            <p className="alert error">El entorno de demostración no respondió a tiempo. Puede que el servicio gratuito esté reiniciándose.</p>
            <button type="button" className="btn-gold" onClick={() => wake()}>
              Reintentar
            </button>
          </>
        )}
        <p className="hint">
          Mientras tanto: <a href={LINKS.caseStudy}>caso de estudio</a> · <a href={LINKS.source}>código en GitHub</a>
        </p>
      </div>
    </div>
  );
}

/** One discreet line on every screen of the public demo. */
export function DemoNotice() {
  if (!IS_PUBLIC_DEMO) return null;
  return (
    <p className="demo-notice">
      Demostración pública con datos sintéticos · Las facturas son solo de demostración: no se transmiten ni validan ante la DIAN ·{' '}
      <a href={LINKS.caseStudy}>Caso de estudio</a> · <a href={LINKS.source}>Código</a> · <a href={LINKS.architecture}>Arquitectura de la demo</a>
    </p>
  );
}
