import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X, Eye, EyeSlash } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import * as usersApi from '@/api/users.api';
import * as authApi from '@/api/auth.api';
import { PRESET_TAGS } from '@/lib/tagPresets';
import { MyAgentsSection } from '@/features/agents/MyAgentsSection';
import { useSession } from '@/stores/session.store';
import { useUI, type ThemePreference, type LanguagePreference } from '@/stores/ui.store';
import { useSetLanguage } from '@/lib/useSetLanguage';
import type { ApiError } from '@/api/types';
import { Avatar, Button, Card, Input, Textarea } from '@/components/primitives';
import s from './settings.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

const TAGS_PER_CATEGORY_DEFAULT = 8;

export default function SettingsRoute() {
  const { t } = useTranslation();
  usePageTitle(t('nav.settings'));
  const user = useSession((st) => st.user);
  const setUser = useSession((st) => st.setUser);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [headline, setHeadline] = useState('');
  const [profileTags, setProfileTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const toggleCategoryExpand = useCallback((cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Seed the form ONCE PER ACCOUNT, not on every change to the user object.
  // `avatar.onSuccess` republishes `{ ...user, avatarUrl }`, so an effect that
  // reseeded whenever `user` changed identity threw away whatever the person
  // had typed but not yet saved, silently, mid-edit.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!user || seededFor.current === user.id) return;
    seededFor.current = user.id;
    setDisplayName(user.displayName || '');
    setBio(user.bio || '');
    setHeadline(user.headline || '');
    setProfileTags(user.profileTags ?? []);
  }, [user]);

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag || profileTags.length >= 10 || profileTags.includes(tag)) return;
    setProfileTags((prev) => [...prev, tag]);
    setTagInput('');
  };

  const removeTag = (tag: string) => setProfileTags((prev) => prev.filter((t) => t !== tag));

  const handleTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
    }
  };

  const saveProfile = useMutation({
    mutationFn: () => usersApi.updateMe({ displayName, bio, headline, profileTags }),
    onSuccess: (updated) => {
      setUser(updated);
      toast.success(t('settings.profile.saved'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const avatar = useMutation({
    mutationFn: (file: File) => usersApi.updateAvatar(file),
    onSuccess: (url) => {
      if (user) setUser({ ...user, avatarUrl: url });
      toast.success(t('settings.avatar.updated'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const [showCurrentPwd, setShowCurrentPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);

  const pwdSchema = z
    .object({
      currentPassword: z.string().min(1, t('auth.fieldRequired')),
      newPassword: z.string().min(8, t('auth.passwordMin')),
      confirmPassword: z.string().min(1, t('auth.fieldRequired')),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
      message: t('settings.password.mismatch'),
      path: ['confirmPassword'],
    });
  type PwdFields = z.infer<typeof pwdSchema>;

  const pwdForm = useForm<PwdFields>({ resolver: zodResolver(pwdSchema) });

  const changePwd = useMutation({
    mutationFn: (data: PwdFields) =>
      authApi.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      }),
    onSuccess: () => {
      pwdForm.reset();
      setShowCurrentPwd(false);
      setShowNewPwd(false);
      setShowConfirmPwd(false);
      toast.success(t('settings.password.changed'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const theme = useUI((st) => st.theme);
  const setTheme = useUI((st) => st.setTheme);
  const language = useUI((st) => st.language);
  const changeLanguage = useSetLanguage();

  const changeTheme = (val: ThemePreference) => {
    setTheme(val);
    usersApi.updateMe({ preferences: { theme: val } }).catch(() => {});
  };

  const qc = useQueryClient();
  const autoTranslate = user?.preferences?.autoTranslate !== false;
  const changeAutoTranslate = async (on: boolean) => {
    const updated = await usersApi
      .updateMe({ preferences: { autoTranslate: on } })
      .catch(() => null);
    if (!updated) return;
    setUser(updated);
    // Bodies are translated on read, so every cached page is now the wrong shape.
    void qc.invalidateQueries({ queryKey: ['feed'] });
    void qc.invalidateQueries({ queryKey: ['posts'] });
  };

  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!user) return null;

  return (
    <div className={s.page}>
      <h1 className={s.title}>{t('settings.title')}</h1>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>{t('settings.profile.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.profile.desc')}</p>
        </header>
        <form
          className={s.form}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            saveProfile.mutate();
          }}
        >
          <Input
            label={t('settings.profile.displayName')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Input
            label={t('settings.profile.headline')}
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            maxLength={80}
            hint={t('settings.profile.headlineHint')}
          />
          <Textarea
            label={t('settings.profile.bio')}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={280}
            showCounter
            autoResize
          />

          <div className={s.tagsSection}>
            <label className={s.tagsLabel}>{t('settings.profile.tags')}</label>
            <p className={s.tagsHint}>{t('settings.profile.tagsHint')}</p>
            {profileTags.length > 0 && (
              <div className={s.tagsList}>
                {profileTags.map((tag) => (
                  <span key={tag} className={s.tagChip}>
                    {t(`tags.labels.${tag}`, tag)}
                    <button
                      type="button"
                      className={s.tagRemove}
                      onClick={() => removeTag(tag)}
                      aria-label={`Remove ${tag}`}
                    >
                      <X size={12} weight="bold" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              className={s.tagInput}
              type="text"
              placeholder={
                profileTags.length >= 10
                  ? t('settings.profile.maxTags')
                  : t('settings.profile.addTag')
              }
              value={tagInput}
              maxLength={30}
              disabled={profileTags.length >= 10}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={() => addTag(tagInput)}
            />
            <div className={s.tagCategories}>
              {Object.entries(PRESET_TAGS).map(([catKey, slugs]) => {
                const available = slugs.filter((slug) => !profileTags.includes(slug));
                if (available.length === 0) return null;
                const isExpanded = expandedCategories.has(catKey);
                const shown = isExpanded
                  ? available
                  : available.slice(0, TAGS_PER_CATEGORY_DEFAULT);
                return (
                  <div key={catKey} className={s.tagCategory}>
                    <span className={s.tagCategoryLabel}>{t(`tags.categories.${catKey}`)}</span>
                    <div className={s.tagSuggestions}>
                      {shown.map((slug) => (
                        <button
                          key={slug}
                          type="button"
                          className={s.tagSuggestion}
                          onClick={() => addTag(slug)}
                          disabled={profileTags.length >= 10}
                        >
                          {t(`tags.labels.${slug}`, slug)}
                        </button>
                      ))}
                      {available.length > TAGS_PER_CATEGORY_DEFAULT && (
                        <button
                          type="button"
                          className={s.tagSuggestionMore}
                          onClick={() => toggleCategoryExpand(catKey)}
                        >
                          {isExpanded
                            ? t('tags.showLess')
                            : `+${available.length - TAGS_PER_CATEGORY_DEFAULT} ${t('tags.showMore')}`}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={s.formActions}>
            <Button variant="primary" type="submit" disabled={saveProfile.isPending}>
              {saveProfile.isPending ? t('settings.profile.saving') : t('settings.profile.save')}
            </Button>
          </div>
        </form>
      </Card>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>{t('settings.avatar.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.avatar.desc')}</p>
        </header>
        <div className={s.avatarRow}>
          <Avatar src={user.avatarUrl} name={user.displayName || user.username} size="lg" alt="" />
          <Button
            variant="subtle"
            onClick={() => fileRef.current?.click()}
            disabled={avatar.isPending}
          >
            {avatar.isPending ? t('settings.avatar.uploading') : t('settings.avatar.upload')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className={s.hiddenInput}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) avatar.mutate(f);
              e.target.value = '';
            }}
          />
        </div>
      </Card>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>{t('settings.password.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.password.desc')}</p>
        </header>
        <form className={s.form} onSubmit={pwdForm.handleSubmit((data) => changePwd.mutate(data))}>
          <Input
            label={t('settings.password.current')}
            type={showCurrentPwd ? 'text' : 'password'}
            autoComplete="current-password"
            error={pwdForm.formState.errors.currentPassword?.message}
            trailing={
              <button
                type="button"
                className={s.eyeBtn}
                onClick={() => setShowCurrentPwd((v) => !v)}
                aria-label={
                  showCurrentPwd ? t('settings.password.hide') : t('settings.password.show')
                }
              >
                {showCurrentPwd ? (
                  <EyeSlash size={16} weight="regular" aria-hidden />
                ) : (
                  <Eye size={16} weight="regular" aria-hidden />
                )}
              </button>
            }
            {...pwdForm.register('currentPassword')}
          />
          <Input
            label={t('settings.password.new')}
            type={showNewPwd ? 'text' : 'password'}
            autoComplete="new-password"
            hint={t('settings.password.newHint')}
            error={pwdForm.formState.errors.newPassword?.message}
            trailing={
              <button
                type="button"
                className={s.eyeBtn}
                onClick={() => setShowNewPwd((v) => !v)}
                aria-label={showNewPwd ? t('settings.password.hide') : t('settings.password.show')}
              >
                {showNewPwd ? (
                  <EyeSlash size={16} weight="regular" aria-hidden />
                ) : (
                  <Eye size={16} weight="regular" aria-hidden />
                )}
              </button>
            }
            {...pwdForm.register('newPassword')}
          />
          <Input
            label={t('settings.password.confirm')}
            type={showConfirmPwd ? 'text' : 'password'}
            autoComplete="new-password"
            error={pwdForm.formState.errors.confirmPassword?.message}
            trailing={
              <button
                type="button"
                className={s.eyeBtn}
                onClick={() => setShowConfirmPwd((v) => !v)}
                aria-label={
                  showConfirmPwd ? t('settings.password.hide') : t('settings.password.show')
                }
              >
                {showConfirmPwd ? (
                  <EyeSlash size={16} weight="regular" aria-hidden />
                ) : (
                  <Eye size={16} weight="regular" aria-hidden />
                )}
              </button>
            }
            {...pwdForm.register('confirmPassword')}
          />
          <div className={s.formActions}>
            <Button
              variant="primary"
              type="submit"
              disabled={changePwd.isPending || pwdForm.formState.isSubmitting}
            >
              {changePwd.isPending
                ? t('settings.password.changing')
                : t('settings.password.change')}
            </Button>
          </div>
        </form>
      </Card>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>{t('settings.appearance.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.appearance.desc')}</p>
        </header>
        <p className={s.appearanceLabel}>{t('settings.appearance.theme')}</p>
        <div className={s.themeToggle}>
          {(['system', 'light', 'dark'] as ThemePreference[]).map((themeVal) => (
            <button
              key={themeVal}
              type="button"
              className={`${s.themeBtn} ${theme === themeVal ? s.themeBtnActive : ''}`}
              onClick={() => changeTheme(themeVal)}
            >
              {themeVal === 'system'
                ? t('settings.appearance.themeSystem')
                : themeVal === 'light'
                  ? t('settings.appearance.themeLight')
                  : t('settings.appearance.themeDark')}
            </button>
          ))}
        </div>
        <p className={s.appearanceLabel}>{t('settings.appearance.language')}</p>
        <div className={s.themeToggle}>
          {(['en', 'zh'] as LanguagePreference[]).map((lang) => (
            <button
              key={lang}
              type="button"
              className={`${s.themeBtn} ${language === lang ? s.themeBtnActive : ''}`}
              onClick={() => changeLanguage(lang)}
            >
              {lang === 'en'
                ? t('settings.appearance.languageEn')
                : t('settings.appearance.languageZh')}
            </button>
          ))}
        </div>
        <p className={s.appearanceLabel}>{t('settings.appearance.autoTranslate')}</p>
        <p className={s.sectionDesc}>{t('settings.appearance.autoTranslateDesc')}</p>
        <div
          className={s.themeToggle}
          role="group"
          aria-label={t('settings.appearance.autoTranslate')}
        >
          {[true, false].map((on) => (
            <button
              key={String(on)}
              type="button"
              className={`${s.themeBtn} ${autoTranslate === on ? s.themeBtnActive : ''}`}
              aria-pressed={autoTranslate === on}
              onClick={() => changeAutoTranslate(on)}
            >
              {on
                ? t('settings.appearance.autoTranslateOn')
                : t('settings.appearance.autoTranslateOff')}
            </button>
          ))}
        </div>
      </Card>

      {!user.isAgent && (
        <Card as="section" className={s.section}>
          <header className={s.sectionHeader}>
            <h2 className={s.sectionTitle}>{t('settings.agents.title')}</h2>
            <p className={s.sectionDesc}>{t('settings.agents.desc')}</p>
          </header>
          <MyAgentsSection />
        </Card>
      )}
    </div>
  );
}
