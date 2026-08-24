import { useState, useEffect, useId, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Globe } from '@phosphor-icons/react';
import * as authApi from '@/api/auth.api';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { qk } from '@/api/queryKeys';
import type { ApiError } from '@/api/types';
import { Button, Input } from '@/components/primitives';
import s from './auth.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

type Panel = 'login' | 'register';

function LangToggle() {
  const { t } = useTranslation();
  const language = useUI((st) => st.language);
  const setLanguage = useUI((st) => st.setLanguage);
  const next = language === 'zh' ? 'en' : 'zh';
  const label = language === 'zh' ? 'EN' : '中文';

  return (
    <button
      type="button"
      className={s.langToggle}
      onClick={() => setLanguage(next)}
      aria-label={t('settings.appearance.language')}
      title={t('settings.appearance.language')}
    >
      <Globe size={14} weight="regular" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

export default function AuthPage() {
  const { t } = useTranslation();
  const loc = useLocation();
  const [panel, setPanel] = useState<Panel>(loc.pathname === '/register' ? 'register' : 'login');
  usePageTitle(panel === 'register' ? t('auth.createAccount') : t('auth.signIn'));

  useEffect(() => {
    setPanel(loc.pathname === '/register' ? 'register' : 'login');
  }, [loc.pathname]);

  return (
    <div className={s.page}>
      <LangToggle />
      <div className={`${s.container} ${panel === 'register' ? s.active : ''}`}>
        <div className={s.mobileTabs}>
          <button
            className={`${s.mobileTab} ${panel === 'login' ? s.mobileTabActive : ''}`}
            onClick={() => setPanel('login')}
          >
            {t('auth.signIn')}
          </button>
          <button
            className={`${s.mobileTab} ${panel === 'register' ? s.mobileTabActive : ''}`}
            onClick={() => setPanel('register')}
          >
            {t('auth.createAccount')}
          </button>
        </div>

        <LoginPanel />
        <RegisterPanel />

        <div className={s.toggleContainer}>
          <div className={s.toggle}>
            <div className={`${s.togglePanel} ${s.toggleLeft}`}>
              <p className={s.toggleSub}>{t('auth.alreadyHaveAccount')}</p>
              <h2 className={s.toggleHeading}>{t('auth.welcomeBack')}</h2>
              <button className={s.toggleBtn} onClick={() => setPanel('login')}>
                {t('auth.signIn')}
              </button>
            </div>
            <div className={`${s.togglePanel} ${s.toggleRight}`}>
              <p className={s.toggleSub}>{t('auth.newToSwil')}</p>
              <h2 className={s.toggleHeading}>{t('auth.quieterSpace')}</h2>
              <button className={s.toggleBtn} onClick={() => setPanel('register')}>
                {t('auth.createAccount')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Login ─── */

const loginSchema = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
});
type LoginFields = z.infer<typeof loginSchema>;

function LoginPanel() {
  const { t } = useTranslation();
  const [globalError, setGlobalError] = useState<string | null>(null);
  const setUser = useSession((st) => st.setUser);
  const nav = useNavigate();
  const qc = useQueryClient();
  const loc = useLocation();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFields>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginFields) => {
    setGlobalError(null);
    try {
      const user = await authApi.login({
        usernameOrEmail: data.usernameOrEmail,
        password: data.password,
      });
      qc.clear();
      setUser(user);
      qc.setQueryData(qk.auth.me, user);
      toast.success(`Welcome back, ${user.usernameDisplay}`);
      const dest = (loc.state as { from?: string } | null)?.from ?? '/feed';
      nav(dest);
    } catch (err) {
      const e = err as unknown as ApiError;
      setGlobalError(e.message ?? 'Login failed');
    }
  };

  return (
    <div className={`${s.formContainer} ${s.signIn}`}>
      <div className={s.brand}>SwordOne</div>
      <Link to="/" className={s.showcaseLink}>
        {t('auth.browseCommunity')}
      </Link>
      <h1 className={s.title}>{t('auth.signIn')}</h1>

      <form onSubmit={handleSubmit(onSubmit)} className={s.form} noValidate>
        <Input
          label={t('auth.usernameOrEmail')}
          autoComplete="username"
          error={errors.usernameOrEmail ? t('auth.fieldRequired') : undefined}
          {...register('usernameOrEmail')}
        />
        <Input
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          error={errors.password ? t('auth.fieldRequired') : undefined}
          {...register('password')}
        />
        {globalError && (
          <div className={s.errorBanner} role="alert">
            {globalError}
          </div>
        )}
        <Button variant="primary" type="submit" disabled={isSubmitting} fullWidth>
          {isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </form>
    </div>
  );
}

/* ─── Register ─── */

const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'auth.usernameMin')
    .max(24, 'auth.usernameMax')
    .regex(/^[a-zA-Z0-9_]+$/, 'auth.usernamePattern'),
  displayName: z.string().max(50).optional(),
  email: z.string().email('auth.emailInvalid'),
  password: z.string().min(8, 'auth.passwordMin'),
});
type RegisterFields = z.infer<typeof registerSchema>;

function RegisterPanel() {
  const { t } = useTranslation();
  const [globalError, setGlobalError] = useState<string | null>(null);
  const setUser = useSession((st) => st.setUser);
  const nav = useNavigate();
  const qc = useQueryClient();

  // Anti-bot: track when the form was first rendered
  const formMountedAt = useRef(Date.now());

  // Anti-bot: honeypot field (hidden from real users, bots fill it in)
  const [honeypot, setHoneypot] = useState('');

  // Anti-bot: simple arithmetic challenge
  const [challengeA] = useState(() => Math.floor(Math.random() * 9) + 1);
  const [challengeB] = useState(() => Math.floor(Math.random() * 9) + 1);
  const [challengeAnswer, setChallengeAnswer] = useState('');
  const [challengeError, setChallengeError] = useState<string | null>(null);
  // The challenge is a bare <label> + <input> pair, not the `Input` primitive,
  // so it has to wire up its own label/error association.
  const challengeId = useId();
  const challengeErrorId = `${challengeId}-error`;

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFields>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = async (data: RegisterFields) => {
    setGlobalError(null);
    setChallengeError(null);

    // Silently drop if honeypot was filled (bot behavior)
    if (honeypot.trim() !== '') return;

    // Reject submissions faster than a human can fill the form
    if (Date.now() - formMountedAt.current < 3000) {
      setGlobalError(t('auth.tooFast'));
      return;
    }

    // Simple math challenge
    if (parseInt(challengeAnswer, 10) !== challengeA + challengeB) {
      setChallengeError(t('auth.challengeFailed'));
      return;
    }

    try {
      const user = await authApi.register({
        username: data.username,
        email: data.email,
        password: data.password,
        displayName: data.displayName ?? '',
      });
      setUser(user);
      qc.setQueryData(qk.auth.me, user);
      toast.success(`Welcome, ${user.usernameDisplay}`);
      nav('/feed');
    } catch (err) {
      const e = err as unknown as ApiError;
      setGlobalError(e.message ?? 'Registration failed');
      if (e.fields) {
        Object.entries(e.fields).forEach(([field, message]) => {
          setError(field as keyof RegisterFields, { message: message as string });
        });
      }
    }
  };

  return (
    <div className={`${s.formContainer} ${s.signUp}`}>
      <div className={s.brand}>SwordOne</div>
      <Link to="/" className={s.showcaseLink}>
        {t('auth.browseCommunity')}
      </Link>
      <h1 className={s.title}>{t('auth.createAccount')}</h1>

      <form onSubmit={handleSubmit(onSubmit)} className={s.form} noValidate>
        {/* Honeypot: positioned off-screen, invisible to real users */}
        <input
          type="text"
          name="website"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          className={s.honeypot}
          tabIndex={-1}
          aria-hidden="true"
          autoComplete="off"
        />
        <Input
          label={t('auth.username')}
          hint={t('auth.usernameHint')}
          error={errors.username ? t(errors.username.message ?? 'auth.usernameHint') : undefined}
          autoComplete="username"
          {...register('username')}
        />
        <Input
          label={t('auth.displayName')}
          hint={t('auth.displayNameHint')}
          error={errors.displayName?.message}
          autoComplete="name"
          {...register('displayName')}
        />
        <Input
          label={t('auth.email')}
          type="email"
          error={errors.email ? t(errors.email.message ?? 'auth.emailInvalid') : undefined}
          autoComplete="email"
          {...register('email')}
        />
        <Input
          label={t('auth.password')}
          type="password"
          hint={t('auth.passwordHint')}
          error={errors.password ? t(errors.password.message ?? 'auth.passwordMin') : undefined}
          autoComplete="new-password"
          {...register('password')}
        />
        <div className={s.challenge}>
          <label htmlFor={challengeId} className={s.challengeLabel}>
            {t('auth.challenge', { a: challengeA, b: challengeB })}
          </label>
          <input
            id={challengeId}
            type="number"
            inputMode="numeric"
            value={challengeAnswer}
            onChange={(e) => setChallengeAnswer(e.target.value)}
            placeholder={t('auth.challengePlaceholder')}
            className={s.challengeInput}
            autoComplete="off"
            aria-invalid={challengeError ? true : undefined}
            aria-describedby={challengeError ? challengeErrorId : undefined}
          />
          {challengeError && (
            <p id={challengeErrorId} className={s.challengeError} role="alert">
              {challengeError}
            </p>
          )}
        </div>
        {globalError && (
          <div className={s.errorBanner} role="alert">
            {globalError}
          </div>
        )}
        <Button variant="primary" type="submit" disabled={isSubmitting} fullWidth>
          {isSubmitting ? t('auth.creating') : t('auth.createAccount')}
        </Button>
      </form>
    </div>
  );
}
