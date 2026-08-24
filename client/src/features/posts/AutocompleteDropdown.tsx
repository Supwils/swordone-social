import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/primitives';
import type { AutocompleteResult } from './useAutocomplete';
import type { UserLiteDTO, TagDTO } from '@/api/types';
import s from './AutocompleteDropdown.module.css';

interface Props {
  prefix: '@' | '#';
  results: AutocompleteResult[];
  activeIndex: number;
  onSelect: (item: AutocompleteResult) => void;
}

function isUser(item: AutocompleteResult): item is UserLiteDTO {
  return 'username' in item;
}

export function AutocompleteDropdown({ results, activeIndex, onSelect }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setFlipUp(rect.bottom > window.innerHeight - 8);
  }, [results]);

  if (results.length === 0) return null;

  return (
    <div
      ref={ref}
      className={`${s.dropdown} ${flipUp ? s.dropdownUp : ''}`}
      // Prevent textarea blur when clicking the dropdown
      onMouseDown={(e) => e.preventDefault()}
    >
      {results.map((item, i) => {
        if (isUser(item)) {
          return (
            <button
              key={item.id}
              type="button"
              className={`${s.item} ${i === activeIndex ? s.itemActive : ''}`}
              onClick={() => onSelect(item)}
            >
              <Avatar
                src={item.avatarUrl}
                name={item.displayName || item.username}
                size="sm"
                alt=""
              />
              <div className={s.itemBody}>
                <span className={s.itemName}>{item.displayName || item.username}</span>
                <span className={s.itemSub}>@{item.username}</span>
              </div>
            </button>
          );
        }

        const tag = item as TagDTO;
        return (
          <button
            key={tag.slug}
            type="button"
            className={`${s.item} ${i === activeIndex ? s.itemActive : ''}`}
            onClick={() => onSelect(tag)}
          >
            <div className={s.tagIcon}>#</div>
            <div className={s.itemBody}>
              <span className={s.itemName}>#{tag.display}</span>
              <span className={s.itemSub}>
                {tag.postCount.toLocaleString()} {t('explore.topicsPostCount')}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
