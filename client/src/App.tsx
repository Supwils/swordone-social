import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AuthBootstrap } from '@/components/AuthBootstrap';
import { RealtimeBridge } from '@/components/RealtimeBridge';
import { AppShell } from '@/components/layout/AppShell';
import { OpenRoute, PublicRoute, RequireAuth } from '@/components/RouteGuards';
import { Spinner } from '@/components/primitives';
import { useSession } from '@/stores/session.store';

const LoginRoute = lazy(() => import('@/routes/login'));
const RegisterRoute = lazy(() => import('@/routes/register'));
const FeedFollowingRoute = lazy(() => import('@/routes/feedFollowing'));
const FeedGlobalRoute = lazy(() => import('@/routes/feedGlobal'));
const FeedTagRoute = lazy(() => import('@/routes/feedTag'));
const FeedBoardRoute = lazy(() => import('@/routes/feedBoard'));
const UserRoute = lazy(() => import('@/routes/user'));
const PostRoute = lazy(() => import('@/routes/post'));
const SettingsRoute = lazy(() => import('@/routes/settings'));
const NotificationsRoute = lazy(() => import('@/routes/notifications'));
const MessagesRoute = lazy(() => import('@/routes/messages'));
const ConversationRoute = lazy(() => import('@/routes/conversation'));
const ExploreRoute = lazy(() => import('@/routes/explore'));
const BookmarksRoute = lazy(() => import('@/routes/bookmarks'));
const LabRoute = lazy(() => import('@/routes/lab'));
const LabV1Route = lazy(() => import('@/routes/lab/v1'));
const NotFoundRoute = lazy(() => import('@/routes/notFound'));
const ShowcaseRoute = lazy(() => import('@/routes/showcase'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error: unknown) => {
        const status = (error as { status?: number })?.status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <Spinner />
    </div>
  );
}

function RootDispatch() {
  const bootstrap = useSession((st) => st.bootstrap);
  const user = useSession((st) => st.user);
  if (bootstrap === 'pending') return <RouteFallback />;
  if (user) return <Navigate to="/feed" replace />;
  return <ShowcaseRoute />;
}

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthBootstrap />
          <RealtimeBridge />
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: 'var(--color-surface)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
                fontFamily: 'var(--font-sans)',
              },
            }}
          />
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<RootDispatch />} />
              <Route path="/showcase" element={<Navigate to="/" replace />} />

              <Route
                path="/login"
                element={
                  <PublicRoute>
                    <LoginRoute />
                  </PublicRoute>
                }
              />
              <Route
                path="/register"
                element={
                  <PublicRoute>
                    <RegisterRoute />
                  </PublicRoute>
                }
              />

              {/*
                Open surfaces: readable without an account. The observation lab
                is the point of this project, so a drift trajectory that demands
                a login is not a result anyone can check. The matching server
                routes use `optionalUser`, so anonymous requests get public
                content and signed-in ones get the personalised view.
              */}
              <Route
                element={
                  <OpenRoute>
                    <AppShell />
                  </OpenRoute>
                }
              >
                <Route path="global" element={<FeedGlobalRoute />} />
                <Route path="tag/:slug" element={<FeedTagRoute />} />
                <Route path="board/:slug" element={<FeedBoardRoute />} />
                <Route path="u/:username" element={<UserRoute />} />
                <Route path="p/:id" element={<PostRoute />} />
                <Route path="explore" element={<ExploreRoute />} />
                <Route
                  path="explore/people"
                  element={<Navigate to="/explore?tab=people" replace />}
                />
                <Route path="lab" element={<LabRoute />} />
                <Route path="lab/v1" element={<LabV1Route />} />

                {/* Personal surfaces: meaningless without an identity. Nested
                    under the same layout so the shell never remounts when a
                    visitor moves between open and personal pages. */}
                <Route element={<RequireAuth />}>
                  <Route path="feed" element={<FeedFollowingRoute />} />
                  <Route path="settings" element={<SettingsRoute />} />
                  <Route path="notifications" element={<NotificationsRoute />} />
                  <Route path="messages" element={<MessagesRoute />} />
                  <Route path="messages/:id" element={<ConversationRoute />} />
                  <Route path="bookmarks" element={<BookmarksRoute />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFoundRoute />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
