// Settings of the public demo build. All of them are public by design: never put a secret in a VITE_ variable.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
export const IS_PUBLIC_DEMO = import.meta.env.VITE_PUBLIC_DEMO === 'true';
// Password of the synthetic demo users only, shown on the sign-in screen.
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD ?? '';

export const LINKS = {
  caseStudy: 'https://vzuliani97.github.io/work/yamesi/',
  source: 'https://github.com/vzuliani97/yamesi',
  architecture: 'https://github.com/vzuliani97/yamesi/blob/main/docs/PUBLIC_DEMO_DEPLOYMENT.md',
};
