import { useEffect, useRef, useState } from 'react';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  promptMode?: boolean;
  promptPlaceholder?: string;
  promptInitialValue?: string;
  requireMatch?: string;
  onConfirm: (value?: string) => void;
  onCancel: () => void;
};

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element | null {
  const {
    open,
    title,
    message,
    confirmLabel = '确认',
    cancelLabel = '取消',
    danger = false,
    promptMode = false,
    promptPlaceholder,
    promptInitialValue = '',
    requireMatch,
    onConfirm,
    onCancel,
  } = props;

  const [inputValue, setInputValue] = useState(promptInitialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setInputValue(promptInitialValue);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, promptInitialValue]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter' && !promptMode) onConfirm();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onCancel, onConfirm, promptMode]);

  if (!open) return null;

  const canConfirm = promptMode
    ? requireMatch ? inputValue === requireMatch : inputValue.trim().length > 0
    : true;

  function handleConfirm() {
    if (!canConfirm) return;
    onConfirm(promptMode ? inputValue : undefined);
  }

  function handleOverlayClick(event: React.MouseEvent) {
    if (event.target === overlayRef.current) onCancel();
  }

  return (
    <div ref={overlayRef} className="confirm-dialog-overlay" onClick={handleOverlayClick}>
      <div className="confirm-dialog" role="dialog" aria-modal="true">
        <h3 className="confirm-dialog__title">{title}</h3>
        {message ? <p className="confirm-dialog__message">{message}</p> : null}
        {promptMode ? (
          <input
            ref={inputRef}
            type="text"
            className="confirm-dialog__input"
            value={inputValue}
            placeholder={promptPlaceholder}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleConfirm();
            }}
          />
        ) : null}
        {requireMatch ? (
          <p className="confirm-dialog__hint">请输入 <strong>{requireMatch}</strong> 以确认</p>
        ) : null}
        <div className="confirm-dialog__actions">
          <button type="button" className="confirm-dialog__btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-dialog__btn ${danger ? 'confirm-dialog__btn--danger' : 'confirm-dialog__btn--primary'}`}
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
