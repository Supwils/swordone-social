import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import s from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  /**
   * Keep the title for assistive tech but do not paint it — for dialogs whose
   * body is self-explanatory (composer, lightbox, post preview). Every dialog
   * still needs a `title`: Radix logs a console error for a Content without a
   * Title, and a screen reader announces an untitled dialog as just "dialog".
   */
  titleHidden?: boolean;
  description?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}

/**
 * Accessible modal dialog. Focus is trapped inside and restored to the
 * previously focused element on close. Esc and overlay click dismiss.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  titleHidden,
  description,
  children,
  contentClassName,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={s.overlay} />
        <RadixDialog.Content
          className={clsx(s.content, contentClassName)}
          // Radix wires `aria-describedby` to its Description id by default and
          // warns when that element never renders. Clearing it when there is
          // no description keeps the dialog's accessible description honest
          // and the console quiet.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          {title && (
            <RadixDialog.Title className={titleHidden ? s.srOnly : s.title}>
              {title}
            </RadixDialog.Title>
          )}
          {description && (
            <RadixDialog.Description className={s.description}>
              {description}
            </RadixDialog.Description>
          )}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={s.actions}>{children}</div>;
}
