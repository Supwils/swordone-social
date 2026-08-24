import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import s from './RouteGuards.module.css';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/** Function component so the class boundary can use the i18n hook. */
function DefaultFallback({ error }: { error: Error }) {
  const { t } = useTranslation();
  return (
    <div className={s.error} role="alert">
      <div className={s.errorInner}>
        <h2 className={s.errorTitle}>{t('common.errorTitle')}</h2>
        <p>{t('common.errorDesc')}</p>
        <pre className={s.errorDetail}>{error.message}</pre>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // The one console call the repo keeps: a boundary that swallows the error
    // silently makes a white screen unreportable.
    console.error('[ErrorBoundary]', error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <DefaultFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
