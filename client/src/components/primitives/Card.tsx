import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';
import s from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  as?: 'div' | 'section' | 'article';
  padding?: 'default' | 'flush';
  hoverable?: boolean;
  children?: ReactNode;
}

export function Card({
  as: Tag = 'div',
  padding = 'default',
  hoverable,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={clsx(s.card, padding === 'flush' && s.flush, hoverable && s.hoverable, className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
