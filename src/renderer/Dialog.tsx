import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const requestClose = () => {
    if (closing) return;
    if (dialog.current?.querySelector('fieldset:disabled')) return;
    setClosing(true);
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
    timer.current = window.setTimeout(() => {
      dialog.current?.close();
      close();
    }, delay);
  };
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      dialog.current?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal native-dialog"
      data-closing={closing}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) requestClose();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="关闭对话框" onClick={requestClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
