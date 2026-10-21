import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { RouteError } from './components/RouteError';
import { Spinner } from './components/ui';
import './index.css';
import { SessionProvider, useSession } from './lib/session';
import { ArtifactPage } from './pages/ArtifactPage';
import { SignInPage, SignUpPage } from './pages/Auth';
import { CheckoutReturnPage } from './pages/CheckoutReturn';
import { DashboardPage } from './pages/Dashboard';
import { EarningsPage } from './pages/Earnings';
import { ReceiptPage } from './pages/Receipt';
import { ReportsPage } from './pages/Reports';
import { StorePage, StoreItemPage } from './pages/Store';
import { MySourcesPage, NewSourcePage, NewVersionPage, OfferLicensePage, ProfilePage } from './pages/Sources';
import { StudioPage } from './pages/Studio';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Home() {
  const { user } = useSession();
  if (!user) return <Spinner />;
  const target = { publisher: '/dashboard', admin: '/dashboard', buyer: '/store', contributor: '/sources' }[user.role];
  return <Navigate to={target} replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <SignInPage />, errorElement: <RouteError /> },
  { path: '/signup', element: <SignUpPage />, errorElement: <RouteError /> },
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'registry', lazy: async () => ({ Component: (await import('./pages/Registry')).RegistryPage }) },
      { path: 'studio', element: <StudioPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'reports/:id', element: <ArtifactPage /> },
      { path: 'reports/:id/provenance', lazy: async () => ({ Component: (await import('./pages/Provenance')).ProvenancePage }) },
      { path: 'reports/:id/receipt', element: <ReceiptPage /> },
      { path: 'settlements', lazy: async () => ({ Component: (await import('./pages/Settlements')).SettlementsPage }) },
      { path: 'store', element: <StorePage /> },
      { path: 'store/:id', element: <StoreItemPage /> },
      { path: 'checkout/return', element: <CheckoutReturnPage /> },
      { path: 'checkout/cancel', element: <CheckoutReturnPage cancelled /> },
      { path: 'earnings', element: <EarningsPage /> },
      { path: 'sources', element: <MySourcesPage /> },
      { path: 'sources/new', element: <NewSourcePage /> },
      { path: 'sources/:id/offer', element: <OfferLicensePage /> },
      { path: 'sources/:id/version', element: <NewVersionPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'developers', lazy: async () => ({ Component: (await import('./pages/Developers')).DevelopersPage }) },
      { path: 'developers/api', lazy: async () => ({ Component: (await import('./pages/ApiReference')).ApiReferencePage }) },
      { path: '*', element: <Navigate to="/" replace /> },
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
