import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { RouteError } from './components/RouteError';
import { Spinner } from './components/ui';
// Self-hosted fonts: no request to Google, so no visitor IPs shared and no outside dependency.
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';
import { ApiError, isUnavailable } from './lib/api';
import { SessionProvider, useSession } from './lib/session';
import { SignInPage, SignUpPage } from './pages/Auth';
import { NotFoundPage } from './pages/NotFound';

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A sleeping or waking server is worth a few more tries; a real answer (404, 409…) isn't.
      retry: (failures, e) => (isUnavailable(e) ? failures < 3 : failures < 1),
      refetchOnWindowFocus: false,
    },
  },
  // A session that expired mid-visit: re-check who's signed in, so the app shows sign-in instead of
  // "Please sign in" on every panel.
  queryCache: new QueryCache({ onError: (e, q) => onUnauthorized(e, q.queryKey[0]) }),
  mutationCache: new MutationCache({ onError: (e) => onUnauthorized(e, null) }),
});

function onUnauthorized(e: unknown, key: unknown) {
  if (e instanceof ApiError && e.status === 401 && key !== 'me' && queryClient.getQueryData(['me'])) void queryClient.invalidateQueries({ queryKey: ['me'] });
}

/** A screen whose code loads when it's first opened. */
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => async () => ({ Component: (await load())[name] });

function Home() {
  const { user } = useSession();
  if (!user) return <Spinner />;
  const target = { publisher: '/dashboard', admin: '/dashboard', buyer: '/store', contributor: '/sources' }[user.role];
  return <Navigate to={target} replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <SignInPage />, errorElement: <RouteError /> },
  { path: '/signup', element: <SignUpPage />, errorElement: <RouteError /> },
  { path: '/privacy', lazy: async () => ({ Component: (await import('./pages/Legal')).PrivacyPage }), errorElement: <RouteError /> },
  { path: '/terms', lazy: async () => ({ Component: (await import('./pages/Legal')).TermsPage }), errorElement: <RouteError /> },
  {
    element: <Layout />,
    // Shown while a lazily loaded screen's code arrives on first load.
    hydrateFallbackElement: <Spinner />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home /> },
      { path: 'dashboard', lazy: page(() => import('./pages/Dashboard'), 'DashboardPage') },
      { path: 'registry', lazy: async () => ({ Component: (await import('./pages/Registry')).RegistryPage }) },
      { path: 'studio', lazy: page(() => import('./pages/Studio'), 'StudioPage') },
      { path: 'reports', lazy: page(() => import('./pages/Reports'), 'ReportsPage') },
      { path: 'reports/:id', lazy: page(() => import('./pages/ArtifactPage'), 'ArtifactPage') },
      { path: 'reports/:id/provenance', lazy: async () => ({ Component: (await import('./pages/Provenance')).ProvenancePage }) },
      { path: 'reports/:id/receipt', lazy: page(() => import('./pages/Receipt'), 'ReceiptPage') },
      { path: 'settlements', lazy: async () => ({ Component: (await import('./pages/Settlements')).SettlementsPage }) },
      { path: 'royalties', lazy: async () => ({ Component: (await import('./pages/Royalties')).RoyaltiesPage }) },
      { path: 'ask', lazy: async () => ({ Component: (await import('./pages/Ask')).AskPage }) },
      { path: 'assistant', lazy: async () => ({ Component: (await import('./pages/Shopper')).ShopperPage }) },
      { path: 'store', lazy: page(() => import('./pages/Store'), 'StorePage') },
      { path: 'store/:id', lazy: page(() => import('./pages/Store'), 'StoreItemPage') },
      { path: 'checkout/return', lazy: page(() => import('./pages/CheckoutReturn'), 'CheckoutReturnPage') },
      { path: 'checkout/cancel', lazy: async () => { const { CheckoutReturnPage } = await import('./pages/CheckoutReturn'); return { Component: () => <CheckoutReturnPage cancelled /> }; } },
      { path: 'earnings', lazy: page(() => import('./pages/Earnings'), 'EarningsPage') },
      { path: 'sources', lazy: page(() => import('./pages/Sources'), 'MySourcesPage') },
      { path: 'sources/new', lazy: page(() => import('./pages/Sources'), 'NewSourcePage') },
      { path: 'sources/:id/offer', lazy: page(() => import('./pages/Sources'), 'OfferLicensePage') },
      { path: 'sources/:id/version', lazy: page(() => import('./pages/Sources'), 'NewVersionPage') },
      { path: 'profile', lazy: page(() => import('./pages/Sources'), 'ProfilePage') },
      { path: 'developers', lazy: async () => ({ Component: (await import('./pages/Developers')).DevelopersPage }) },
      { path: 'developers/api', lazy: async () => ({ Component: (await import('./pages/ApiReference')).ApiReferencePage }) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
