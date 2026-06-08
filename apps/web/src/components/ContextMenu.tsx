import { useEffect, useRef } from 'react';

export type ContextMenuAction = {
  label: string;
  danger?: boolean;
  onClick: () => void;
};

export type ContextMenuSeparator = { separator: true };

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="sidebar-context-menu"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        'separator' in item ? (
          <div key={`sep-${index}`} className="context-menu-separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            className={item.danger ? 'danger-item' : undefined}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
